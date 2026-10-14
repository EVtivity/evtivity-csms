// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { certificateAuditLog, client, writeAudit } from '@evtivity/database';
import type { Logger } from 'pino';
import { publishOcppCommand } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/** 2.1 TriggerMessage for each certificate type the station renews itself. */
const TRIGGER_FOR_TYPE: Record<string, string> = {
  ChargingStationCertificate: 'SignChargingStationCertificate',
  V2GCertificate: 'SignV2GCertificate',
  V2G20Certificate: 'SignV2G20Certificate',
};

/**
 * The renewal trigger: 2.1 TriggerMessage with the message of the type
 * (F06); on 1.6 the station certificate through ExtendedTriggerMessage
 * SignChargePointCertificate (Security Whitepaper) and the V2G certificate
 * through TriggerMessage SignV2GCertificate, which the command translation
 * wraps in a DataTransfer (OCA application note "Using ISO 15118 Plug &
 * Charge with OCPP 1.6", 3.1.1).
 */
function renewalCommand(
  stationId: string,
  certificateType: string,
  cert: Record<string, unknown>,
): { stationId: string; action: string; payload: Record<string, unknown> } {
  if (cert.ocpp_protocol === 'ocpp1.6' && certificateType === 'ChargingStationCertificate') {
    return {
      stationId,
      action: 'ExtendedTriggerMessage',
      payload: { requestedMessage: 'SignChargePointCertificate' },
    };
  }
  return {
    stationId,
    action: 'TriggerMessage',
    payload: { requestedMessage: TRIGGER_FOR_TYPE[certificateType] },
  };
}

