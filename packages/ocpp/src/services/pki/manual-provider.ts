// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type {
  PkiProvider,
  SignCsrResult,
  ContractCertResult,
  OcspRequestData,
  OcspResult,
} from './pki-provider.js';
import { getOcspResultForStation } from './ocsp.js';

const logger = createLogger('manual-pki-provider');

export class ManualProvider implements PkiProvider {
  // Reuse the shared connection pool from @evtivity/database instead of
  // spinning up a new postgres() connection per provider instance - the
  // provider factory caches by config hash with a 60s TTL and a fresh
  // connection would leak on every cache miss.
  async signCsr(
    csr: string,
    certificateType: string,
    stationDbId: string | null,
  ): Promise<SignCsrResult> {
    // The station ID lets the operator's signing dispatch CertificateSigned to it.
    await client`
      INSERT INTO pki_csr_requests (csr, certificate_type, status, station_id)
      VALUES (${csr}, ${certificateType}, 'pending', ${stationDbId})
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
    // RFC 6960 request to the responder named by the station. The helper
    // applies the SSRF guard (private addresses only when allowlisted).
    const result = await getOcspResultForStation(ocspRequestData);
    if (result.status !== 'Accepted') {
      logger.error(
        { url: ocspRequestData.responderURL, reason: result.reason },
        'OCSP status request failed',
      );
      return { status: 'Failed', ocspResult: '' };
    }
    return { status: 'Accepted', ocspResult: result.ocspResult };
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
