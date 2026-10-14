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
import { tryParseJson } from '@evtivity/lib';
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
  /**
   * CPO Sub-CA 1 and 2 under the V2G root: Sub-CA 2 (key kept) signs the
   * charging station V2G (SECC) certificates. Absent in a CA created before
   * v0.1.46 until the operator adds them.
   */
  cpoSubCa1?: CaEntry;
  cpoSubCa2?: CaEntry;
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
  const cpo = await createCpoSubCas(profile, cpsRoot);
  return {
    ...cpo,
    moRoot: await entry(moRoot, true),
    moSubCa1: await entry(moSubCa1, false),
    moSubCa2: await entry(moSubCa2, true),
    cpsRoot: await entry(cpsRoot, true),
    cpsSubCa1: await entry(cpsSubCa1, false),
    cpsSubCa2: await entry(cpsSubCa2, false),
    cpsLeaf: await entry(cpsLeaf, true),
  };
}

/** CPO Sub-CA 1 and 2 under the hierarchy's V2G root (ISO 15118-2 Annex F CPO chain). */
async function createCpoSubCas(
  profile: Profile,
  v2gRoot: Issued,
): Promise<{ cpoSubCa1: CaEntry; cpoSubCa2: CaEntry }> {
  const s = profile.suffix;
  const cpoSubCa1 = await issueCa(
    profile,
    `CN=EVtivity CPO Sub-CA 1${s},O=EVtivity`,
    v2gRoot,
    1,
    20,
    CA_USAGE,
    true,
  );
  const cpoSubCa2 = await issueCa(
    profile,
    `CN=EVtivity CPO Sub-CA 2${s},O=EVtivity`,
    cpoSubCa1,
    0,
    10,
    CA_USAGE,
    true,
  );
  return { cpoSubCa1: await entry(cpoSubCa1, false), cpoSubCa2: await entry(cpoSubCa2, true) };
}

/** A stored CA entry with its key as an issuer. */
async function issuerOf(profile: Profile, ca: CaEntry): Promise<Issued> {
  if (ca.key == null) throw new Error('The CA entry has no private key');
  const cert = new x509.X509Certificate(ca.cert);
  const privateKey = crypto
    .createPrivateKey(ca.key)
    .toCryptoKey({ name: 'ECDSA', namedCurve: profile.curve }, false, [
      'sign',
    ]) as unknown as CryptoKey;
  const publicKey = await cert.publicKey.export({ name: 'ECDSA', namedCurve: profile.curve }, [
    'verify',
  ]);
  return { cert, keys: { privateKey, publicKey }, keyId: await keyId(profile, publicKey) };
}

/** Whether both hierarchies have the CPO Sub-CAs that sign station V2G certificates. */
export function hasCpoSubCas(ca: LocalContractCa): boolean {
  return ca.iso2.cpoSubCa2?.key != null && ca.iso20.cpoSubCa2?.key != null;
}

/**
 * Adds the CPO Sub-CAs to a CA created without them (under the kept V2G root
 * keys). Returns the CA unchanged when it already has them.
 */
