// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The local ISO 15118 contract CA (pnc.provider = 'local'). Two hierarchies,
// one per ISO 15118 edition:
//
//   ISO 15118-2:  ECDSA secp256r1 with SHA-256
//   ISO 15118-20: ECDSA secp521r1 with SHA-512 (8 byte key identifiers, so
//                 the AAD of the key transport is 16 hex characters)
//
// Each has a Mobility Operator chain (MO root, Sub-CA 1, Sub-CA 2, which
// signs contract certificates) and a certificate provisioning service chain
// (CPS root, Sub-CA 1, Sub-CA 2, CPS leaf, which signs CertificateInstallationRes).
// The bundle is stored encrypted in the setting pnc.local.caEnc. It keeps the
// keys that sign (MO Sub-CA 2, CPS leaf) and the root keys (to renew the
// sub-CAs later); the Sub-CA 1 and CPS Sub-CA keys are discarded.

// @peculiar/x509 resolves its algorithm providers through tsyringe.
import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { normalizeSerialHex } from './ocsp.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export type ContractSchema = 2 | 20;

export interface CaEntry {
  /** PEM certificate. */
  cert: string;
  /** PKCS#8 PEM private key, kept only for the keys the CA needs. */
  key?: string;
}

export interface LocalCaHierarchy {
  moRoot: CaEntry;
  moSubCa1: CaEntry;
  moSubCa2: CaEntry;
  cpsRoot: CaEntry;
  cpsSubCa1: CaEntry;
  cpsSubCa2: CaEntry;
  cpsLeaf: CaEntry;
}

export interface LocalContractCa {
  version: 1;
  createdAt: string;
  iso2: LocalCaHierarchy;
  iso20: LocalCaHierarchy;
}

interface Profile {
  curve: 'P-256' | 'P-521';
  hash: 'SHA-256' | 'SHA-512';
  /** Key identifier length in bytes (null: the SHA-1 key identifier). */
  keyIdBytes: number | null;
  suffix: string;
}

const PROFILES: Record<ContractSchema, Profile> = {
  2: { curve: 'P-256', hash: 'SHA-256', keyIdBytes: null, suffix: '' },
  20: { curve: 'P-521', hash: 'SHA-512', keyIdBytes: 8, suffix: ' 20' },
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const CA_USAGE = x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign;

/** 16 random octets with the high bit cleared, so the INTEGER is positive. */
function randomSerial(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

async function keyId(profile: Profile, publicKey: CryptoKey): Promise<string> {
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', publicKey));
  const hash = crypto.createHash(profile.keyIdBytes == null ? 'sha1' : 'sha256').update(spki);
  const digest = hash.digest();
  return digest.subarray(0, profile.keyIdBytes ?? digest.length).toString('hex');
}

interface Issued {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
  keyId: string;
}

function algorithm(profile: Profile): EcKeyGenParams & { hash: string } {
  return { name: 'ECDSA', namedCurve: profile.curve, hash: profile.hash };
}

async function issueCa(
  profile: Profile,
  subject: string,
  issuer: Issued | null,
  pathLength: number | undefined,
  validityYears: number,
  usage: number,
  ca: boolean,
): Promise<Issued> {
  const keys = (await webcrypto.subtle.generateKey(algorithm(profile), true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const id = await keyId(profile, keys.publicKey);
  const notBefore = new Date(Date.now() - 60_000);
  let notAfter = new Date(notBefore.getTime() + validityYears * YEAR_MS);
  if (issuer != null && notAfter > issuer.cert.notAfter) notAfter = issuer.cert.notAfter;
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(ca, ca ? pathLength : undefined, true),
    new x509.KeyUsagesExtension(usage, true),
    new x509.SubjectKeyIdentifierExtension(id),
  ];
  if (issuer != null) extensions.push(new x509.AuthorityKeyIdentifierExtension(issuer.keyId));
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject,
    issuer: issuer?.cert.subject ?? subject,
    notBefore,
    notAfter,
    signingAlgorithm: algorithm(profile),
    publicKey: keys.publicKey,
    signingKey: issuer?.keys.privateKey ?? keys.privateKey,
    extensions,
  });
  return { cert, keys, keyId: id };
}

async function exportKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key));
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({
    format: 'pem',
    type: 'pkcs8',
  });
}

async function entry(issued: Issued, keepKey: boolean): Promise<CaEntry> {
  const out: CaEntry = { cert: issued.cert.toString('pem') };
  if (keepKey) out.key = await exportKey(issued.keys.privateKey);
  return out;
}

async function createHierarchy(schema: ContractSchema): Promise<LocalCaHierarchy> {
  const profile = PROFILES[schema];
  const s = profile.suffix;
  // Names stay short: the ISO 15118-2 X509IssuerName holds 64 characters.
  const moRoot = await issueCa(
    profile,
    `CN=EVtivity MO Root${s},O=EVtivity`,
    null,
    undefined,
    40,
    CA_USAGE,
    true,
  );
  const moSubCa1 = await issueCa(
    profile,
    `CN=EVtivity MO Sub-CA 1${s},O=EVtivity`,
    moRoot,
    1,
    20,
    CA_USAGE,
    true,
  );
  const moSubCa2 = await issueCa(
    profile,
    `CN=EVtivity MO Sub-CA 2${s},O=EVtivity`,
    moSubCa1,
    0,
    10,
    CA_USAGE,
    true,
  );
  const cpsRoot = await issueCa(
    profile,
    `CN=EVtivity V2G Root${s},O=EVtivity`,
    null,
    undefined,
    40,
    CA_USAGE,
    true,
  );
  const cpsSubCa1 = await issueCa(
    profile,
    `CN=EVtivity CPS Sub-CA 1${s},O=EVtivity`,
    cpsRoot,
    1,
    20,
    CA_USAGE,
    true,
  );
  const cpsSubCa2 = await issueCa(
    profile,
    `CN=EVtivity CPS Sub-CA 2${s},O=EVtivity`,
    cpsSubCa1,
    0,
    10,
    CA_USAGE,
    true,
  );
  const cpsLeaf = await issueCa(
    profile,
    `CN=EVtivity CPS${s},O=EVtivity`,
    cpsSubCa2,
    undefined,
    5,
    x509.KeyUsageFlags.digitalSignature,
    false,
  );
  return {
    moRoot: await entry(moRoot, true),
    moSubCa1: await entry(moSubCa1, false),
    moSubCa2: await entry(moSubCa2, true),
    cpsRoot: await entry(cpsRoot, true),
    cpsSubCa1: await entry(cpsSubCa1, false),
    cpsSubCa2: await entry(cpsSubCa2, false),
    cpsLeaf: await entry(cpsLeaf, true),
  };
}