export async function certificateExpirationCheckHandler(log: Logger): Promise<void> {
  const sql = client;
  const pubsub = getPubSub();

  const settingsRows = await sql`
    SELECT key, value FROM settings
    WHERE key IN ('pnc.enabled', 'pnc.expirationWarningDays', 'pnc.expirationCriticalDays')
  `;

  const settingsMap = new Map<string, unknown>();
  for (const row of settingsRows) {
    settingsMap.set(row.key as string, row.value);
  }

  // Station TLS certificates (security profile 3) are checked whether Plug and
  // Charge is on or off; V2G certificates and the PnC trust store only with it.
  const pncEnabled = settingsMap.get('pnc.enabled') === true;

  const criticalDays =
    typeof settingsMap.get('pnc.expirationCriticalDays') === 'number'
      ? (settingsMap.get('pnc.expirationCriticalDays') as number)
      : 7;
  const warningDays =
    typeof settingsMap.get('pnc.expirationWarningDays') === 'number'
      ? (settingsMap.get('pnc.expirationWarningDays') as number)
      : 30;

  const expiredStation = await sql`
    UPDATE station_certificates
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active'
      AND valid_to IS NOT NULL
      AND valid_to < NOW()
      AND (${pncEnabled} OR certificate_type = 'ChargingStationCertificate')
    RETURNING id, station_id, certificate_type, serial_number, valid_to
  `;
  if (expiredStation.length > 0) {
    log.info({ count: expiredStation.length }, 'Marked expired station certificates');
  }
  for (const row of expiredStation) {
    await auditExpired(log, 'station_certificates', row);
  }

  const expiredCa = !pncEnabled
    ? []
    : await sql`
    UPDATE pki_ca_certificates
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active'
      AND valid_to IS NOT NULL
      AND valid_to < NOW()
    RETURNING id, certificate_type, serial_number, valid_to
  `;
  if (expiredCa.length > 0) {
    log.info({ count: expiredCa.length }, 'Marked expired CA certificates');
  }
  for (const row of expiredCa) {
    await auditExpired(log, 'pki_ca_certificates', row);
  }

  // Auto-renew certs in the critical window: only certificates the station
  // holds the key of and renews through SignCertificate (A02, A03), on online
  // stations. One trigger per station and type: none when a newer certificate
  // of the type already replaced it (A02.FR.28 keeps the old one active) or a
  // renewal CSR is still open, so an unsigned manual CSR is not repeated every
  // hour.
  const criticalThreshold = new Date(Date.now() + criticalDays * 24 * 60 * 60 * 1000);
  const criticalCerts = await sql`
    SELECT DISTINCT ON (sc.station_id, sc.certificate_type)
           sc.id, sc.station_id, sc.certificate_type, sc.valid_to,
           cs.station_id AS station_ocpp_id, cs.ocpp_protocol
    FROM station_certificates sc
    JOIN charging_stations cs ON cs.id = sc.station_id
    WHERE sc.status = 'active'
      AND sc.valid_to IS NOT NULL
      AND sc.valid_to <= ${criticalThreshold}
      AND sc.valid_to > NOW()
      AND cs.is_online = true
      AND (
        (cs.ocpp_protocol = 'ocpp2.1'
          AND sc.certificate_type IN ('ChargingStationCertificate', 'V2GCertificate', 'V2G20Certificate'))
        OR (cs.ocpp_protocol = 'ocpp1.6'
          AND sc.certificate_type IN ('ChargingStationCertificate', 'V2GCertificate'))
      )
      AND (${pncEnabled} OR sc.certificate_type = 'ChargingStationCertificate')
      AND NOT EXISTS (
        SELECT 1 FROM station_certificates n
        WHERE n.station_id = sc.station_id
          AND n.certificate_type = sc.certificate_type
          AND n.status = 'active'
          AND n.valid_to > ${criticalThreshold}
      )
      AND NOT EXISTS (
        SELECT 1 FROM pki_csr_requests r
        WHERE r.station_id = sc.station_id
          AND r.certificate_type = sc.certificate_type
          AND r.status IN ('pending', 'submitted')
          AND r.created_at > NOW() - INTERVAL '1 day'
      )
    ORDER BY sc.station_id, sc.certificate_type, sc.valid_to
  `;

  for (const cert of criticalCerts) {
    const stationOcppId = cert.station_ocpp_id as string;
    const certificateType = cert.certificate_type as string;
    log.info(
      { stationId: stationOcppId, certificateType, validTo: cert.valid_to },
      'Certificate within critical expiry window, triggering auto-renewal',
    );
    await publishOcppCommand(pubsub, renewalCommand(stationOcppId, certificateType, cert));
  }

  // SSE notify on certs in the warning window (between warning and critical)
  const warningThreshold = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);
  const warningCerts = await sql`
    SELECT sc.station_id, cs.station_id AS station_ocpp_id, cs.site_id
    FROM station_certificates sc
    JOIN charging_stations cs ON cs.id = sc.station_id
    WHERE sc.status = 'active'
      AND sc.valid_to IS NOT NULL
      AND sc.valid_to <= ${warningThreshold}
      AND sc.valid_to > ${criticalThreshold}
      AND (${pncEnabled} OR sc.certificate_type = 'ChargingStationCertificate')
  `;

  for (const cert of warningCerts) {
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: 'certificate.expiring',
        stationId: cert.station_id as string,
        siteId: cert.site_id as string | null,
        sessionId: null,
      }),
    );
  }

  if (warningCerts.length > 0) {
    log.info({ count: warningCerts.length }, 'Notified for certs in warning window');
  }
}

/**
 * The `certificate.expired` audit row of a certificate this run marked
 * expired (only rows the guarded UPDATE changed). The id is the row id of its
 * table, like the operator certificate routes; `after.table` tells a CA from
 * a station certificate. No certificate body. Fail-open (writeAudit).
 */
async function auditExpired(
  log: Logger,
  table: 'station_certificates' | 'pki_ca_certificates',
  row: Record<string, unknown>,
): Promise<void> {
  const id = String(row['id']);
  const validTo = row['valid_to'];
  await writeAudit(
    { table: certificateAuditLog, idColumn: 'certificate_id' },
    {
      entityId: id,
      entityIdSnapshot: id,
      action: 'expired',
      actor: 'system',
      actorLabel: 'certificate-expiration-check',
      before: { status: 'active' },
      after: {
        status: 'expired',
        table,
        certificateType: row['certificate_type'] ?? null,
        serialNumber: row['serial_number'] ?? null,
        validTo: validTo instanceof Date ? validTo.toISOString() : (validTo ?? null),
        ...(row['station_id'] != null ? { stationId: row['station_id'] } : {}),
      },
    },
    undefined,
    log,
  );
}
