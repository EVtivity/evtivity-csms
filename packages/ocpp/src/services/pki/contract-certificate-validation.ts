// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPP 2.1 C07 (Authorization using Contract Certificates): the CSMS checks
// the validity of the contract certificate chain via real-time OCSP
// (C07.FR.05) and reports the outcome in AuthorizeResponse.certificateStatus
// (C07.FR.13 to C07.FR.17).

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  AuthorityInfoAccessSyntax,
  BasicConstraints,
  type Certificate,
  id_ad_ocsp,
  id_ce_basicConstraints,
  id_pe_authorityInfoAccess,
} from '@peculiar/asn1-x509';
import { db, pkiCaCertificates } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import type { AuthorizationStatusEnum } from '../../generated/v2_1/enums/AuthorizationStatusEnum.js';
import type { OCSPRequestDataType } from '../../generated/v2_1/types/common/OCSPRequestDataType.js';
import { getPkiProvider } from './provider-factory.js';
import type { OcspRequestData } from './pki-provider.js';
import {
  canIssueCertificates,
  certIdFor,
  isIssuerOf,
  ocspResponseCerts,
  parseCertificate,
  verifyOcspResponse,
} from './ocsp.js';
import {
  getLocalMoCertificates,
  isLocalContractToken,
  localCertificateStatus,
  type LocalMoCertificates,
} from './local-contract-status.js';
import { sameEmaid } from './emaid.js';

/** The certificateStatus values this validation produces. */
export type ContractCertificateVerdict =
  | 'Accepted'
  | 'CertificateRevoked'
  | 'CertificateExpired'
  | 'CertChainError';

// Contract certificates chain to a V2G root or a Mobility Operator root.
const CONTRACT_ROOT_TYPES = ['V2GRootCertificate', 'MORootCertificate'];

const CA_CACHE_TTL_MS = 60_000;

interface CaCache {
  issuers: Certificate[];
  roots: Certificate[];
  loadedAt: number;
}

let caCache: CaCache | null = null;

/** Drop the cached CA certificates (tests, or after a CA certificate change). */
export function clearContractValidationCaCache(): void {
  caCache = null;
}

function parseAll(pems: string[], logger: Logger): Certificate[] {
  const certs: Certificate[] = [];
  for (const pem of pems) {
    try {
      certs.push(parseCertificate(pem));
    } catch (err) {
      logger.warn({ err }, 'Skipping a stored CA certificate that does not parse');
    }
  }
  return certs;
}

/** Active operator CA certificates (60 s cache): every type as OCSP issuers, roots as anchors. */
async function loadCaCertificates(logger: Logger): Promise<CaCache> {
  if (caCache != null && Date.now() - caCache.loadedAt < CA_CACHE_TTL_MS) return caCache;
  const rows = await db
    .select({
      certificate: pkiCaCertificates.certificate,
      certificateType: pkiCaCertificates.certificateType,
    })
    .from(pkiCaCertificates)
    .where(eq(pkiCaCertificates.status, 'active'));
  caCache = {
    issuers: parseAll(
      rows.map((r) => r.certificate),
      logger,
    ),
    roots: parseAll(
      rows.filter((r) => CONTRACT_ROOT_TYPES.includes(r.certificateType)).map((r) => r.certificate),
      logger,
    ),
    loadedAt: Date.now(),
  };
  return caCache;
}

/**
 * The CA certificates an OCSP or CRL answer about a contract or vehicle
 * certificate is verified against: the active operator CA certificates and
 * the local MO CAs.
 */
export async function knownCertificateIssuers(logger: Logger): Promise<Certificate[]> {
  const operatorCas = await loadCaCertificates(logger);
  const local = await getLocalMoCertificates();
  return [...operatorCas.issuers, ...(local?.all ?? [])];
}

