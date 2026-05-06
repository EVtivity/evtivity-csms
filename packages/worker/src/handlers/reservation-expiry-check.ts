// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';
import { resolveTariff } from '@evtivity/api/src/services/tariff.service.js';
import { chargeReservationNoShowFee } from '@evtivity/api/src/lib/reservation-fees.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, API_TEMPLATES_DIR];

const EXPIRY_WARNING_MINUTES = 15;

interface ExpiredRow {
  id: string;
  driver_id: string | null;
  reservation_ocpp_id: number;
  station_ocpp_id: string;
  station_uuid: string;
  site_id: string | null;
  starts_at: Date | null;
  expires_at: Date;
  has_session: boolean;
}

interface ExpiringRow {
  id: string;
  driver_id: string | null;
  expires_at: Date;
}

export async function reservationExpiryCheckHandler(log: Logger): Promise<void> {
  const pubsub = getPubSub();

  // Atomic UPDATE+RETURNING joined with charging_stations so we can also tell
  // the station to release the connector AND determine whether to charge a
  // no-show fee (active reservation that expired without a linked session).
  // The status='active' guard makes concurrent runs safe -- only one row is
  // returned per expired reservation even if the job somehow fans out.
  const expired = await client<ExpiredRow[]>`
    WITH updated AS (
      UPDATE reservations
      SET status = 'expired', updated_at = now()
      WHERE status = 'active' AND expires_at < now()
      RETURNING id, driver_id, reservation_id, station_id, starts_at, expires_at, created_at
    )
    SELECT
      updated.id,
      updated.driver_id,
      updated.reservation_id AS reservation_ocpp_id,
      charging_stations.station_id AS station_ocpp_id,
      charging_stations.id AS station_uuid,
      charging_stations.site_id,
      updated.starts_at,
      updated.expires_at,
      EXISTS (
        SELECT 1 FROM charging_sessions WHERE charging_sessions.reservation_id = updated.id
      ) AS has_session
    FROM updated
    INNER JOIN charging_stations ON charging_stations.id = updated.station_id
  `;

  for (const row of expired) {
    if (row.driver_id != null) {
      void dispatchDriverNotification(
        client,
        'reservation.Expired',
        row.driver_id,
        { reservationId: row.id },
        ALL_TEMPLATES_DIRS,
        pubsub,
      );
    }

    // Best-effort CancelReservation. CommandListener routes through
    // sendVersionAwareCommand for protocol translation. Offline stations get
    // the command queued via offline_command_queue and replayed on reconnect.
    try {
      await pubsub.publish(
        'ocpp_commands',
        JSON.stringify({
          commandId: crypto.randomUUID(),
          stationId: row.station_ocpp_id,
          action: 'CancelReservation',
          payload: { reservationId: row.reservation_ocpp_id },
        }),
      );
    } catch (err) {
      log.warn(
        { err, reservationId: row.id, stationOcppId: row.station_ocpp_id },
        'Failed to publish CancelReservation for expired reservation',
      );
    }

    // No-show fee. Charge the holding rate * minutes the connector was held
    // when the reservation expired without a linked session. Skip when:
    //   - No driver attached (open / operator-comp reservation)
    //   - The driver actually charged (has_session)
    //   - The resolved tariff has no holding rate
    //   - The driver has no default payment method (charge helper no-ops)
    if (row.driver_id != null && !row.has_session) {
      try {
        const tariff = await resolveTariff(row.station_uuid, row.driver_id);
        const ratePerMinute =
          tariff?.reservationFeePerMinute != null ? Number(tariff.reservationFeePerMinute) : 0;
        if (ratePerMinute > 0) {
          const referenceStart = row.starts_at ?? row.expires_at;
          const holdingMs = row.expires_at.getTime() - new Date(referenceStart).getTime();
          const holdingMinutes = Math.max(0, Math.ceil(holdingMs / 60_000));
          const amountCents = Math.round(holdingMinutes * ratePerMinute * 100);
          if (amountCents > 0) {
            await chargeReservationNoShowFee(row.driver_id, row.site_id, amountCents, row.id);
            log.info(
              { reservationId: row.id, driverId: row.driver_id, amountCents, holdingMinutes },
              'Charged no-show reservation fee',
            );
          }
        }
      } catch (err) {
        log.warn(
          { err, reservationId: row.id, driverId: row.driver_id },
          'Failed to charge no-show reservation fee',
        );
      }
    }
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'Expired reservations and dispatched cancellations');
  }

  // Warn drivers about reservations expiring within the warning window.
  const warningThreshold = new Date(Date.now() + EXPIRY_WARNING_MINUTES * 60 * 1000);
  const expiringSoon = await client<ExpiringRow[]>`
    SELECT id, driver_id, expires_at FROM reservations
    WHERE status = 'active'
      AND expires_at > now()
      AND expires_at <= ${warningThreshold}
  `;

  for (const row of expiringSoon) {
    if (row.driver_id != null) {
      void dispatchDriverNotification(
        client,
        'reservation.Expiring',
        row.driver_id,
        {
          reservationId: row.id,
          expiresAt: row.expires_at.toISOString(),
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      );
    }
  }
}
