// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { expireDueReservations, settleDueNoShowFees } from '@evtivity/services/reservation-expiry';
import type { ReservationExpiryDeps } from '@evtivity/services/reservation-expiry';
import { notifyReservationDriver } from '@evtivity/services/reservation-notify';
import { paymentContext } from '../lib/payments.js';
import { enqueueOverdueReservationActivation } from '../reservation-worker.js';

const EXPIRY_WARNING_MINUTES = 15;

/** Scheduled reservations past their start activated per run (G6). */
export const OVERDUE_ACTIVATION_LIMIT = 100;

// Raw rows: timestamps arrive as postgres text (database.md).
type ExpiringRow = {
  id: string;
  driver_id: string | null;
  reservation_ocpp_id: number;
  station_ocpp_id: string;
  expires_at: RawTimestamp;
};

/**
 * Each minute: expires the reservations past their end and charges the
 * no-show fees they owe (shared with the station-reported expiry), activates
 * the scheduled ones whose start passed without an activation (G6), settles
 * the fees a crash left `due` (G10), and warns drivers whose hold ends soon.
 */
export async function reservationExpiryCheckHandler(log: Logger): Promise<void> {
  const deps: ReservationExpiryDeps = {
    pubsub: getPubSub(),
    payments: paymentContext(log, 'reservation-expiry-check'),
    logger: log,
  };

  const expired = await expireDueReservations(deps);
  if (expired.length > 0) log.info({ count: expired.length }, 'Expired reservations');

  await activateOverdueReservations(log);

  await settleDueNoShowFees(deps);

  await warnExpiringReservations(deps);
}

/**
 * Activates `scheduled` reservations whose start passed while their hold is
 * still ahead (G6): the reservation_schedule message rides non-durable
 * pub/sub, so a lost one would leave the row scheduled until it expires. The
 * job id is the bridge's, so a job already queued is not added twice.
 */
async function activateOverdueReservations(log: Logger): Promise<void> {
  const overdue = await client<Array<{ id: string }>>`
    SELECT id FROM reservations
    WHERE status = 'scheduled' AND starts_at <= now() AND expires_at > now()
    ORDER BY starts_at
    LIMIT ${OVERDUE_ACTIVATION_LIMIT}
  `;
  for (const row of overdue) {
    try {
      await enqueueOverdueReservationActivation(row.id);
    } catch (err) {
      // fail-open: the next run tries again, and the expiry ends the row (P9).
      log.warn({ err, reservationId: row.id }, 'Adding an overdue reservation activation failed');
    }
  }
}

/**
 * Warns drivers about holds ending within the warning window, once per
 * reservation (G17): the notification log stores the reservation row id
 * (`metadata.reservationId`). The cron runs each minute and the window is 15
 * minutes, so the dedup look-back is the same window; a hold extended after
 * its warning gets a new one once it nears its new end.
 */
async function warnExpiringReservations(deps: ReservationExpiryDeps): Promise<void> {
  const warningThreshold = new Date(Date.now() + EXPIRY_WARNING_MINUTES * 60 * 1000);
  const expiringSoon = await client<ExpiringRow[]>`
    SELECT r.id, r.driver_id, r.reservation_id AS reservation_ocpp_id,
           cs.station_id AS station_ocpp_id, r.expires_at
    FROM reservations r
    INNER JOIN charging_stations cs ON cs.id = r.station_id
    WHERE r.status = 'active'
      AND r.expires_at > now()
      AND r.expires_at <= ${warningThreshold}
      AND r.driver_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.event_type = 'reservation.Expiring'
          AND n.metadata->>'reservationId' = r.id
          AND n.created_at > now() - make_interval(mins => ${EXPIRY_WARNING_MINUTES})
      )
  `;

  for (const row of expiringSoon) {
    await notifyReservationDriver(
      'reservation.Expiring',
      {
        reservationDbId: row.id,
        reservationOcppId: row.reservation_ocpp_id,
        stationOcppId: row.station_ocpp_id,
        driverId: row.driver_id,
        expiresAt: row.expires_at,
      },
      {},
      deps,
    );
  }
}