/** Splits a PEM bundle into its certificates, in order. */
function splitPemChain(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function signedBy(cert: Certificate, issuer: Certificate): boolean {
  if (
    !Buffer.from(AsnConvert.serialize(cert.tbsCertificate.issuer)).equals(
      Buffer.from(AsnConvert.serialize(issuer.tbsCertificate.subject)),
    )
  ) {
    return false;
  }
  try {
    const certDer = Buffer.from(AsnConvert.serialize(cert));
    const issuerDer = Buffer.from(AsnConvert.serialize(issuer));
    return new crypto.X509Certificate(certDer).verify(
      new crypto.X509Certificate(issuerDer).publicKey,
    );
  } catch {
    // fail-open: a signature that cannot be checked counts as not signed, so the chain is refused
    return false;
  }
}

// ISO 15118 contract chains: the leaf, MO Sub-CA 2, MO Sub-CA 1 and the root.
const MAX_CONTRACT_CHAIN_LENGTH = 4;
// X.520 commonName.
const ID_AT_COMMON_NAME = '2.5.4.3';

function basicConstraintsOf(cert: Certificate): BasicConstraints | null {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_basicConstraints);
  return ext == null ? null : AsnConvert.parse(ext.extnValue, BasicConstraints);
}

function isCa(cert: Certificate): boolean {
  return basicConstraintsOf(cert)?.cA === true;
}

function commonNameOf(cert: Certificate): string | null {
  for (const rdn of cert.tbsCertificate.subject) {
    for (const atv of rdn) {
      if (atv.type === ID_AT_COMMON_NAME) return atv.value.toString();
    }
  }
  return null;
}

/**
 * The path from the leaf to the trust anchor follows RFC 5280 6.1.4: the
 * leaf is no CA, every certificate above it may issue certificates.
 */
function isValidCaPath(path: Certificate[]): boolean {
  const [leaf, ...issuers] = path;
  if (leaf == null || isCa(leaf)) return false;
  return issuers.every((cert, i) => canIssueCertificates(cert, i));
}

function isExpired(cert: Certificate, now: number): boolean {
  const { notBefore, notAfter } = cert.tbsCertificate.validity;
  return now < notBefore.getTime().getTime() || now > notAfter.getTime().getTime();
}

function ocspResponderUrl(cert: Certificate): string | null {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_pe_authorityInfoAccess);
  if (ext == null) return null;
  const aia = AsnConvert.parse(ext.extnValue, AuthorityInfoAccessSyntax);
  const ocsp = aia.find(
    (d) => d.accessMethod === id_ad_ocsp && d.accessLocation.uniformResourceIdentifier != null,
  );
  return ocsp?.accessLocation.uniformResourceIdentifier ?? null;
}

/**
 * Checks each certificate through the PKI provider's OCSP request and
 * verifies the responses. Any revoked certificate makes the chain revoked;
 * an unreachable responder, an unverifiable response, or an `unknown` status
 * means the chain cannot be verified.
 */
async function checkRevocation(
  entries: OcspRequestData[],
  knownIssuers: Certificate[],
  logger: Logger,
  expectedToken?: string,
): Promise<ContractCertificateVerdict> {
  if (entries.length === 0) return 'CertChainError';
  const provider = await getPkiProvider();
  type Fetched =
    | { kind: 'status'; status: 'good' | 'revoked' | 'unknown' | 'expired' | 'error' }
    | { kind: 'response'; der: Buffer; entry: OcspRequestData };
  const fetched = await Promise.all(
    entries.map(async (entry): Promise<Fetched> => {
      // Certificates of the local contract CA: status from the CSMS records.
      const local = await localCertificateStatus(entry, expectedToken);
      if (local === 'mismatch') {
        logger.warn(
          { serialNumber: entry.serialNumber },
          'Contract certificate belongs to another contract than the idToken',
        );
        return { kind: 'status', status: 'error' };
      }
      if (local != null) return { kind: 'status', status: local };
      if (entry.responderURL === '') return { kind: 'status', status: 'error' };
      const result = await provider.getOcspStatus(entry);
      if (result.status !== 'Accepted') {
        logger.warn(
          {
            serialNumber: entry.serialNumber,
            responderURL: entry.responderURL,
            reason: result.reason,
          },
          'Contract certificate OCSP status request failed',
        );
        return { kind: 'status', status: 'error' };
      }
      return { kind: 'response', der: Buffer.from(result.ocspResult, 'base64'), entry };
    }),
  );
  // The CA certificates every response of this chain carries: one response's
  // issuer may chain to a known CA through a CA another response carried
  // (each level's responder names its own issuer). They are intermediates
  // only, never trust anchors.
  const carried = fetched.flatMap((f) => (f.kind === 'response' ? ocspResponseCerts(f.der) : []));
  const statuses = fetched.map((f) => {
    if (f.kind === 'status') return f.status;
    try {
      return verifyOcspResponse(f.der, f.entry, knownIssuers, Date.now(), carried);
    } catch (err) {
      logger.warn(
        { err, serialNumber: f.entry.serialNumber, responderURL: f.entry.responderURL },
        'Contract certificate OCSP response could not be verified',
      );
      return 'error' as const;
    }
  });
  if (statuses.includes('revoked')) return 'CertificateRevoked';
  // C07.FR.15: a contract certificate of the local CA past its validity.
  if (statuses.includes('expired')) return 'CertificateExpired';
  if (statuses.every((s) => s === 'good')) return 'Accepted';
  return 'CertChainError';
}

