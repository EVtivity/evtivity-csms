// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';

const logger = createLogger('certificate-expiration-monitor');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startExpirationMonitor(sql: postgres.Sql, pubsub: PubSubClient): void {
  async function checkExpirations(): Promise<void> {
    try {
      // Read settings
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

      // Mark expired certificates
      const expiredCount = await sql`
        UPDATE station_certificates
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'active'
          AND valid_to IS NOT NULL
          AND valid_to < NOW()
        RETURNING id
      `;

      if (expiredCount.length > 0) {
        logger.info({ count: expiredCount.length }, 'Marked expired station certificates');
      }

      // Mark expired CA certificates
      const expiredCaCount = await sql`
        UPDATE pki_ca_certificates
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'active'
          AND valid_to IS NOT NULL
          AND valid_to < NOW()
        RETURNING id
      `;

      if (expiredCaCount.length > 0) {
        logger.info({ count: expiredCaCount.length }, 'Marked expired CA certificates');
      }

      // Find station certificates within critical window for auto-renewal
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
        logger.info(
          {
            stationId: stationOcppId,
            certificateType: cert.certificate_type,
            validTo: cert.valid_to,
          },
          'Certificate within critical expiry window, triggering auto-renewal',
        );

        // Send TriggerMessage to station to initiate SignCertificate
        const commandPayload = JSON.stringify({
          stationId: stationOcppId,
          commandName: 'TriggerMessage',
          payload: {
            requestedMessage: 'SignChargingStationCertificate',
          },
        });

        await pubsub.publish('ocpp_commands', commandPayload);
      }

      // Find certificates in warning window for SSE notification
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

      if (warningCerts.length > 0) {
        logger.info(
          { count: warningCerts.length },
          'Certificates approaching expiry (warning window)',
        );

        // Notify about expiring certificates
        for (const cert of warningCerts) {
          const payload = JSON.stringify({
            eventType: 'certificate.expiring',
            stationId: cert.station_id as string,
            siteId: cert.site_id as string | null,
            sessionId: null,
          });
          await pubsub.publish('csms_events', payload);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Certificate expiration check failed');
    }
  }

  // Run initial check after a short delay, then every hour
  setTimeout(() => {
    void checkExpirations();
  }, 30_000);

  setInterval(() => {
    void checkExpirations();
  }, CHECK_INTERVAL_MS);

  logger.info('Certificate expiration monitor started');
}
