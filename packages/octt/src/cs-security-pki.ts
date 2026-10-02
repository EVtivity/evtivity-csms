// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Test System's certificate authority for the OCPP 1.6 security CS tests
// (OCTT 1.6 section 2.25): root certificates for InstallCertificate, signed
// charge point certificates for CertificateSigned, TLS server certificates,
// and firmware signing. Certificate hash data is computed here, independently
// of the station, as the OCTT does ("based on its own calculation").

// @peculiar/x509 resolves its algorithm providers through tsyringe.
import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const EC_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512';

export interface CertificateHashData {
  hashAlgorithm: HashAlgorithm;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

export interface TestCertificate {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
  /** PEM of the certificate alone. */
  pem: string;
  /** PKCS#8 PEM of the private key. */
  keyPem: string;
  issuer: TestCertificate | null;
}

export interface IssueOptions {
  subject: string;
  issuer: TestCertificate | null;
  ca?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  /** Subject alternative names: DNS names and IP addresses. */
  dnsNames?: string[];
  ipAddresses?: string[];
  /** Use this public key instead of a new key pair (the certificate then has no usable private key). */
  publicKey?: CryptoKey;
  extendedKeyUsages?: string[];
}

function randomSerial(): string {
  // 16 random octets, high bit cleared so the INTEGER is positive.
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

async function privateKeyPem(keys: CryptoKeyPair): Promise<string> {
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
}

export async function issueCertificate(opts: IssueOptions): Promise<TestCertificate> {
  const keys = (await webcrypto.subtle.generateKey(EC_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = opts.publicKey ?? keys.publicKey;
  const ca = opts.ca ?? false;
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(ca, undefined, true),
    new x509.KeyUsagesExtension(
      ca
        ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign
        : x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
      true,
    ),
    await x509.SubjectKeyIdentifierExtension.create(publicKey),
  ];
  if (opts.extendedKeyUsages != null) {
    extensions.push(new x509.ExtendedKeyUsageExtension(opts.extendedKeyUsages));
  }
  const altNames: x509.JsonGeneralName[] = [
    ...(opts.dnsNames ?? []).map((value) => ({ type: 'dns' as const, value })),
    ...(opts.ipAddresses ?? []).map((value) => ({ type: 'ip' as const, value })),
  ];
  if (altNames.length > 0) extensions.push(new x509.SubjectAlternativeNameExtension(altNames));

  const notBefore = opts.notBefore ?? new Date(Date.now() - DAY_MS);
  const notAfter = opts.notAfter ?? new Date(Date.now() + 365 * DAY_MS);
  const cert =
    opts.issuer == null
      ? await x509.X509CertificateGenerator.createSelfSigned({
          serialNumber: randomSerial(),
          name: opts.subject,
          notBefore,
          notAfter,
          keys,
          signingAlgorithm: EC_ALGORITHM,
          extensions,
        })
      : await x509.X509CertificateGenerator.create({
          serialNumber: randomSerial(),
          subject: opts.subject,
          issuer: opts.issuer.cert.subject,
          notBefore,
          notAfter,
          publicKey,
          signingKey: opts.issuer.keys.privateKey,
          signingAlgorithm: EC_ALGORITHM,
          extensions,
        });
  return {
    cert,
    keys,
    pem: cert.toString('pem'),
    keyPem: await privateKeyPem(keys),
    issuer: opts.issuer,
  };
}

export function createRootCertificate(commonName: string): Promise<TestCertificate> {
  return issueCertificate({ subject: `CN=${commonName},O=OCTT,C=US`, issuer: null, ca: true });
}

/**
 * The invalid server certificates of OCTT 1.6 TC_078 and 2.1 TC_A_05, for a
 * station that trusts `root` and connects to localhost: expired, not yet valid,
 * issued by an unknown root, a CommonName other than the host, and a wildcard
 * CommonName.
 */
export async function invalidServerCertificates(
  root: TestCertificate,
): Promise<Array<{ name: string; cert: TestCertificate }>> {
  const day = 24 * 60 * 60 * 1000;
  const otherRoot = await createRootCertificate('OCTT Unknown Root CA');
  const localhost = { subject: 'CN=localhost,O=OCTT,C=US', dnsNames: ['localhost'] };
  return [
    {
      name: 'Expired',
      cert: await issueCertificate({
        ...localhost,
        issuer: root,
        notBefore: new Date(Date.now() - 10 * day),
        notAfter: new Date(Date.now() - day),
      }),
    },
    {
      name: 'Future validity date',
      cert: await issueCertificate({
        ...localhost,
        issuer: root,
        notBefore: new Date(Date.now() + day),
        notAfter: new Date(Date.now() + 365 * day),
      }),
    },
    {
      name: 'Not signed by installed Central System Root certificate',
      cert: await issueCertificate({ ...localhost, issuer: otherRoot }),
    },
    {
      name: 'CommonName that does not equal the FQDN of the server',
      cert: await issueCertificate({ subject: 'CN=octt-other-host.example,O=OCTT', issuer: root }),
    },
    {
      name: 'CommonName containing a wildcard hostname matching the FQDN',
      cert: await issueCertificate({ subject: 'CN=*.localhost,O=OCTT', issuer: root }),
    },
  ];
}

/** Signs a PKCS#10 CSR as the Certificate Authority Server: leaf PEM followed by the issuer chain. */
export async function signCertificateRequest(
  csrPem: string,
  issuer: TestCertificate,
): Promise<{ chainPem: string; leaf: x509.X509Certificate; subject: string }> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const ok = await csr.verify();
  if (!ok) throw new Error('CSR signature is not valid');
  const publicKey = await csr.publicKey.export(EC_ALGORITHM, ['verify']);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: csr.subject,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - DAY_MS),
    notAfter: new Date(Date.now() + 365 * DAY_MS),
    publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: EC_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
    ],
  });
  return { chainPem: leaf.toString('pem'), leaf, subject: csr.subject };
}

