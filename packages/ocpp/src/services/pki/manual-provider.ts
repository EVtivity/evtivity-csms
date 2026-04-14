// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import { createLogger } from '@evtivity/lib';
import type {
  PkiProvider,
  SignCsrResult,
  ContractCertResult,
  OcspRequestData,
  OcspResult,
} from './pki-provider.js';

const logger = createLogger('manual-pki-provider');

export class ManualProvider implements PkiProvider {
  private sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl);
  }

  async signCsr(csr: string, certificateType: string): Promise<SignCsrResult> {
    await this.sql`
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
    const response = await fetch(ocspRequestData.responderURL, {
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
    });

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
    const rows = await this.sql`
      SELECT certificate FROM pki_ca_certificates
      WHERE certificate_type = ${type} AND status = 'active'
      ORDER BY created_at DESC
    `;

    return rows.map((r) => r.certificate as string);
  }
}
