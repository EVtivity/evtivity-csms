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
  type Certificate,
  id_ad_ocsp,
  id_pe_authorityInfoAccess,
} from '@peculiar/asn1-x509';
import { db, pkiCaCertificates } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import type { AuthorizationStatusEnum } from '../../generated/v2_1/enums/AuthorizationStatusEnum.js';
import type { OCSPRequestDataType } from '../../generated/v2_1/types/common/OCSPRequestDataType.js';
import { getPkiProvider } from './provider-factory.js';
import type { OcspRequestData } from './pki-provider.js';
import { certIdFor, parseCertificate, isIssuerOf, verifyOcspResponse } from './ocsp.js';
import { getLocalMoCertificates, localCertificateStatus } from './local-contract-status.js';

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
): Promise<ContractCertificateVerdict> {
  if (entries.length === 0) return 'CertChainError';
  const provider = await getPkiProvider();
  const statuses = await Promise.all(
    entries.map(async (entry) => {
      // Certificates of the local contract CA: status from the CSMS records.
      const local = await localCertificateStatus(entry);
      if (local != null) return local;
      if (entry.responderURL === '') return 'error' as const;
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
        return 'error' as const;
      }
      try {
        return verifyOcspResponse(Buffer.from(result.ocspResult, 'base64'), entry, knownIssuers);
      } catch (err) {
        logger.warn(
          { err, serialNumber: entry.serialNumber, responderURL: entry.responderURL },
          'Contract certificate OCSP response could not be verified',
        );
        return 'error' as const;
      }
    }),
  );
  if (statuses.includes('revoked')) return 'CertificateRevoked';
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
  input: { iso15118CertificateHashData?: OCSPRequestDataType[]; certificate?: string },
  logger: Logger,
): Promise<ContractCertificateVerdict> {
  const operatorCas = await loadCaCertificates(logger);
  const local = await getLocalMoCertificates();
  const cas = {
    issuers: [...operatorCas.issuers, ...(local?.all ?? [])],
    roots: [...operatorCas.roots, ...(local?.roots ?? [])],
  };

  if (input.iso15118CertificateHashData != null && input.iso15118CertificateHashData.length > 0) {
    return checkRevocation(input.iso15118CertificateHashData, cas.issuers, logger);
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
  return checkRevocation(entries, [...chain, root], logger);
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
