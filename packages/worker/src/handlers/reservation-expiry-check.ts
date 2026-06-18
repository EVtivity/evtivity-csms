// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, writeReservationAudit } from '@evtivity/database';
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

// Timestamp columns arrive as raw strings: drizzle(client) in
// @evtivity/database overrides the postgres-js date parsers with identity,
// so raw client-tag queries never get Date objects back.
interface ExpiredRow {
  id: string;
  driver_id: string | null;
  prior_status: 'active' | 'scheduled';
  reservation_ocpp_id: number;
  station_ocpp_id: string;
  station_uuid: string;
  site_id: string | null;
  starts_at: string | null;
  expires_at: string;
  created_at: string;
  has_session: boolean;
}

interface ExpiringRow {
  id: string;
  driver_id: string | null;
  expires_at: string;
}

export async function reservationExpiryCheckHandler(log: Logger): Promise<void> {
  const pubsub = getPubSub();

  // Atomic UPDATE+RETURNING joined with charging_stations so we can also tell
  // the station to release the connector AND determine whether to charge a
  // no-show fee (active reservation that expired without a linked session).
  // The status IN ('active','scheduled') guard makes concurrent runs safe --
  // only one row is returned per expired reservation even if the job somehow
  // fans out. 'scheduled' covers orphaned reservations whose worker activation
  // never fired (BullMQ outage or job loss); they still need terminal cleanup.
  // prior_status is captured so the audit reflects the actual transition.
  const expired = await client<ExpiredRow[]>`
    WITH updated AS (
      UPDATE reservations r
      SET status = 'expired', updated_at = now()
      FROM (
        SELECT id, status AS prior_status FROM reservations
        WHERE status IN ('active', 'scheduled') AND expires_at < now()
        FOR UPDATE SKIP LOCKED
      ) pre
      WHERE r.id = pre.id
      RETURNING r.id, r.driver_id, pre.prior_status, r.reservation_id, r.station_id,
                r.starts_at, r.expires_at, r.created_at
    )
    SELECT
      updated.id,
      updated.driver_id,
      updated.prior_status,
      updated.reservation_id AS reservation_ocpp_id,
      charging_stations.station_id AS station_ocpp_id,
      charging_stations.id AS station_uuid,
      charging_stations.site_id,
      updated.starts_at,
      updated.expires_at,
      updated.created_at,
      EXISTS (
        SELECT 1 FROM charging_sessions WHERE charging_sessions.reservation_id = updated.id
      ) AS has_session
    FROM updated
    INNER JOIN charging_stations ON charging_stations.id = updated.station_id
  `;

  for (const row of expired) {
    // Conditional UPDATE + FOR UPDATE SKIP LOCKED guarantees exactly one row
    // per reservation here, so the audit row is never duplicated even if the
    // cron job overlaps with itself.
    await writeReservationAudit({
      reservationId: row.id,
      action: 'expired',
      actor: 'system',
      driverIdBefore: row.driver_id,
      driverIdAfter: row.driver_id,
      statusBefore: row.prior_status,
      statusAfter: 'expired',
    });

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
    // Skip for prior_status='scheduled': the station never received ReserveNow,
    // so CancelReservation would refer to an unknown id and the station would
    // log an error.
    if (row.prior_status === 'active') {
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
    }

    // No-show fee. Charge the holding rate * minutes the connector was held
    // when the reservation expired without a linked session. Skip when:
    //   - No driver attached (open / operator-comp reservation)
    //   - Prior status is 'scheduled' (the connector was never actually held;
    //     the worker activation never fired, so no-show is unjust)
    //   - The driver actually charged (has_session)
    //   - The resolved tariff has no holding rate
    //   - The driver has no default payment method (charge helper no-ops)
    if (row.driver_id != null && row.prior_status === 'active' && !row.has_session) {
      try {
        const tariff = await resolveTariff(row.station_uuid, row.driver_id);
        const ratePerMinute =
          tariff?.reservationFeePerMinute != null ? Number(tariff.reservationFeePerMinute) : 0;
        if (ratePerMinute > 0 && tariff != null) {
          // Instant ReserveNow reservations have no starts_at; the spot was
          // claimed at row.created_at. Falling back to expires_at (the prior
          // behavior) made holdingMs = 0 and silently waived the no-show fee
          // for every instant reservation -- the more common case. Match the
          // session-end path in event-projections.ts which uses created_at as
          // the same fallback so both paths bill consistent hold durations.
          const referenceStart = row.starts_at ?? row.created_at;
          const holdingMs = new Date(row.expires_at).getTime() - new Date(referenceStart).getTime();
          const holdingMinutes = Math.max(0, Math.ceil(holdingMs / 60_000));
          const amountCents = Math.round(holdingMinutes * ratePerMinute * 100);
          if (amountCents > 0) {
            await chargeReservationNoShowFee(
              row.driver_id,
              row.site_id,
              amountCents,
              row.id,
              tariff.currency,
            );
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
    log.info({ count: expired.length }, 'Expired reservations');
    // Tell the CSMS so the Reservations page reloads itself. One per batch,
    // best-effort.
    void pubsub
      .publish(
        'csms_events',
        JSON.stringify({
          eventType: 'reservation.changed',
          stationId: null,
          siteId: null,
          sessionId: null,
        }),
      )
      .catch(() => {
        /* best-effort */
      });
  }

  // Warn drivers about reservations expiring within the warning window.
  // Dedup: skip drivers who already got a reservation.Expiring within the last
  // WARNING window. The cron fires every minute and the window is 15 minutes,
  // so without dedup each driver would receive up to 15 duplicate notifications
  // (one per cron tick). Driver-level dedup (not per-reservation) is the finest
  // grain available: `notifications.metadata` only stores `driverId`. Multi-pod
  // safe because the notifications table is shared.
  const warningThreshold = new Date(Date.now() + EXPIRY_WARNING_MINUTES * 60 * 1000);
  const expiringSoon = await client<ExpiringRow[]>`
    SELECT r.id, r.driver_id, r.expires_at FROM reservations r
    WHERE r.status = 'active'
      AND r.expires_at > now()
      AND r.expires_at <= ${warningThreshold}
      AND r.driver_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.event_type = 'reservation.Expiring'
          AND n.metadata->>'driverId' = r.driver_id
          AND n.created_at > now() - (${EXPIRY_WARNING_MINUTES} || ' minutes')::interval
      )
  `;

  for (const row of expiringSoon) {
    if (row.driver_id != null) {
      void dispatchDriverNotification(
        client,
        'reservation.Expiring',
        row.driver_id,
        {
          reservationId: row.id,
          expiresAt: new Date(row.expires_at).toISOString(),
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      );
    }
  }
}
