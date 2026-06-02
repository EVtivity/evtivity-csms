// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import { client } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

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

  if (settingsMap.get('pnc.enabled') !== true) return;

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
    RETURNING id
  `;
  if (expiredStation.length > 0) {
    log.info({ count: expiredStation.length }, 'Marked expired station certificates');
  }

  const expiredCa = await sql`
    UPDATE pki_ca_certificates
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active'
      AND valid_to IS NOT NULL
      AND valid_to < NOW()
    RETURNING id
  `;
  if (expiredCa.length > 0) {
    log.info({ count: expiredCa.length }, 'Marked expired CA certificates');
  }

  // Auto-renew certs in the critical window (online OCPP 2.1 stations only)
  const criticalThreshold = new Date(Date.now() + criticalDays * 24 * 60 * 60 * 1000);
  const criticalCerts = await sql`
    SELECT sc.id, sc.station_id, sc.certificate_type, sc.valid_to,
           cs.station_id AS station_ocpp_id
    FROM station_certificates sc
    JOIN charging_stations cs ON cs.id = sc.station_id
    WHERE sc.status = 'active'
      AND sc.valid_to IS NOT NULL
      AND sc.valid_to <= ${criticalThreshold}
      AND sc.valid_to > NOW()
      AND cs.is_online = true
      AND cs.ocpp_protocol = 'ocpp2.1'
  `;

  for (const cert of criticalCerts) {
    const stationOcppId = cert.station_ocpp_id as string;
    log.info(
      {
        stationId: stationOcppId,
        certificateType: cert.certificate_type,
        validTo: cert.valid_to,
      },
      'Certificate within critical expiry window, triggering auto-renewal',
    );

    // CommandListener requires `action` (not `commandName`) and parses
    // commandId for tracking. The earlier payload used `commandName` so the
    // listener rejected it as malformed and silently dropped the renewal —
    // certificates in the critical window never got their TriggerMessage,
    // and auto-renewal effectively didn't work.
    await pubsub.publish(
      'ocpp_commands',
      JSON.stringify({
        commandId: randomUUID(),
        stationId: stationOcppId,
        action: 'TriggerMessage',
        payload: {
          requestedMessage: 'SignChargingStationCertificate',
        },
      }),
    );
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
