// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Test System's PKI and OCSP service (OCTT test procedures): a V2G chain
// (V2G root, two CPO SubCAs) and an MO chain (MO root, two MO SubCAs) issued
// at run start, contract certificates issued per test, and an HTTP OCSP
// responder (IETF RFC 6960) that answers for every certificate it issued.
// Certificates carry the responder URL in their AIA extension, so the CSMS
// sends its OCSP requests here.

// @peculiar/x509 resolves its algorithm providers through tsyringe.
import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import http from 'node:http';
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

const EC_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const ECDSA_SHA256_OID = '1.2.840.10045.4.3.2';
const DAY_MS = 24 * 60 * 60 * 1000;

/** OCPP OCSPRequestDataType. */
export interface OcspRequestData {
  hashAlgorithm: 'SHA256';
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
  responderURL: string;
}

export interface TestCertificate {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
  issuer: TestCertificate | null;
}

/** An OCSP request the responder received. */
export interface ReceivedOcspRequest {
  serialNumber: string;
  issuerKeyHash: string;
  status: 'good' | 'revoked' | 'unknown';
}

function normalizeSerial(hex: string): string {
  const stripped = hex.toLowerCase().replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function sha256Hex(data: ArrayBuffer | Uint8Array): string {
  return crypto.createHash('sha256').update(new Uint8Array(data)).digest('hex');
}

function asn1Cert(cert: x509.X509Certificate): Certificate {
  return AsnConvert.parse(cert.rawData, Certificate);
}

function keyHashHex(cert: x509.X509Certificate): string {
  return sha256Hex(asn1Cert(cert).tbsCertificate.subjectPublicKeyInfo.subjectPublicKey);
}

function nameHashHex(cert: x509.X509Certificate): string {
  return sha256Hex(AsnConvert.serialize(asn1Cert(cert).tbsCertificate.subject));
}

function randomSerial(): string {
  // 16 random octets, high bit cleared so the INTEGER is positive.
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

export class OcttTestPki {
  readonly v2gRoot: TestCertificate;
  readonly cpoSubCa1: TestCertificate;
  readonly cpoSubCa2: TestCertificate;
  readonly moRoot: TestCertificate;
  readonly moSubCa1: TestCertificate;
  readonly moSubCa2: TestCertificate;
  private readonly revoked = new Set<string>();
  private readonly issued = new Map<string, TestCertificate>();

  private constructor(
    readonly responderUrl: string,
    cas: {
      v2gRoot: TestCertificate;
      cpoSubCa1: TestCertificate;
      cpoSubCa2: TestCertificate;
      moRoot: TestCertificate;
      moSubCa1: TestCertificate;
      moSubCa2: TestCertificate;
    },
  ) {
    this.v2gRoot = cas.v2gRoot;
    this.cpoSubCa1 = cas.cpoSubCa1;
    this.cpoSubCa2 = cas.cpoSubCa2;
    this.moRoot = cas.moRoot;
    this.moSubCa1 = cas.moSubCa1;
    this.moSubCa2 = cas.moSubCa2;
    for (const ca of Object.values(cas)) this.register(ca);
  }

  static async create(responderUrl: string): Promise<OcttTestPki> {
    const v2gRoot = await issue(
      'CN=OCTT V2G Root CA,O=OCTT,C=US',
      null,
      { ca: true },
      responderUrl,
    );
    const cpoSubCa1 = await issue(
      'CN=OCTT CPO Sub-CA 1,O=OCTT,C=US',
      v2gRoot,
      { ca: true },
      responderUrl,
    );
    const cpoSubCa2 = await issue(
      'CN=OCTT CPO Sub-CA 2,O=OCTT,C=US',
      cpoSubCa1,
      { ca: true },
      responderUrl,
    );
    const moRoot = await issue('CN=OCTT MO Root CA,O=OCTT,C=US', null, { ca: true }, responderUrl);
    const moSubCa1 = await issue(
      'CN=OCTT MO Sub-CA 1,O=OCTT,C=US',
      moRoot,
      { ca: true },
      responderUrl,
    );
    const moSubCa2 = await issue(
      'CN=OCTT MO Sub-CA 2,O=OCTT,C=US',
      moSubCa1,
      { ca: true },
      responderUrl,
    );
    return new OcttTestPki(responderUrl, {
      v2gRoot,
      cpoSubCa1,
      cpoSubCa2,
      moRoot,
      moSubCa1,
      moSubCa2,
    });
  }

  /** Contract certificate (CN = eMAID) issued by MO Sub-CA 2. */
  async issueContractCertificate(emaid: string): Promise<TestCertificate> {
    const cert = await issue(
      `CN=${emaid},O=OCTT,C=US`,
      this.moSubCa2,
      { ca: false },
      this.responderUrl,
    );
    this.register(cert);
    return cert;
  }

  revoke(cert: TestCertificate): void {
    this.revoked.add(this.key(cert));
  }

  /** OCSPRequestData for a certificate this PKI issued (SHA256 hashes). */
  requestDataFor(cert: TestCertificate): OcspRequestData {
    if (cert.issuer == null) throw new Error('A root certificate has no OCSP request data');
    return {
      hashAlgorithm: 'SHA256',
      issuerNameHash: nameHashHex(cert.issuer.cert),
      issuerKeyHash: keyHashHex(cert.issuer.cert),
      serialNumber: normalizeSerial(cert.cert.serialNumber),
      responderURL: this.responderUrl,
    };
  }

  /** iso15118CertificateHashData for a contract certificate: leaf and both MO SubCAs. */
  contractHashData(contract: TestCertificate): OcspRequestData[] {
    return [contract, this.moSubCa2, this.moSubCa1].map((c) => this.requestDataFor(c));
  }

  /** Status of the certificate a CertID names, or null when the issuer is not ours. */
  statusOf(
    issuerKeyHash: string,
    serialNumber: string,
  ): { status: 'good' | 'revoked' | 'unknown'; issuer: TestCertificate } | null {
    const issuer = [...this.issued.values()].find(
      (c) => keyHashHex(c.cert) === issuerKeyHash.toLowerCase(),
    );
    if (issuer == null) return null;
    const subject = this.issued.get(
      `${issuerKeyHash.toLowerCase()}:${normalizeSerial(serialNumber)}`,
    );
    if (subject == null) return { status: 'unknown', issuer };
    return { status: this.revoked.has(this.key(subject)) ? 'revoked' : 'good', issuer };
  }

  private key(cert: TestCertificate): string {
    if (cert.issuer == null) return `root:${normalizeSerial(cert.cert.serialNumber)}`;
    return `${keyHashHex(cert.issuer.cert)}:${normalizeSerial(cert.cert.serialNumber)}`;
  }

  private register(cert: TestCertificate): void {
    this.issued.set(this.key(cert), cert);
  }
}

async function issue(
  subject: string,
  issuer: TestCertificate | null,
  opts: { ca: boolean },
  responderUrl: string,
): Promise<TestCertificate> {
  const keys = (await webcrypto.subtle.generateKey(EC_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const notBefore = new Date(Date.now() - DAY_MS);
  const notAfter = new Date(Date.now() + 365 * DAY_MS);
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(opts.ca, undefined, true),
    new x509.KeyUsagesExtension(
      opts.ca
        ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign
        : x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
      true,
    ),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
  if (issuer != null) {
    extensions.push(new x509.AuthorityInfoAccessExtension({ ocsp: [responderUrl] }));
  }
  const serialNumber = randomSerial();
  const cert =
    issuer == null
      ? await x509.X509CertificateGenerator.createSelfSigned({
          serialNumber,
          name: subject,
          notBefore,
          notAfter,
          keys,
          signingAlgorithm: EC_ALGORITHM,
          extensions,
        })
      : await x509.X509CertificateGenerator.create({
          serialNumber,
          subject,
          issuer: issuer.cert.subject,
          notBefore,
          notAfter,
          publicKey: keys.publicKey,
          signingKey: issuer.keys.privateKey,
          signingAlgorithm: EC_ALGORITHM,
          extensions,
        });
  return { cert, keys, issuer };
}

function ocspError(status: OCSPResponseStatus): Buffer {
  return Buffer.from(AsnConvert.serialize(new OCSPResponse({ responseStatus: status })));
}

function signedResponse(
  certId: CertID,
  status: 'good' | 'revoked' | 'unknown',
  issuer: TestCertificate,
): Buffer {
  const now = new Date();
  const certStatus =
    status === 'good'
      ? new CertStatus({ good: null })
      : status === 'revoked'
        ? new CertStatus({
            revoked: new RevokedInfo({ revocationTime: new Date(Date.now() - DAY_MS) }),
          })
        : new CertStatus({ unknown: null });
  const issuerAsn = asn1Cert(issuer.cert);
  const tbs = new ResponseData({
    // The issuing CA answers for its own certificates (RFC 6960 4.2.2.2).
    responderID: new ResponderID({
      byKey: new KeyHash(
        crypto
          .createHash('sha1')
          .update(new Uint8Array(issuerAsn.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey))
          .digest(),
      ),
    }),
    producedAt: now,
    responses: [
      new SingleResponse({
        certID: certId,
        certStatus,
        thisUpdate: now,
        nextUpdate: new Date(now.getTime() + 60 * 60 * 1000),
      }),
    ],
  });
  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const privateKey = crypto.KeyObject.from(issuer.keys.privateKey);
  const signature = crypto.sign('sha256', tbsDer, privateKey);
  const basic = new BasicOCSPResponse({
    tbsResponseData: tbs,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: ECDSA_SHA256_OID }),
    signature: new Uint8Array(signature).buffer,
    // The issuer certificate lets a client without it verify the signature.
    certs: [issuerAsn],
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

/** Answers one DER OCSPRequest (a single CertID, SHA-256 hashes). */
export function answerOcspRequest(
  pki: OcttTestPki,
  requestDer: Buffer,
): { response: Buffer; received: ReceivedOcspRequest | null } {
  let request: OCSPRequest;
  try {
    request = AsnConvert.parse(requestDer, OCSPRequest);
  } catch {
    return { response: ocspError(OCSPResponseStatus.malformedRequest), received: null };
  }
  const single = request.tbsRequest.requestList[0];
  if (request.tbsRequest.requestList.length !== 1 || single == null) {
    return { response: ocspError(OCSPResponseStatus.malformedRequest), received: null };
  }
  const certId = single.reqCert;
  if (certId.hashAlgorithm.algorithm !== SHA256_OID) {
    return { response: ocspError(OCSPResponseStatus.unauthorized), received: null };
  }
  const issuerKeyHash = Buffer.from(certId.issuerKeyHash.buffer).toString('hex');
  const serialNumber = normalizeSerial(Buffer.from(certId.serialNumber).toString('hex'));
  const found = pki.statusOf(issuerKeyHash, serialNumber);
  if (
    found == null ||
    nameHashHex(found.issuer.cert) !== Buffer.from(certId.issuerNameHash.buffer).toString('hex')
  ) {
    return { response: ocspError(OCSPResponseStatus.unauthorized), received: null };
  }
  return {
    response: signedResponse(certId, found.status, found.issuer),
    received: { serialNumber, issuerKeyHash, status: found.status },
  };
}

/** HTTP OCSP responder (RFC 6960 Appendix A.1, POST). */
export class OcspResponder {
  readonly received: ReceivedOcspRequest[] = [];
  private server: http.Server | null = null;

  constructor(private readonly pki: OcttTestPki) {}

  /** Listens on all interfaces at `port`, so the CSMS can reach it from another host. */
  async start(port: number): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const { response, received } = answerOcspRequest(this.pki, Buffer.concat(chunks));
        if (received != null) this.received.push(received);
        res.writeHead(200, { 'Content-Type': 'application/ocsp-response' }).end(response);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        resolve();
      });
    });
    this.server = server;
  }

  /** Requests received for a certificate serial number (lowercase hex, no leading zeroes). */
  requestsFor(serialNumber: string): ReceivedOcspRequest[] {
    const serial = normalizeSerial(serialNumber);
    return this.received.filter((r) => r.serialNumber === serial);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server == null) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

/** The Test System OCSP service a run provides when it has a responder URL. */
export interface OcspTestService {
  pki: OcttTestPki;
  responder: OcspResponder;
  /**
   * pki_ca_certificates ID of the MO root the runner installed in the CSMS
   * through the product API (TC_C_52 prerequisite), or null when it could not.
   */
  installedMoRootId: number | null;
}

/** Issues the test PKI and starts the responder on the port of `responderUrl`. */
export async function startOcspTestService(responderUrl: string): Promise<OcspTestService> {
  const url = new URL(responderUrl);
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const pki = await OcttTestPki.create(responderUrl);
  const responder = new OcspResponder(pki);
  await responder.start(port);
  return { pki, responder, installedMoRootId: null };
}

/** PEM chain from the contract certificate up to, excluding, the MO root (AuthorizeRequest.certificate). */
export function contractChainPem(pki: OcttTestPki, contract: TestCertificate): string {
  return [contract, pki.moSubCa2, pki.moSubCa1].map((c) => c.cert.toString('pem')).join('\n');
}

/**
 * Decodes a base64 DER OCSPResponse and returns the status it reports for
 * `cert`, after checking the signature with the issuer's public key. Used by
 * tests to validate what the CSMS relayed.
 */
export function readRelayedOcspStatus(
  ocspResultBase64: string,
  cert: TestCertificate,
): 'good' | 'revoked' | 'unknown' | 'invalid' {
  try {
    const response = AsnConvert.parse(Buffer.from(ocspResultBase64, 'base64'), OCSPResponse);
    if (response.responseStatus !== OCSPResponseStatus.successful) return 'invalid';
    if (response.responseBytes?.responseType !== id_pkix_ocsp_basic) return 'invalid';
    const basic = AsnConvert.parse(response.responseBytes.response.buffer, BasicOCSPResponse);
    const issuer = cert.issuer;
    if (issuer == null || basic.tbsResponseDataRaw == null) return 'invalid';
    const valid = crypto.verify(
      'sha256',
      Buffer.from(basic.tbsResponseDataRaw),
      crypto.KeyObject.from(issuer.keys.publicKey),
      Buffer.from(basic.signature),
    );
    if (!valid) return 'invalid';
    const serial = normalizeSerial(cert.cert.serialNumber);
    const single = basic.tbsResponseData.responses.find(
      (r) => normalizeSerial(Buffer.from(r.certID.serialNumber).toString('hex')) === serial,
    );
    if (single == null) return 'invalid';
    if (single.certStatus.revoked != null) return 'revoked';
    if (single.certStatus.good !== undefined) return 'good';
    return 'unknown';
  } catch {
    return 'invalid';
  }
}