/** Generates a new local contract CA (both hierarchies). */
export async function createLocalContractCa(): Promise<LocalContractCa> {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    iso2: await createHierarchy(2),
    iso20: await createHierarchy(20),
  };
}

function isEntry(value: unknown): value is CaEntry {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['cert'] === 'string' && (v['key'] === undefined || typeof v['key'] === 'string');
}

const ROLES = [
  'moRoot',
  'moSubCa1',
  'moSubCa2',
  'cpsRoot',
  'cpsSubCa1',
  'cpsSubCa2',
  'cpsLeaf',
] as const;

/** Parses a stored bundle; null when it is not a version 1 bundle. */
export function parseLocalContractCa(json: string): LocalContractCa | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value == null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1 || typeof v['createdAt'] !== 'string') return null;
  for (const schema of ['iso2', 'iso20'] as const) {
    const h = v[schema] as Record<string, unknown> | undefined;
    if (h == null || ROLES.some((role) => !isEntry(h[role]))) return null;
    if (h['moSubCa2'] == null || (h['moSubCa2'] as CaEntry).key == null) return null;
    if (h['cpsLeaf'] == null || (h['cpsLeaf'] as CaEntry).key == null) return null;
  }
  return value as LocalContractCa;
}

export function hierarchyFor(ca: LocalContractCa, schema: ContractSchema): LocalCaHierarchy {
  return schema === 2 ? ca.iso2 : ca.iso20;
}

/** Public view of the CA: subject, serial and validity of every certificate. */
export function describeLocalContractCa(ca: LocalContractCa): Array<{
  schema: ContractSchema;
  role: (typeof ROLES)[number];
  subject: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
}> {
  const out = [];
  for (const schema of [2, 20] as const) {
    const h = hierarchyFor(ca, schema);
    for (const role of ROLES) {
      const cert = new crypto.X509Certificate(h[role].cert);
      out.push({
        schema,
        role,
        subject: cert.subject.replace(/\n/g, ', '),
        serialNumber: cert.serialNumber.toLowerCase(),
        validFrom: new Date(cert.validFrom).toISOString(),
        validTo: new Date(cert.validTo).toISOString(),
      });
    }
  }
  return out;
}

export interface IssuedContractCertificate {
  certificate: Buffer;
  serialNumber: string;
  validTo: Date;
  /** Subject key identifier, hex (the ISO 15118-20 AAD uses it). */
  keyId: string;
}

/**
 * Issues a contract certificate (CN = eMAID) for `publicKey` from the MO
 * Sub-CA 2 of the hierarchy. Valid for two years or until the Sub-CA
 * expires.
 */
export async function issueContractCertificate(
  hierarchy: LocalCaHierarchy,
  schema: ContractSchema,
  emaid: string,
  publicKey: crypto.KeyObject,
): Promise<IssuedContractCertificate> {
  const profile = PROFILES[schema];
  const issuerCert = new x509.X509Certificate(hierarchy.moSubCa2.cert);
  const issuerKeyPem = hierarchy.moSubCa2.key;
  if (issuerKeyPem == null) throw new Error('Local contract CA has no MO Sub-CA 2 key');
  const signingKey = crypto
    .createPrivateKey(issuerKeyPem)
    .toCryptoKey({ name: 'ECDSA', namedCurve: profile.curve }, false, [
      'sign',
    ]) as unknown as CryptoKey;
  const subjectKey = publicKey.toCryptoKey({ name: 'ECDSA', namedCurve: profile.curve }, true, [
    'verify',
  ]) as unknown as CryptoKey;
  const issuerSki = issuerCert.getExtension(x509.SubjectKeyIdentifierExtension);
  const id = await keyId(profile, subjectKey);
  const notBefore = new Date(Date.now() - 60_000);
  let notAfter = new Date(notBefore.getTime() + 2 * YEAR_MS);
  if (notAfter > issuerCert.notAfter) notAfter = issuerCert.notAfter;
  const serialNumber = randomSerial();
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.digitalSignature |
        x509.KeyUsageFlags.nonRepudiation |
        x509.KeyUsageFlags.keyAgreement,
      true,
    ),
    new x509.SubjectKeyIdentifierExtension(id),
  ];
  if (issuerSki != null) extensions.push(new x509.AuthorityKeyIdentifierExtension(issuerSki.keyId));
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: `CN=${emaid},O=EVtivity`,
    issuer: issuerCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: algorithm(profile),
    publicKey: subjectKey,
    signingKey,
    extensions,
  });
  return {
    certificate: Buffer.from(cert.rawData),
    serialNumber: normalizeSerialHex(serialNumber),
    validTo: notAfter,
    keyId: id,
  };
}

/** DER of a PEM certificate. */
export function pemToDer(pem: string): Buffer {
  return Buffer.from(new crypto.X509Certificate(pem).raw);
}
