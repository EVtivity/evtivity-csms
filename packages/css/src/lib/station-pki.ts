// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station's own certificate handling: certificate hash data (OCPP
// CertificateHashDataType), chain checks, key pair and CSR generation, and
// firmware signature checks. Used by the OCPP 1.6 Security Whitepaper flows.

// @peculiar/x509 resolves its algorithm providers through tsyringe.
import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export type CertificateHashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512';

export interface CertificateHashData {
  hashAlgorithm: CertificateHashAlgorithm;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

const NODE_HASH: Record<CertificateHashAlgorithm, string> = {
  SHA256: 'sha256',
  SHA384: 'sha384',
  SHA512: 'sha512',
};

// The base64 body holds no '-', so a match stops at the next dash and the scan
// stays linear on input with many BEGIN lines and no END line.
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;

export function isCertificateHashAlgorithm(value: unknown): value is CertificateHashAlgorithm {
  return value === 'SHA256' || value === 'SHA384' || value === 'SHA512';
}

/** Certificates in a PEM string, in order. Null when any of them does not parse. */
export function parseCertificateChain(pem: string): crypto.X509Certificate[] | null {
  const blocks = pem.match(PEM_CERTIFICATE);
  if (blocks == null) return null;
  try {
    return blocks.map((block) => new crypto.X509Certificate(block));
  } catch {
    return null;
  }
}

/** Hex serial number without leading zeroes (OCPP CertificateHashDataType.serialNumber). */
export function normalizeSerialNumber(hex: string): string {
  const stripped = hex.toLowerCase().replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function asn1(cert: crypto.X509Certificate): Certificate {
  return AsnConvert.parse(new Uint8Array(cert.raw), Certificate);
}

function hashHex(algorithm: CertificateHashAlgorithm, data: ArrayBuffer): string {
  return crypto.createHash(NODE_HASH[algorithm]).update(new Uint8Array(data)).digest('hex');
}

/**
 * Hash data of `cert` issued by `issuer` (OCPP CertificateHashDataType, as in an
 * OCSP CertID): issuerNameHash is the hash of the DER issuer name, issuerKeyHash
 * the hash of the issuer's public key bits. A root certificate is its own issuer.
 */
export function certificateHashData(
  cert: crypto.X509Certificate,
  issuer: crypto.X509Certificate,
  hashAlgorithm: CertificateHashAlgorithm = 'SHA256',
): CertificateHashData {
  const tbs = asn1(cert).tbsCertificate;
  return {
    hashAlgorithm,
    issuerNameHash: hashHex(hashAlgorithm, AsnConvert.serialize(tbs.issuer)),
    issuerKeyHash: hashHex(
      hashAlgorithm,
      asn1(issuer).tbsCertificate.subjectPublicKeyInfo.subjectPublicKey,
    ),
    serialNumber: normalizeSerialNumber(cert.serialNumber),
  };
}

export function sameCertificateHashData(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const text = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
  return (
    a['hashAlgorithm'] === b['hashAlgorithm'] &&
    text(a['issuerNameHash']) === text(b['issuerNameHash']) &&
    text(a['issuerKeyHash']) === text(b['issuerKeyHash']) &&
    normalizeSerialNumber(text(a['serialNumber'])) ===
      normalizeSerialNumber(text(b['serialNumber']))
  );
}

export function isSelfSigned(cert: crypto.X509Certificate): boolean {
  return cert.checkIssued(cert) && cert.verify(cert.publicKey);
}

export function isIssuedBy(cert: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
}

export function isWithinValidity(cert: crypto.X509Certificate, now: number = Date.now()): boolean {
  return new Date(cert.validFrom).getTime() <= now && now <= new Date(cert.validTo).getTime();
}

/**
 * True when the certificate may issue certificates: basicConstraints cA is true
 * and keyUsage includes keyCertSign (IETF RFC 5280 4.2.1.3 and 4.2.1.9).
 */
export function isCaCertificate(cert: crypto.X509Certificate): boolean {
  return caConstraints(cert).isCa;
}

function caConstraints(cert: crypto.X509Certificate): {
  isCa: boolean;
  pathLength: number | undefined;
} {
  const parsed = new x509.X509Certificate(new Uint8Array(cert.raw));
  const basic = parsed.getExtension(x509.BasicConstraintsExtension);
  const usage = parsed.getExtension(x509.KeyUsagesExtension);
  return {
    isCa:
      basic?.ca === true && usage != null && (usage.usages & x509.KeyUsageFlags.keyCertSign) !== 0,
    pathLength: basic?.pathLength,
  };
}

// A path from the leaf (index 0) to a trust anchor: every certificate is valid
// now, is signed by the next one, and every issuer is a CA whose pathLenConstraint
// allows the intermediate CA certificates below it.
function isValidPath(path: readonly crypto.X509Certificate[], now: number): boolean {
  for (let i = 0; i < path.length; i++) {
    const cert = path[i] as crypto.X509Certificate;
    if (!isWithinValidity(cert, now)) return false;
    if (i === 0) continue;
    const subject = path[i - 1] as crypto.X509Certificate;
    if (!isIssuedBy(subject, cert)) return false;
    const { isCa, pathLength } = caConstraints(cert);
    // i - 1 intermediate CA certificates lie between this issuer and the leaf.
    if (!isCa || (pathLength != null && i - 1 > pathLength)) return false;
  }
  return true;
}

/**
 * True when `chain` (leaf first) leads to one of the trusted roots: it either
 * ends with a trusted root or its last certificate is issued by one, and the
 * whole path passes isValidPath.
 */
export function chainsToTrustedRoot(
  chain: readonly crypto.X509Certificate[],
  trustedRoots: readonly crypto.X509Certificate[],
  now: number = Date.now(),
): boolean {
  const top = chain[chain.length - 1];
  if (top == null) return false;
  if (trustedRoots.some((root) => root.raw.equals(top.raw))) return isValidPath(chain, now);
  return trustedRoots.some((root) => isIssuedBy(top, root) && isValidPath([...chain, root], now));
}

export interface GeneratedKeyPairCsr {
  csrPem: string;
  privateKeyPem: string;
}

/** New EC P-256 key pair and a PKCS#10 certificate signing request for it. */
export async function generateKeyPairAndCsr(subject: {
  commonName: string;
  organizationName: string;
}): Promise<GeneratedKeyPairCsr> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = (await webcrypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const escape = (value: string): string => value.replace(/([,+"\\<>;=])/g, '\\$1');
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${escape(subject.commonName)},O=${escape(subject.organizationName)}`,
    keys,
    signingAlgorithm: algorithm,
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const privateKeyPem = crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  return { csrPem: csr.toString('pem'), privateKeyPem };
}

/** True when the certificate holds the public key of `privateKeyPem`. */
export function certificateMatchesPrivateKey(
  cert: crypto.X509Certificate,
  privateKeyPem: string,
): boolean {
  const certKey = cert.publicKey.export({ format: 'der', type: 'spki' });
  const ownKey = crypto
    .createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ format: 'der', type: 'spki' });
  return certKey.equals(ownKey);
}

/** Verifies a base64 signature (SHA-256, RSA PKCS#1 v1.5 or DER ECDSA) over `data`. */
export function verifySignature(
  data: Buffer,
  signatureBase64: string,
  cert: crypto.X509Certificate,
): boolean {
  try {
    return crypto.verify('sha256', data, cert.publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
