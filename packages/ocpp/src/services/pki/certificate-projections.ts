// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
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
    /** The pki_csr_requests row the SignCertificate handler recorded. */
    csrId: number | null;
    requestId: number | null;
    certificateChain: string;
    certificateType: string;
    providerReference: string;
  },
  pubsub: PubSubClient,
): Promise<void> {
  // The CSR the provider signed, while still open: a replayed event finds it
  // signed already and sends nothing again (P7).
  const signed = await sql<Array<{ id: number }>>`
    UPDATE pki_csr_requests
    SET status = 'signed',
        signed_certificate_chain = ${payload.certificateChain},
        provider_reference = ${payload.providerReference},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${payload.csrId}
      AND station_id = ${stationUuid}
      AND status IN ('pending', 'submitted')
    RETURNING id
  `;
  const csr = signed[0];
  if (csr == null) {
    logger.warn(
      { stationId, csrId: payload.csrId, certificateType: payload.certificateType },
      'Signed CSR is not open; CertificateSigned not dispatched again',
    );
    return;
  }
  await auditCsrSigned(sql, csr.id, stationUuid, payload);

  // CertificateSigned to the station, with the requestId of its
  // SignCertificateRequest (A02.FR.25).
  await publishOcppCommand(pubsub, {
    stationId,
    action: 'CertificateSigned',
    payload: {
      certificateChain: payload.certificateChain,
      certificateType: payload.certificateType,
      ...(payload.requestId != null ? { requestId: payload.requestId } : {}),
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

/** The fields of a PEM certificate the station_certificates mirror keeps. */
function describeCertificate(pem: string): {
  serialNumber: string;
  issuer: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
} | null {
  try {
    const cert = new crypto.X509Certificate(pem);
    return {
      serialNumber: cert.serialNumber,
      issuer: cert.issuer.replace(/\n/g, ', ').slice(0, 500),
      subject: cert.subject.replace(/\n/g, ', ').slice(0, 500),
      validFrom: new Date(cert.validFrom),
      validTo: new Date(cert.validTo),
    };
  } catch {
    // fail-open: an unparseable certificate is reported to the caller as null and logged there
    return null;
  }
}

/**
 * CertificateSigned answered Accepted (A02.FR.08): the mirror gets the leaf of
 * the chain with its serial, issuer and validity. The SP3 connection check
 * accepts a client certificate only when its serial is an active row here, so
 * without it a renewed station certificate locked the station out. The
 * previous certificate stays active: a station that cannot connect with the
 * new one falls back to it (A02.FR.28), and the expiry check skips a
 * certificate a newer one of the same type replaces. The sub-CA certificates
 * of the chain are not station certificates. A Rejected answer changes nothing.
 */
export async function handleCertificateSignedResult(
  sql: postgres.Sql,
  stationUuid: string,
  certificateChain: string,
  certificateType: string,
  status: string,
): Promise<void> {
  if (status !== 'Accepted') {
    logger.warn({ stationUuid, certificateType, status }, 'CertificateSigned rejected by station');
    return;
  }
  const leaf = certificateChain.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  )?.[0];
  const fields = leaf == null ? null : describeCertificate(leaf);
  if (leaf == null || fields == null) {
    logger.warn({ stationUuid, certificateType }, 'Accepted certificate chain does not parse');
    return;
  }
  const stored = await sql.begin(async (tx) => {
    const [existing] = await tx<Array<{ id: number }>>`
      SELECT id FROM station_certificates
      WHERE station_id = ${stationUuid} AND certificate_type = ${certificateType}
        AND serial_number = ${fields.serialNumber} AND issuer = ${fields.issuer}
      LIMIT 1
    `;
    if (existing != null) return null;
    const [row] = await tx<Array<{ id: number }>>`
      INSERT INTO station_certificates
        (station_id, certificate_type, certificate, serial_number, issuer, subject,
         valid_from, valid_to, source, status)
      VALUES (${stationUuid}, ${certificateType}, ${leaf}, ${fields.serialNumber},
              ${fields.issuer}, ${fields.subject}, ${fields.validFrom}, ${fields.validTo},
              'pki_provider', 'active')
      RETURNING id
    `;
    return row ?? null;
  });
  if (stored == null) return;
  await writeAudit(
    { table: certificateAuditLog, idColumn: 'certificate_id' },
    {
      entityId: String(stored.id),
      entityIdSnapshot: String(stored.id),
      action: 'certificate_installed',
      actor: 'system',
      actorLabel: 'ocpp:CertificateSigned',
      after: {
        stationId: stationUuid,
        certificateType,
        serialNumber: fields.serialNumber,
        validTo: fields.validTo.toISOString(),
      },
    },
    undefined,
    logger,
  );
  logger.info(
    { stationUuid, certificateType, certificateId: stored.id },
    'Station certificate stored after CertificateSigned accepted',
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
