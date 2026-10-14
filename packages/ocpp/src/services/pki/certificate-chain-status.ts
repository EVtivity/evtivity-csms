// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPP 2.1 M07 (Get Vehicle Certificate Chain Revocation Status): the
// station asks the CSMS for the revocation status of each certificate of a
// vehicle chain, by OCSP (M07.FR.01 to FR.03) or by CRL (M07.FR.04 to FR.07).
// Certificates the local contract CA issued are answered from its records.
// A status that cannot be retrieved is Failed (M07 error handling).

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { AsnConvert } from '@peculiar/asn1-schema';
import type { Certificate } from '@peculiar/asn1-x509';
import { blockedDestinationOf, safeFetch, type Logger } from '@evtivity/lib';
import { getOcspAllowedPrivateHosts } from '@evtivity/database';
import {
  fetchOcspResponse,
  isIssuerOf,
  isOcspResponderAllowed,
  normalizeSerialHex,
  OCSP_TIMEOUT_MS,
  verifyOcspResponse,
  type OcspCertId,
  type OcspCertStatus,
} from './ocsp.js';
import { localCertificateStatus } from './local-contract-status.js';
import { knownCertificateIssuers } from './contract-certificate-validation.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export type CertificateStatusSource = 'OCSP' | 'CRL';
export type CertificateChainStatus = 'Good' | 'Revoked' | 'Unknown' | 'Failed';

export interface CertificateStatusRequestInfo {
  source: CertificateStatusSource;
  urls: string[];
  certificateHashData: OcspCertId;
}

export interface CertificateStatusEntry {
  source: CertificateStatusSource;
  status: CertificateChainStatus;
  nextUpdate: string;
  certificateHashData: OcspCertId;
}

/** How long a status may be cached when the source names no next update. */
const DEFAULT_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** ISO 15118-20 lets a status be cached for at most one week. */
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CRL_BYTES = 10 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const STATUS: Record<OcspCertStatus, CertificateChainStatus> = {
  good: 'Good',
  revoked: 'Revoked',
  unknown: 'Unknown',
};

class CrlError extends Error {}

function nextUpdateOf(candidate: Date | undefined, now: number): string {
  const latest = now + MAX_VALIDITY_MS;
  const at = candidate?.getTime() ?? now + DEFAULT_VALIDITY_MS;
  return new Date(Math.min(Math.max(at, now), latest)).toISOString();
}