/**
 * Validates the contract certificate chain an AuthorizeRequest carries:
 * either the station's iso15118CertificateHashData (the station validated the
 * chain locally, the CSMS checks revocation) or the PEM `certificate` chain
 * (C07.FR.06, the CSMS validates the chain against its V2G and MO roots, the
 * validity period, and revocation).
 */
export async function validateContractCertificate(
  input: {
    iso15118CertificateHashData?: OCSPRequestDataType[];
    certificate?: string;
    /** The idToken being authorized: an eMAID must be the one the contract certificate names. */
    idToken?: { idToken: string; type: string };
  },
  logger: Logger,
): Promise<ContractCertificateVerdict> {
  const operatorCas = await loadCaCertificates(logger);
  const local = await getLocalMoCertificates();
  const cas = {
    issuers: [...operatorCas.issuers, ...(local?.all ?? [])],
    roots: [...operatorCas.roots, ...(local?.roots ?? [])],
  };

  if (input.iso15118CertificateHashData != null && input.iso15118CertificateHashData.length > 0) {
    // The CSMS cannot read the leaf of hash data: a local contract certificate
    // must belong to the contract of the idToken (checked in the local records).
    const problem = await hashDataBindingProblem(
      input.iso15118CertificateHashData,
      input.idToken?.idToken ?? '',
      local,
    );
    if (problem != null) {
      logger.warn({ problem }, 'Contract certificate hash data is not bound to the idToken');
      return 'CertChainError';
    }
    return bindToTokenType(
      await checkRevocation(
        input.iso15118CertificateHashData,
        cas.issuers,
        logger,
        input.idToken?.idToken ?? '',
      ),
      input.idToken,
      logger,
    );
  }

  if (input.certificate == null) return 'CertChainError';
  let chain: Certificate[];
  try {
    chain = splitPemChain(input.certificate).map((pem) => parseCertificate(pem));
  } catch (err) {
    logger.warn({ err }, 'Contract certificate chain does not parse');
    return 'CertChainError';
  }
  const leaf = chain[0];
  const top = chain[chain.length - 1];
  if (leaf == null || top == null) return 'CertChainError';
  if (chain.length > MAX_CONTRACT_CHAIN_LENGTH) return 'CertChainError';
  // The leaf is the contract certificate, never a CA (a root or sub-CA alone
  // is no contract).
  if (isCa(leaf)) return 'CertChainError';
  // C07: the contract certificate names the eMAID it authorizes (CN = eMAID).
  if (input.idToken?.type === 'eMAID') {
    const cn = commonNameOf(leaf);
    if (cn == null || !sameEmaid(cn, input.idToken.idToken)) {
      logger.warn({ commonName: cn }, 'Contract certificate CN is not the eMAID being authorized');
      return 'CertChainError';
    }
  }

  const now = Date.now();
  if (chain.some((c) => isExpired(c, now))) return 'CertificateExpired';

  // Leaf up to (excluding) the root, each signed by the next; the last one by
  // an operator-configured V2G or MO root.
  for (let i = 0; i + 1 < chain.length; i++) {
    const cert = chain[i];
    const issuer = chain[i + 1];
    if (cert == null || issuer == null || !signedBy(cert, issuer)) return 'CertChainError';
  }
  const root = cas.roots.find((r) => signedBy(top, r));
  if (root == null) return 'CertChainError';
  if (isExpired(root, now)) return 'CertificateExpired';
  // A chain may end with the root itself; the path ends at the root once.
  const topIsRoot = Buffer.from(AsnConvert.serialize(top)).equals(
    Buffer.from(AsnConvert.serialize(root)),
  );
  const path = topIsRoot ? chain : [...chain, root];
  if (path.length > MAX_CONTRACT_CHAIN_LENGTH || !isValidCaPath(path)) return 'CertChainError';

  const entries: OcspRequestData[] = [];
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    const issuer = i + 1 < chain.length ? chain[i + 1] : root;
    if (cert == null || issuer == null) return 'CertChainError';
    const certId = certIdFor(cert, issuer, 'SHA256');
    if (!isIssuerOf(issuer, certId)) return 'CertChainError';
    // A certificate without an OCSP responder URL can only be checked when
    // the local contract CA issued it (checkRevocation fails it otherwise).
    entries.push({ ...certId, responderURL: ocspResponderUrl(cert) ?? '' });
  }
  return bindToTokenType(
    await checkRevocation(entries, [...chain, root], logger),
    input.idToken,
    logger,
  );
}

