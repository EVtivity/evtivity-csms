// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An ISO 15118 EV for Plug and Charge: an OEM PKI (root and provisioning
// certificate, CN = PCID) on secp256r1 for ISO 15118-2 or secp521r1 for
// ISO 15118-20, signed EXI CertificateInstallationReq and CertificateUpdateReq
// messages, the checks an EV makes on the CertificateInstallationRes (response
// code, CPS signature, contract certificate, and the encrypted private key),
// and the iso15118CertificateHashData of an installed contract. The simulator
// uses it for its Plug and Charge actions; the OCTT contract certificate tests
// (TC_M_01, TC_M_02, TC_M_100) use it as the Test System's EV.

// @peculiar/x509 resolves its algorithm providers through tsyringe.
import 'reflect-metadata';
import crypto, { webcrypto, type KeyObject } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import {
  decodeMessage,
  decryptContractKeyIso2,
  decryptContractKeyIso20,
  encodeSigned,
  iso20Aad,
  ISO2_NAMESPACE,
  ISO20_NAMESPACE,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  verifySignature,
  type Iso2CertificateRes,
  type Iso20CertificateInstallationRes,
} from '@evtivity/v2g-exi';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export { ISO2_NAMESPACE, ISO20_NAMESPACE };

export type Edition = 2 | 20;

const ALGORITHMS: Record<Edition, EcKeyGenParams & { hash: string }> = {
  2: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
  20: { name: 'ECDSA', namedCurve: 'P-521', hash: 'SHA-512' },
};

const PCID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A random 18 character PCID (letters and digits) starting with `prefix`. */
export function randomPcid(prefix = 'OCTT'): string {
  let pcid = prefix;
  while (pcid.length < 18) pcid += PCID_ALPHABET.charAt(crypto.randomInt(PCID_ALPHABET.length));
  return pcid;
}

async function toKeyObject(key: CryptoKey): Promise<KeyObject> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key));
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** An EV with an OEM provisioning certificate. */
export class TestEv {
  private constructor(
    readonly edition: Edition,
    readonly pcid: string,
    readonly oemRoot: x509.X509Certificate,
    readonly oemLeaf: x509.X509Certificate,
    readonly oemKey: KeyObject,
  ) {}

  static async create(
    edition: Edition,
    pcid = randomPcid(),
    organization = 'OCTT',
  ): Promise<TestEv> {
    const alg = ALGORITHMS[edition];
    const rootKeys = (await webcrypto.subtle.generateKey(alg, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const leafKeys = (await webcrypto.subtle.generateKey(alg, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const now = Date.now();
    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto
        .randomBytes(8)
        .toString('hex')
        .replace(/^[89a-f]/, '1'),
      name: `CN=${organization} OEM Root ${pcid.slice(-6)},O=${organization}`,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 2 * 86_400_000),
      signingAlgorithm: alg,
      keys: rootKeys,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign),
      ],
    });
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: crypto
        .randomBytes(8)
        .toString('hex')
        .replace(/^[89a-f]/, '1'),
      subject: `CN=${pcid},O=${organization}`,
      issuer: root.subject,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 2 * 86_400_000),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
        ),
      ],
    });
    return new TestEv(edition, pcid, root, leaf, await toKeyObject(leafKeys.privateKey));
  }

  get namespace(): string {
    return this.edition === 2 ? ISO2_NAMESPACE : ISO20_NAMESPACE;
  }

  /** Signed CertificateInstallationReq, base64 (the OCPP exiRequest). */
  installationRequest(
    options: { maximumContractCertificateChains?: number; prioritizedEmaids?: string[] } = {},
  ): string {
    const rootCertificateIds = [{ issuerName: 'CN=EVtivity V2G Root', serialNumber: '01' }];
    if (this.edition === 2) {
      return encodeSigned(
        {
          schema: 2,
          sessionId: crypto.randomBytes(8).toString('hex'),
          body: {
            type: 'CertificateInstallationReq',
            id: 'id1',
            oemProvisioningCert: Buffer.from(this.oemLeaf.rawData),
            rootCertificateIds,
          },
        },
        ['id1'],
        ISO2_SIGNATURE,
        this.oemKey,
      ).exi.toString('base64');
    }
    return encodeSigned(
      {
        schema: 20,
        sessionId: crypto.randomBytes(8).toString('hex'),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        body: {
          type: 'CertificateInstallationReq',
          oemProvisioningChain: {
            id: 'id1',
            certificate: Buffer.from(this.oemLeaf.rawData),
            subCertificates: [],
          },
          rootCertificateIds,
          maximumContractCertificateChains: options.maximumContractCertificateChains ?? 1,
          prioritizedEmaids: options.prioritizedEmaids ?? [],
        },
      },
      ['id1'],
      ISO20_SIGNATURE,
      this.oemKey,
    ).exi.toString('base64');
  }
}