function hashHex(algorithm: HashAlgorithm, data: ArrayBuffer): string {
  const name = { SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' }[algorithm];
  return crypto.createHash(name).update(new Uint8Array(data)).digest('hex');
}

/** CertificateHashDataType of `cert` issued by `issuer` (a root is its own issuer). */
export function certificateHashDataOf(
  cert: x509.X509Certificate,
  issuer: x509.X509Certificate,
  hashAlgorithm: HashAlgorithm = 'SHA256',
): CertificateHashData {
  const tbs = AsnConvert.parse(cert.rawData, Certificate).tbsCertificate;
  const issuerTbs = AsnConvert.parse(issuer.rawData, Certificate).tbsCertificate;
  const serial = cert.serialNumber.toLowerCase().replace(/^0+/, '');
  return {
    hashAlgorithm,
    issuerNameHash: hashHex(hashAlgorithm, AsnConvert.serialize(tbs.issuer)),
    issuerKeyHash: hashHex(hashAlgorithm, issuerTbs.subjectPublicKeyInfo.subjectPublicKey),
    serialNumber: serial === '' ? '0' : serial,
  };
}

/** True when two CertificateHashData entries name the same certificate. */
export function sameHashData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const text = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
  const serial = (v: unknown): string => text(v).replace(/^0+/, '') || '0';
  return (
    a['hashAlgorithm'] === b['hashAlgorithm'] &&
    text(a['issuerNameHash']) === text(b['issuerNameHash']) &&
    text(a['issuerKeyHash']) === text(b['issuerKeyHash']) &&
    serial(a['serialNumber']) === serial(b['serialNumber'])
  );
}

/** Base64 DER ECDSA SHA-256 signature over `data` with the certificate's private key. */
export function signData(data: Buffer, signer: TestCertificate): string {
  return crypto.sign('sha256', data, crypto.createPrivateKey(signer.keyPem)).toString('base64');
}