/**
 * A contract certificate names an eMAID (C07), so it is never accepted for
 * an idToken of another type: the reply would say the certificate was
 * accepted for a token it does not name. A revoked or expired chain keeps its
 * verdict.
 */
function bindToTokenType(
  verdict: ContractCertificateVerdict,
  idToken: { idToken: string; type: string } | undefined,
  logger: Logger,
): ContractCertificateVerdict {
  if (verdict !== 'Accepted' || idToken === undefined || idToken.type === 'eMAID') return verdict;
  logger.warn(
    { idTokenType: idToken.type },
    'Contract certificate for an idToken that is no eMAID',
  );
  return 'CertChainError';
}

function issuesLocally(issuers: Certificate[], entry: OCSPRequestDataType): boolean {
  try {
    return issuers.some((issuer) => isIssuerOf(issuer, entry));
  } catch {
    // fail-open: an unsupported hash algorithm names no local issuer; the
    // OCSP check of that entry then fails the chain.
    return false;
  }
}

/**
 * Why hash data cannot stand for the idToken's contract certificate, or null.
 * The CSMS sees only CertIDs, so:
 * - at least one entry must name an end-entity certificate: a certificate of
 *   a local MO Sub-CA 2, or one a non-local CA issued (the CSMS cannot tell a
 *   foreign leaf from a foreign sub-CA). A list of local sub-CAs only reads
 *   good for every entry and names no contract at all;
 * - an idToken of a local contract (`pnc_contracts`) must come with a local
 *   contract certificate, which the local records bind to that contract. A
 *   foreign leaf would otherwise authorize a local driver's eMAID.
 * A non-local token with non-local hash data cannot be bound (no CN).
 */
async function hashDataBindingProblem(
  entries: OCSPRequestDataType[],
  idToken: string,
  local: LocalMoCertificates | null,
): Promise<string | null> {
  const contractIssuers = local?.contractIssuers ?? [];
  const localCas = local?.all ?? [];
  const localLeaf = entries.some((e) => issuesLocally(contractIssuers, e));
  const foreign = entries.some((e) => !issuesLocally(localCas, e));
  if (!localLeaf && !foreign) return 'no_end_entity_entry';
  if (!localLeaf && idToken !== '' && (await isLocalContractToken(idToken))) {
    return 'local_contract_without_local_certificate';
  }
  return null;
}

const REJECTED_TOKEN_STATUSES = new Set<AuthorizationStatusEnum>([
  'Blocked',
  'Expired',
  'Invalid',
  'Unknown',
]);

/**
 * Combines the idToken authorization status with the contract certificate
 * verdict (C07.FR.13 to C07.FR.17).
 */
export function applyContractCertificateVerdict(
  tokenStatus: AuthorizationStatusEnum,
  verdict: ContractCertificateVerdict,
): {
  status: AuthorizationStatusEnum;
  certificateStatus: ContractCertificateVerdict | 'ContractCancelled';
} {
  switch (verdict) {
    case 'Accepted':
      // FR.13: valid chain but the eMAID is not accepted. FR.14: both valid.
      return REJECTED_TOKEN_STATUSES.has(tokenStatus)
        ? { status: tokenStatus, certificateStatus: 'ContractCancelled' }
        : { status: tokenStatus, certificateStatus: 'Accepted' };
    case 'CertificateExpired':
      return { status: 'Expired', certificateStatus: 'CertificateExpired' };
    case 'CertificateRevoked':
      return { status: 'Invalid', certificateStatus: 'CertificateRevoked' };
    case 'CertChainError':
      return { status: 'Invalid', certificateStatus: 'CertChainError' };
  }
}
