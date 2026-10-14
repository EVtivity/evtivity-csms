// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { certificateAuditLog, writeAudit } from '@evtivity/database';
import { createLogger, publishOcppCommand } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';

const logger = createLogger('certificate-projections');

export async function handleCsrSigned(
  sql: postgres.Sql,
  stationId: string,
  stationUuid: string,
  payload: {
    certificateChain: string;
    certificateType: string;
    providerReference: string;
  },
  pubsub: PubSubClient,
): Promise<void> {
  // Update the most recent pending/submitted CSR request to signed
  const signed = await sql<Array<{ id: number }>>`
    UPDATE pki_csr_requests
    SET status = 'signed',
        signed_certificate_chain = ${payload.certificateChain},
        provider_reference = ${payload.providerReference},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM pki_csr_requests
      WHERE station_id = ${stationUuid}
        AND certificate_type = ${payload.certificateType}
        AND status IN ('pending', 'submitted')
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING id
  `;
  const csr = signed[0];
  if (csr != null) await auditCsrSigned(sql, csr.id, stationUuid, payload);

  // Dispatch CertificateSigned command to the station
  await publishOcppCommand(pubsub, {
    stationId,
    action: 'CertificateSigned',
    payload: {
      certificateChain: payload.certificateChain,
      certificateType: payload.certificateType,
    },
  });

  logger.info(
    { stationId, certificateType: payload.certificateType },
    'CertificateSigned command dispatched',
  );
}

/**
 * The `certificate.csr_signed` row of a CSR the PKI provider signed (the id
 * is the CSR request's, as the operator sign route writes). Actor `system`,
 * label `pki:<pnc.provider>`. No certificate chain. Fail-open (writeAudit).
 */
async function auditCsrSigned(
  sql: postgres.Sql,
  csrId: number,
  stationUuid: string,
  payload: { certificateType: string; providerReference: string },
): Promise<void> {
  let provider = 'unknown';
  try {
    const [row] = await sql<Array<{ value: unknown }>>`
      SELECT value FROM settings WHERE key = 'pnc.provider'
    `;
    provider = typeof row?.value === 'string' && row.value !== '' ? row.value : 'manual';
  } catch (err) {
    // fail-open: the label is informational, the audit row still goes out.
    logger.warn({ err }, 'Failed to read pnc.provider for the CSR audit label');
  }
  await writeAudit(
    { table: certificateAuditLog, idColumn: 'certificate_id' },
    {
      entityId: String(csrId),
      entityIdSnapshot: String(csrId),
      action: 'csr_signed',
      actor: 'system',
      actorLabel: `pki:${provider}`,
      after: {
        status: 'signed',
        stationId: stationUuid,
        certificateType: payload.certificateType,
        providerReference: payload.providerReference,
      },
    },
    undefined,
    logger,
  );
}

export async function handleCertificateSignedResult(
  sql: postgres.Sql,
  stationUuid: string,
  certificateChain: string,
  certificateType: string,
): Promise<void> {
  // Parse the PEM chain and store individual certificates
  const certs = certificateChain
    .split('-----END CERTIFICATE-----')
    .filter((c) => c.includes('-----BEGIN CERTIFICATE-----'))
    .map((c) => c.trim() + '\n-----END CERTIFICATE-----');

  for (const cert of certs) {
    await sql`
      INSERT INTO station_certificates (station_id, certificate_type, certificate, source)
      VALUES (${stationUuid}, ${certificateType}, ${cert}, 'pki_provider')
      ON CONFLICT DO NOTHING
    `;
  }

  logger.info(
    { stationUuid, certCount: certs.length, certificateType },
    'Station certificates stored after CertificateSigned accepted',
  );
}

export async function handleInstallCertificateResult(
  sql: postgres.Sql,
  stationUuid: string,
  certificate: string,
  certificateType: string,
  status: string,
): Promise<void> {
  if (status === 'Accepted') {
    await sql`
      INSERT INTO station_certificates (station_id, certificate_type, certificate, source)
      VALUES (${stationUuid}, ${certificateType}, ${certificate}, 'manual_install')
      ON CONFLICT DO NOTHING
    `;

    logger.info({ stationUuid, certificateType }, 'Certificate installed on station');
  } else {
    logger.warn({ stationUuid, certificateType, status }, 'InstallCertificate rejected by station');
  }
}