/** A contract the EV installed: its certificate chain and decrypted private key. */
export interface InstalledContract {
  emaid: string;
  certificate: Buffer;
  subCertificates: Buffer[];
  privateKey: KeyObject;
}

/** ISO 15118-2 CertificateUpdateReq for an installed contract, signed with its key, base64. */
export function updateRequest(contract: InstalledContract): string {
  return encodeSigned(
    {
      schema: 2,
      sessionId: crypto.randomBytes(8).toString('hex'),
      body: {
        type: 'CertificateUpdateReq',
        id: 'id1',
        contractChain: {
          id: 'id2',
          certificate: contract.certificate,
          subCertificates: contract.subCertificates,
        },
        emaid: contract.emaid,
        rootCertificateIds: [{ issuerName: 'CN=EVtivity V2G Root', serialNumber: '01' }],
      },
    },
    ['id1'],
    ISO2_SIGNATURE,
    contract.privateKey,
  ).exi.toString('base64');
}

export type ResponseCheck =
  | { ok: true; contract: InstalledContract; remaining: number | null }
  | { ok: false; reason: string };

function keyMatches(privateKey: KeyObject, certificate: Buffer, hash: string): boolean {
  const data = Buffer.from('octt');
  const signature = crypto.sign(hash, data, privateKey);
  return crypto.verify(hash, data, new crypto.X509Certificate(certificate).publicKey, signature);
}

/**
 * What the EV checks on an ISO 15118-2 CertificateInstallationRes or
 * CertificateUpdateRes: decodes, response code OK, the CPS signature over the
 * four signed elements, and that the decrypted private key belongs to the
 * contract certificate. `recipientKey` is the OEM provisioning key on
 * installation and the current contract key on update.
 */
export function checkIso2Response(
  exiResponse: string,
  expectedType: 'CertificateInstallationRes' | 'CertificateUpdateRes',
  recipientKey: KeyObject,
): ResponseCheck {
  let body: Iso2CertificateRes;
  let message: ReturnType<typeof decodeMessage>;
  try {
    message = decodeMessage(2, Buffer.from(exiResponse, 'base64'));
    body = message.body as Iso2CertificateRes;
  } catch (err) {
    return { ok: false, reason: `EXI does not decode: ${(err as Error).message}` };
  }
  if (body.type !== expectedType) return { ok: false, reason: `Message is ${body.type}` };
  if (body.responseCode !== 0)
    return { ok: false, reason: `ResponseCode ${String(body.responseCode)}` };
  const cps = new crypto.X509Certificate(body.saProvisioningChain.certificate);
  const ids = [
    body.contractChain.id ?? '',
    body.encryptedPrivateKey.id,
    body.dhPublicKey.id,
    body.emaid.id,
  ];
  const signature = verifySignature(message, ids, ISO2_SIGNATURE, cps.publicKey);
  if (!signature.valid) return { ok: false, reason: `CPS signature ${signature.reason}` };
  let privateKey: KeyObject;
  try {
    privateKey = decryptContractKeyIso2(
      recipientKey,
      body.dhPublicKey.value,
      body.encryptedPrivateKey.value,
    );
  } catch (err) {
    return { ok: false, reason: `Private key does not decrypt: ${(err as Error).message}` };
  }
  if (!keyMatches(privateKey, body.contractChain.certificate, 'sha256')) {
    return { ok: false, reason: 'Decrypted key does not match the contract certificate' };
  }
  return {
    ok: true,
    remaining: null,
    contract: {
      emaid: body.emaid.value,
      certificate: body.contractChain.certificate,
      subCertificates: body.contractChain.subCertificates,
      privateKey,
    },
  };
}

