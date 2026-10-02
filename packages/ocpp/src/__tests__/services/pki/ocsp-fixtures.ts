// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Test PKI and OCSP response builder for the OCSP unit tests.

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { AlgorithmIdentifier, Certificate } from '@peculiar/asn1-x509';
import {
  BasicOCSPResponse,
  CertID,
  CertStatus,
  KeyHash,
  OCSPRequest,
  OCSPResponse,
  OCSPResponseStatus,
  ResponderID,
  ResponseBytes,
  ResponseData,
  RevokedInfo,
  SingleResponse,
  id_pkix_ocsp_basic,
} from '@peculiar/asn1-ocsp';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 60 * 60 * 1000;

export interface TestCert {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
  issuer: TestCert | null;
  pem: string;
  asn: Certificate;
}

export async function issueCert(
  subject: string,
  issuer: TestCert | null,
  opts: {
    ca?: boolean;
    ocspUrl?: string;
    ocspSigning?: boolean;
    notBefore?: Date;
    notAfter?: Date;
  } = {},
): Promise<TestCert> {
  const keys = (await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair;
  const extensions: x509.Extension[] = [new x509.BasicConstraintsExtension(opts.ca ?? false)];
  if (opts.ocspUrl != null) {
    extensions.push(new x509.AuthorityInfoAccessExtension({ ocsp: [opts.ocspUrl] }));
  }
  if (opts.ocspSigning === true) {
    extensions.push(new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.9']));
  }
  const base = {
    serialNumber: crypto
      .randomBytes(8)
      .toString('hex')
      .replace(/^[89a-f]/, '1'),
    notBefore: opts.notBefore ?? new Date(Date.now() - DAY),
    notAfter: opts.notAfter ?? new Date(Date.now() + 365 * DAY),
    signingAlgorithm: EC,
    extensions,
  };
  const cert =
    issuer == null
      ? await x509.X509CertificateGenerator.createSelfSigned({ ...base, name: subject, keys })
      : await x509.X509CertificateGenerator.create({
          ...base,
          subject,
          issuer: issuer.cert.subject,
          publicKey: keys.publicKey,
          signingKey: issuer.keys.privateKey,
        });
  return {
    cert,
    keys,
    issuer,
    pem: cert.toString('pem'),
    asn: AsnConvert.parse(cert.rawData, Certificate),
  };
}

function sha256Hex(data: ArrayBuffer): string {
  return crypto.createHash('sha256').update(new Uint8Array(data)).digest('hex');
}

/** OCPP OCSPRequestData (SHA256) for `cert`. */
export function requestDataFor(cert: TestCert, responderURL = 'https://ocsp.example.com/') {
  const issuer = cert.issuer;
  if (issuer == null) throw new Error('root has no request data');
  return {
    hashAlgorithm: 'SHA256' as const,
    issuerNameHash: sha256Hex(AsnConvert.serialize(issuer.asn.tbsCertificate.subject)),
    issuerKeyHash: sha256Hex(issuer.asn.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey),
    serialNumber: cert.cert.serialNumber.toLowerCase().replace(/^0+/, ''),
    responderURL,
  };
}

/** A signed DER OCSPResponse for the CertID in `requestDer`. */
export function buildResponse(
  requestDer: Buffer,
  opts: {
    status: 'good' | 'revoked' | 'unknown';
    signer: TestCert;
    includeCerts?: TestCert[];
    nextUpdate?: Date;
    tamper?: boolean;
  },
): Buffer {
  const request = AsnConvert.parse(requestDer, OCSPRequest);
  const certId = request.tbsRequest.requestList[0]?.reqCert ?? new CertID();
  const now = new Date();
  const certStatus =
    opts.status === 'good'
      ? new CertStatus({ good: null })
      : opts.status === 'revoked'
        ? new CertStatus({
            revoked: new RevokedInfo({ revocationTime: new Date(Date.now() - DAY) }),
          })
        : new CertStatus({ unknown: null });
  const signerKey = opts.signer.asn.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey;
  const tbs = new ResponseData({
    responderID: new ResponderID({
      byKey: new KeyHash(crypto.createHash('sha1').update(new Uint8Array(signerKey)).digest()),
    }),
    producedAt: now,
    responses: [
      new SingleResponse({
        certID: certId,
        certStatus,
        thisUpdate: now,
        nextUpdate: opts.nextUpdate ?? new Date(now.getTime() + 60 * 60 * 1000),
      }),
    ],
  });
  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const signature = crypto.sign(
    'sha256',
    tbsDer,
    crypto.KeyObject.from(opts.signer.keys.privateKey),
  );
  if (opts.tamper === true) {
    signature.writeUInt8((signature.at(-1) ?? 0) ^ 0xff, signature.length - 1);
  }
  const basic = new BasicOCSPResponse({
    tbsResponseData: tbs,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: '1.2.840.10045.4.3.2' }),
    signature: new Uint8Array(signature).buffer,
    ...(opts.includeCerts != null ? { certs: opts.includeCerts.map((c) => c.asn) } : {}),
  });
  return Buffer.from(
    AsnConvert.serialize(
      new OCSPResponse({
        responseStatus: OCSPResponseStatus.successful,
        responseBytes: new ResponseBytes({
          responseType: id_pkix_ocsp_basic,
          response: new OctetString(AsnConvert.serialize(basic)),
        }),
      }),
    ),
  );
}

export function errorResponse(status: OCSPResponseStatus): Buffer {
  return Buffer.from(AsnConvert.serialize(new OCSPResponse({ responseStatus: status })));
}