/** Downloads a CRL through the SSRF guard of the OCSP requests. */
async function downloadCrl(url: string, allowedPrivateHosts: string[]): Promise<Buffer> {
  if (!isOcspResponderAllowed(url, allowedPrivateHosts)) {
    throw new CrlError(
      'CRL URL is not http(s) or is a private address not in pnc.ocsp.allowedPrivateHosts',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, OCSP_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await safeFetch(url, {
        allowedPrivateHosts,
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      const blocked = blockedDestinationOf(err);
      throw new CrlError(
        blocked != null
          ? `CRL host ${blocked.host} resolves to private address ${blocked.address}`
          : `CRL download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) throw new CrlError(`CRL server returned HTTP ${String(response.status)}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_CRL_BYTES) {
      throw new CrlError(`CRL has an invalid size (${String(body.length)} bytes)`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The status of a certificate on a CRL: the CRL must be signed by the issuer
 * the hash data names and be current. Throws CrlError otherwise.
 */
export async function statusFromCrl(
  body: Buffer,
  certId: OcspCertId,
  issuers: Certificate[],
  now: number = Date.now(),
): Promise<{ status: CertificateChainStatus; nextUpdate: Date | undefined }> {
  let crl: x509.X509Crl;
  try {
    const text = body.toString('latin1');
    crl = new x509.X509Crl(text.includes('-----BEGIN X509 CRL-----') ? text : new Uint8Array(body));
  } catch (err) {
    throw new CrlError(`CRL does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  const issuer = issuers.find((c) => isIssuerOf(c, certId));
  if (issuer == null) throw new CrlError('Issuer of the certificate is unknown');
  const issuerCert = new x509.X509Certificate(AsnConvert.serialize(issuer));
  if (crl.issuer !== issuerCert.subject) throw new CrlError('CRL is not issued by the issuer');
  if (!(await crl.verify({ publicKey: issuerCert }))) {
    throw new CrlError('CRL signature is invalid');
  }
  // RFC 5280 5.1.2.5: a conforming CRL carries nextUpdate. Without it the
  // revoked list cannot be read reliably, so the CRL is refused.
  if (crl.nextUpdate == null) throw new CrlError('CRL has no nextUpdate');
  if (crl.thisUpdate.getTime() > now + CLOCK_SKEW_MS) {
    throw new CrlError('CRL thisUpdate is in the future');
  }
  if (crl.nextUpdate.getTime() < now - CLOCK_SKEW_MS) {
    throw new CrlError('CRL is stale (nextUpdate has passed)');
  }
  const serial = normalizeSerialHex(certId.serialNumber);
  const revoked = crl.entries.some((e) => normalizeSerialHex(e.serialNumber) === serial);
  return { status: revoked ? 'Revoked' : 'Good', nextUpdate: crl.nextUpdate };
}

async function viaOcsp(
  request: CertificateStatusRequestInfo,
  issuers: Certificate[],
  logger: Logger,
): Promise<CertificateChainStatus> {
  for (const url of request.urls) {
    try {
      const der = await fetchOcspResponse({ ...request.certificateHashData, responderURL: url });
      return STATUS[verifyOcspResponse(der, request.certificateHashData, issuers)];
    } catch (err) {
      // The station names the responder: recoverable, try the next URL (P9).
      logger.warn(
        { responderURL: url, err: err instanceof Error ? err.message : String(err) },
        'Certificate chain status: OCSP request failed',
      );
    }
  }
  return 'Failed';
}

async function viaCrl(
  request: CertificateStatusRequestInfo,
  issuers: Certificate[],
  logger: Logger,
  now: number,
): Promise<{ status: CertificateChainStatus; nextUpdate: Date | undefined }> {
  const allowedPrivateHosts = await getOcspAllowedPrivateHosts();
  for (const url of request.urls) {
    try {
      const body = await downloadCrl(url, allowedPrivateHosts);
      return await statusFromCrl(body, request.certificateHashData, issuers, now);
    } catch (err) {
      logger.warn(
        { crlURL: url, err: err instanceof Error ? err.message : String(err) },
        'Certificate chain status: CRL check failed',
      );
    }
  }
  return { status: 'Failed', nextUpdate: undefined };
}

/** M07: one status per requested certificate, in the request order. */
export async function getCertificateChainStatus(
  requests: CertificateStatusRequestInfo[],
  logger: Logger,
): Promise<CertificateStatusEntry[]> {
  const now = Date.now();
  let issuers: Certificate[] | null = null;
  const loadIssuers = async (): Promise<Certificate[]> =>
    (issuers ??= await knownCertificateIssuers(logger));

  return Promise.all(
    requests.map(async (request): Promise<CertificateStatusEntry> => {
      const base = { source: request.source, certificateHashData: request.certificateHashData };
      try {
        const local = await localCertificateStatus(request.certificateHashData);
        if (local != null) {
          // An expired certificate has no revocation status to report.
          const status = local === 'expired' ? 'Unknown' : STATUS[local];
          return { ...base, status, nextUpdate: nextUpdateOf(undefined, now) };
        }
        if (request.source === 'OCSP') {
          const status = await viaOcsp(request, await loadIssuers(), logger);
          return { ...base, status, nextUpdate: nextUpdateOf(undefined, now) };
        }
        const crl = await viaCrl(request, await loadIssuers(), logger, now);
        return { ...base, status: crl.status, nextUpdate: nextUpdateOf(crl.nextUpdate, now) };
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Certificate chain status could not be retrieved',
        );
        return { ...base, status: 'Failed', nextUpdate: nextUpdateOf(undefined, now) };
      }
    }),
  );
}