/** The same checks for an ISO 15118-20 CertificateInstallationRes (SECP521). */
export function checkIso20Response(exiResponse: string, ev: TestEv): ResponseCheck {
  let message: ReturnType<typeof decodeMessage>;
  try {
    message = decodeMessage(20, Buffer.from(exiResponse, 'base64'));
  } catch (err) {
    return { ok: false, reason: `EXI does not decode: ${(err as Error).message}` };
  }
  if (message.body.type !== 'CertificateInstallationRes' || !('cpsChain' in message.body)) {
    return { ok: false, reason: `Message is ${message.body.type}` };
  }
  const body: Iso20CertificateInstallationRes = message.body;
  if (body.responseCode !== 0)
    return { ok: false, reason: `ResponseCode ${String(body.responseCode)}` };
  const data = body.signedInstallationData;
  const cps = new crypto.X509Certificate(body.cpsChain.certificate);
  const signature = verifySignature(message, [data.id], ISO20_SIGNATURE, cps.publicKey);
  if (!signature.valid) return { ok: false, reason: `CPS signature ${signature.reason}` };
  if (data.encryptedPrivateKey?.kind !== 'SECP521') {
    return { ok: false, reason: 'No SECP521_EncryptedPrivateKey' };
  }
  const contractCert = new x509.X509Certificate(new Uint8Array(data.contractChain.certificate));
  const ski = contractCert.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId ?? '';
  let privateKey: KeyObject;
  try {
    privateKey = decryptContractKeyIso20(
      ev.oemKey,
      data.dhPublicKey,
      data.encryptedPrivateKey.value,
      iso20Aad(ev.pcid, ski),
    );
  } catch (err) {
    return { ok: false, reason: `Private key does not decrypt: ${(err as Error).message}` };
  }
  if (!keyMatches(privateKey, data.contractChain.certificate, 'sha512')) {
    return { ok: false, reason: 'Decrypted key does not match the contract certificate' };
  }
  const cn = contractCert.subjectName.getField('CN')[0] ?? '';
  return {
    ok: true,
    remaining: body.remainingContractCertificateChains,
    contract: {
      emaid: cn,
      certificate: data.contractChain.certificate,
      subCertificates: data.contractChain.subCertificates,
      privateKey,
    },
  };
}

/** OCPP 2.1 OCSPRequestDataType (AuthorizeRequest iso15118CertificateHashData). */
export interface OcspRequestData {
  hashAlgorithm: 'SHA256';
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
  responderURL: string;
}

const id_pe_authorityInfoAccess = '1.3.6.1.5.5.7.1.1';

function sha256Hex(data: ArrayBuffer): string {
  return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function sameName(a: Certificate, b: Certificate): boolean {
  return Buffer.from(AsnConvert.serialize(a.tbsCertificate.issuer)).equals(
    Buffer.from(AsnConvert.serialize(b.tbsCertificate.subject)),
  );
}

/** The OCSP responder of a certificate (Authority Information Access), or ''. */
function ocspResponderUrl(der: Buffer): string {
  const aia = new x509.X509Certificate(new Uint8Array(der)).getExtension(id_pe_authorityInfoAccess);
  if (aia == null) return '';
  const ocsp = new x509.AuthorityInfoAccessExtension(aia.rawData).ocsp;
  const uri = ocsp.find((name) => name.type === 'url');
  return uri?.value ?? '';
}

/**
 * The iso15118CertificateHashData a station sends with the eMAID of an installed contract
 * (C07): one SHA256 CertID per certificate of the contract chain whose issuer is in the
 * chain (the contract certificate and the sub-CAs below the MO root). Serial numbers are
 * hexadecimal without leading zeros. The responder URL is the certificate's AIA OCSP URL,
 * '' when it has none (the CSMS answers its own local contract certificates without OCSP).
 */
export function contractCertificateHashData(contract: InstalledContract): OcspRequestData[] {
  const chain = [contract.certificate, ...contract.subCertificates];
  const parsed = chain.map((der) => AsnConvert.parse(der, Certificate));
  const entries: OcspRequestData[] = [];
  parsed.forEach((cert, index) => {
    const issuer = parsed.find((candidate) => sameName(cert, candidate));
    if (issuer == null || issuer === cert) return;
    const serial = Buffer.from(cert.tbsCertificate.serialNumber)
      .toString('hex')
      .replace(/^0+(?=.)/, '')
      .toUpperCase();
    entries.push({
      hashAlgorithm: 'SHA256',
      issuerNameHash: sha256Hex(AsnConvert.serialize(issuer.tbsCertificate.subject)),
      issuerKeyHash: sha256Hex(issuer.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey),
      serialNumber: serial,
      responderURL: ocspResponderUrl(chain[index] as Buffer),
    });
  });
  return entries.slice(0, 4);
}
