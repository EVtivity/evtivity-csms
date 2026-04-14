// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type postgres from 'postgres';
import { createLogger } from '@evtivity/lib';
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
  await sql`
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
  `;

  // Dispatch CertificateSigned command to the station
  const commandPayload = JSON.stringify({
    commandId: crypto.randomUUID(),
    stationId,
    action: 'CertificateSigned',
    payload: {
      certificateChain: payload.certificateChain,
      certificateType: payload.certificateType,
    },
  });

  await pubsub.publish('ocpp_commands', commandPayload);

  logger.info(
    { stationId, certificateType: payload.certificateType },
    'CertificateSigned command dispatched',
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