export async function addCpoSubCas(ca: LocalContractCa): Promise<LocalContractCa> {
  if (hasCpoSubCas(ca)) return ca;
  const out: LocalContractCa = { ...ca };
  for (const schema of [2, 20] as const) {
    const key = schema === 2 ? 'iso2' : 'iso20';
    const profile = PROFILES[schema];
    const root = await issuerOf(profile, ca[key].cpsRoot);
    out[key] = { ...ca[key], ...(await createCpoSubCas(profile, root)) };
  }
  return out;
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

const CPO_ROLES = ['cpoSubCa1', 'cpoSubCa2'] as const;

/** Parses a stored bundle; null when it is not a version 1 bundle. */
export function parseLocalContractCa(json: string): LocalContractCa | null {
  const value = tryParseJson(json);
  if (value == null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1 || typeof v['createdAt'] !== 'string') return null;
  for (const schema of ['iso2', 'iso20'] as const) {
    const h = v[schema] as Record<string, unknown> | undefined;
    if (h == null || ROLES.some((role) => !isEntry(h[role]))) return null;
    if (h['moSubCa2'] == null || (h['moSubCa2'] as CaEntry).key == null) return null;
    if (h['cpsLeaf'] == null || (h['cpsLeaf'] as CaEntry).key == null) return null;
    for (const role of CPO_ROLES) {
      if (h[role] !== undefined && !isEntry(h[role])) return null;
    }
  }
  return value as LocalContractCa;
}

export function hierarchyFor(ca: LocalContractCa, schema: ContractSchema): LocalCaHierarchy {
  return schema === 2 ? ca.iso2 : ca.iso20;
}

/** Public view of the CA: subject, serial and validity of every certificate. */
export function describeLocalContractCa(ca: LocalContractCa): Array<{
  schema: ContractSchema;
  role: (typeof ROLES)[number] | (typeof CPO_ROLES)[number];
  subject: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  certificate: string;
}> {
  const out = [];
  for (const schema of [2, 20] as const) {
    const h = hierarchyFor(ca, schema);
    for (const role of [...ROLES, ...CPO_ROLES]) {
      const pem = h[role]?.cert;
      if (pem == null) continue;
      const cert = new crypto.X509Certificate(pem);
      out.push({
        schema,
        role,
        subject: cert.subject.replace(/\n/g, ', '),
        serialNumber: cert.serialNumber.toLowerCase(),
        validFrom: new Date(cert.validFrom).toISOString(),
        validTo: new Date(cert.validTo).toISOString(),
        // Public certificate (PEM), for example the V2G root to install on stations.
        certificate: pem,
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

export interface IssuedSeccCertificate {
  /** PEM chain from the leaf: leaf, CPO Sub-CA 2, CPO Sub-CA 1. */
  certificateChain: string;
  serialNumber: string;
}

/**
 * Signs a charging station V2G (SECC) certificate request with the CPO Sub-CA
 * 2 of the hierarchy: the CSR subject and public key, one year or until the
 * Sub-CA expires, digitalSignature and keyAgreement. Throws when the CSR does
 * not verify or the hierarchy has no CPO Sub-CA.
 */
export async function issueSeccCertificate(
  hierarchy: LocalCaHierarchy,
  schema: ContractSchema,
  csrPem: string,
): Promise<IssuedSeccCertificate> {
  const profile = PROFILES[schema];
  if (hierarchy.cpoSubCa1 == null || hierarchy.cpoSubCa2?.key == null) {
    throw new Error('Local contract CA has no CPO Sub-CA');
  }
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  if (!(await csr.verify())) throw new Error('CSR signature does not verify');
  const issuer = await issuerOf(profile, hierarchy.cpoSubCa2);
  const notBefore = new Date(Date.now() - 60_000);
  let notAfter = new Date(notBefore.getTime() + YEAR_MS);
  if (notAfter > issuer.cert.notAfter) notAfter = issuer.cert.notAfter;
  const subjectKey = await csr.publicKey.export();
  const serialNumber = randomSerial();
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: csr.subject,
    issuer: issuer.cert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: algorithm(profile),
    publicKey: subjectKey,
    signingKey: issuer.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
        true,
      ),
      new x509.SubjectKeyIdentifierExtension(await keyId(profile, subjectKey)),
      new x509.AuthorityKeyIdentifierExtension(issuer.keyId),
    ],
  });
  return {
    certificateChain: [leaf.toString('pem'), hierarchy.cpoSubCa2.cert, hierarchy.cpoSubCa1.cert]
      .map((pem) => pem.trim())
      .join('\n'),
    serialNumber: normalizeSerialHex(serialNumber),
  };
}

/** DER of a PEM certificate. */
export function pemToDer(pem: string): Buffer {
  return Buffer.from(new crypto.X509Certificate(pem).raw);
}
