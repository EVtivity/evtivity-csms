// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { createLogger, isPrivateUrl } from '@evtivity/lib';
import type {
  PkiProvider,
  SignCsrResult,
  ContractCertResult,
  OcspRequestData,
  OcspResult,
} from './pki-provider.js';

const logger = createLogger('manual-pki-provider');

// OCSP responders can hang under load or attack. Without a timeout the
// OCPP handler thread that initiated GetCertificateStatus blocks
// indefinitely, the station's response promise rejects with a timeout,
// and the offending OCSP host can pin worker capacity.
const OCSP_TIMEOUT_MS = 15_000;

export class ManualProvider implements PkiProvider {
  // Reuse the shared connection pool from @evtivity/database instead of
  // spinning up a new postgres() connection per provider instance - the
  // provider factory caches by config hash with a 60s TTL and a fresh
  // connection would leak on every cache miss.
  async signCsr(csr: string, certificateType: string): Promise<SignCsrResult> {
    await client`
      INSERT INTO pki_csr_requests (csr, certificate_type, status)
      VALUES (${csr}, ${certificateType}, 'pending')
    `;

    logger.info({ certificateType }, 'CSR stored for manual signing');

    const error = new Error('Manual signing required: CSR stored for operator review');
    (error as Error & { code: string }).code = 'MANUAL_SIGNING_REQUIRED';
    throw error;
  }

  getContractCertificate(): Promise<ContractCertResult> {
    logger.warn('Contract certificate not supported in manual mode');
    return Promise.resolve({ status: 'Failed', exiResponse: '' });
  }

  async getOcspStatus(ocspRequestData: OcspRequestData): Promise<OcspResult> {
    // The OCSP responder URL comes from the station's GetCertificateStatus
    // payload, which is partner-attested (CSR's AIA extension) rather than
    // operator-controlled. A station with a hostile or compromised cert
    // could point us at an internal address; without this guard the CSMS
    // becomes an SSRF probe for partner-supplied URLs.
    if (isPrivateUrl(ocspRequestData.responderURL)) {
      logger.error(
        { url: ocspRequestData.responderURL },
        'Rejected OCSP responder URL pointing at a private/internal address',
      );
      return { status: 'Failed', ocspResult: '' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, OCSP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(ocspRequestData.responderURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ocsp-request' },
        body: Buffer.from(
          JSON.stringify({
            hashAlgorithm: ocspRequestData.hashAlgorithm,
            issuerNameHash: ocspRequestData.issuerNameHash,
            issuerKeyHash: ocspRequestData.issuerKeyHash,
            serialNumber: ocspRequestData.serialNumber,
          }),
        ),
        signal: controller.signal,
      });
    } catch (err) {
      logger.error(
        { err, url: ocspRequestData.responderURL },
        'OCSP request failed (network or timeout)',
      );
      return { status: 'Failed', ocspResult: '' };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      logger.error(
        { status: response.status, url: ocspRequestData.responderURL },
        'OCSP request failed',
      );
      return { status: 'Failed', ocspResult: '' };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: 'Accepted', ocspResult: buffer.toString('base64') };
  }

  async getRootCertificates(type: string): Promise<string[]> {
    const rows = await client`
      SELECT certificate FROM pki_ca_certificates
      WHERE certificate_type = ${type} AND status = 'active'
      ORDER BY created_at DESC
    `;

    return rows.map((r) => r.certificate as string);
  }
}
