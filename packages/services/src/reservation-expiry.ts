// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  alertStationWatchersIfAvailable,
  client,
  resolveReservationFeeTerms,
  toDate,
  toDateOrNull,
  writeReservationAudit,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import { reservationHoldingMinutes } from '@evtivity/lib';
import type { ReservationExpiryReason } from '@evtivity/lib/ai-insights';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import { chargeReservationFee } from '@evtivity/payments';
import type { PaymentContext } from '@evtivity/payments';
import { refreshFleetReservationStatuses } from './fleet-reservation-status.js';
import { applyReservationCancellation } from './reservation-cancel.js';
import { cancelReasonNoticeFlags, notifyReservationDriver } from './reservation-notify.js';
import { publishCancelReservation } from './reservation.service.js';

/**
 * Reservation expiry and the no-show fee (v0.1.45 G5, G9, G10, G16), shared
 * by the worker cron and the OCPP `ReservationStatusUpdate Expired`
 * projection. The OCPP process passes its own pub/sub client, payment context
 * and template folders.
 */
export interface ReservationExpiryDeps {
  pubsub: PubSubClient;
  payments: PaymentContext;
  logger: ServiceLogger;
  templatesDirs?: string[] | undefined;
}

// Raw rows: timestamps arrive as postgres text (database.md).
type ExpiredRow = {
  id: string;
  driver_id: string | null;
  prior_status: 'active' | 'scheduled';
  reservation_ocpp_id: number;
  station_uuid: string;
  station_ocpp_id: string;
  site_id: string | null;
  expires_at: RawTimestamp;
  no_show_fee_state: string;
  acked: boolean;
  fleet_reservation_id: string | null;
};

export interface ExpiredReservation {
  id: string;
  driverId: string | null;
  priorStatus: 'active' | 'scheduled';
  reservationOcppId: number;
  stationUuid: string;
  stationOcppId: string;
  siteId: string | null;
  noShowFeeState: string;
  /** The fleet booking of a fleet slot, else null. */
  fleetReservationId: string | null;
  /** Why it expired (`after.reason` of the `expired` audit row). */
  reason: ReservationExpiryReason;
}

/**
 * The expiry UPDATE: status `expired` and, in the same statement, the no-show
 * fee `due` when one applies (G10): the hold was active, the station accepted
 * it (G5), it has a driver and no linked session (G12), and its fee was not
 * waived (G13). A crash after this statement leaves the fee for the next
 * settle run. `FOR UPDATE SKIP LOCKED` and the status guard give each row one
 * winner, which audits and notifies.
 */
/**
 * Why a reservation expired, for its `expired` audit row: only `no_show` is a
 * hold the driver did not use (the fee is due); the others are not no-shows
 * and raise no `reservation_no_show` insight.
 */
function expiryReason(r: ExpiredRow): ReservationExpiryReason {
  if (r.no_show_fee_state === 'due') return 'no_show';
  if (r.no_show_fee_state === 'waived') return 'waived';
  if (r.driver_id == null) return 'no_driver';
  if (r.prior_status === 'scheduled' || !r.acked) return 'not_on_station';
  return 'no_show';
}

async function runExpiry(where: 'due' | { stationUuid: string; reservationOcppId: number }) {
  const rows =
    where === 'due'
      ? await client<ExpiredRow[]>`
          WITH pre AS (
            SELECT id, status AS prior_status FROM reservations
            WHERE status IN ('active', 'scheduled') AND expires_at < now()
            FOR UPDATE SKIP LOCKED
          )
          ${expiryUpdate()}`
      : await client<ExpiredRow[]>`
          WITH pre AS (
            SELECT id, status AS prior_status FROM reservations
            WHERE reservation_id = ${where.reservationOcppId}
              AND station_id = ${where.stationUuid}
              AND status IN ('active', 'scheduled')
            FOR UPDATE SKIP LOCKED
          )
          ${expiryUpdate()}`;
  return rows.map(
    (r): ExpiredReservation => ({
      id: r.id,
      driverId: r.driver_id,
      priorStatus: r.prior_status,
      reservationOcppId: r.reservation_ocpp_id,
      stationUuid: r.station_uuid,
      stationOcppId: r.station_ocpp_id,
      siteId: r.site_id,
      noShowFeeState: r.no_show_fee_state,
      fleetReservationId: r.fleet_reservation_id,
      reason: expiryReason(r),
    }),
  );
}

function expiryUpdate() {
  return client`
    , updated AS (
      UPDATE reservations r
      SET status = 'expired',
          no_show_fee_state = CASE
            WHEN pre.prior_status = 'active'
              AND r.driver_id IS NOT NULL
              AND r.station_ack_at IS NOT NULL
              AND r.no_show_fee_state = 'none'
              AND NOT EXISTS (
                SELECT 1 FROM charging_sessions s WHERE s.reservation_id = r.id
              )
            THEN 'due'
            ELSE r.no_show_fee_state
          END,
          updated_at = now()
      FROM pre
      WHERE r.id = pre.id
      RETURNING r.id, r.driver_id, pre.prior_status, r.reservation_id, r.station_id,
                r.expires_at, r.no_show_fee_state, r.station_ack_at IS NOT NULL AS acked,
                r.fleet_reservation_id
    )
    SELECT updated.id, updated.driver_id, updated.prior_status,
           updated.reservation_id AS reservation_ocpp_id,
           updated.station_id AS station_uuid,
           cs.station_id AS station_ocpp_id, cs.site_id,
           updated.expires_at, updated.no_show_fee_state, updated.acked,
           updated.fleet_reservation_id
    FROM updated
    INNER JOIN charging_stations cs ON cs.id = updated.station_id`;
}

/**
 * The effects of an expiry, once per expired row: the `expired` audit row,
 * the driver notice, a CancelReservation for a cron expiry of an active hold
 * (a station-reported expiry already freed the EVSE), the station-watch
 * alert, `reservation.changed` per site, then the no-show fee. Fail-open.
 */
async function afterExpiry(
  deps: ReservationExpiryDeps,
  rows: ExpiredReservation[],
  source: 'cron' | 'station',
): Promise<void> {
  for (const row of rows) {
    await writeReservationAudit(
      {
        reservationId: row.id,
        action: 'expired',
        actor: 'system',
        driverIdBefore: row.driverId,
        driverIdAfter: row.driverId,
        statusBefore: row.priorStatus,
        statusAfter: 'expired',
        reason: row.reason,
        notes: source === 'station' ? 'station-reported expiry' : null,
      },
      undefined,
      deps.logger,
    );
    await notifyReservationDriver(
      'reservation.Expired',
      {
        reservationDbId: row.id,
        reservationOcppId: row.reservationOcppId,
        stationOcppId: row.stationOcppId,
        driverId: row.driverId,
      },
      {},
      deps,
    );
    // A scheduled hold never reached the station, so it has nothing to cancel.
    if (source === 'cron' && row.priorStatus === 'active') {
      await publishCancelReservation(
        deps.pubsub,
        row.stationOcppId,
        row.reservationOcppId,
        deps.logger,
      );
    }
    try {
      await alertStationWatchersIfAvailable(client, row.stationUuid);
    } catch (err) {
      deps.logger.warn({ err, reservationId: row.id }, 'Station-watch check after expiry failed');
    }
  }
  // Expired fleet slots move their bookings' status (expired, partial). Fail-open.
  await refreshFleetReservationStatuses(
    rows.map((r) => r.fleetReservationId),
    deps.logger,
  );
  for (const siteId of new Set(rows.map((r) => r.siteId))) {
    try {
      await deps.pubsub.publish(
        'csms_events',
        JSON.stringify({
          eventType: 'reservation.changed',
          stationId: null,
          siteId,
          sessionId: null,
        }),
      );
    } catch (err) {
      // fail-open: the Reservations page refreshes on its next fetch (P9).
      deps.logger.warn({ err, siteId }, 'reservation.changed publish failed');
    }
  }
  for (const row of rows) {
    if (row.noShowFeeState === 'due') await settleNoShowFee(deps, row.id);
  }
}

/** Expires every live reservation past its end (the worker cron). */
export async function expireDueReservations(
  deps: ReservationExpiryDeps,
): Promise<ExpiredReservation[]> {
  const rows = await runExpiry('due');
  await afterExpiry(deps, rows, 'cron');
  return rows;
}

/**
 * Expires the reservation a station reported `Expired` for (G9): only the
 * reporting station's row, and never an `in_use` or `used` one (a charging
 * holder keeps it). The fee and the notice follow the cron path, once.
 */
export async function expireStationReportedReservation(
  deps: ReservationExpiryDeps,
  q: { stationUuid: string; reservationOcppId: number },
): Promise<boolean> {
  const rows = await runExpiry(q);
  await afterExpiry(deps, rows, 'station');
  return rows.length > 0;
}

type FeeRow = {
  id: string;
  driver_id: string | null;
  station_id: string;
  site_id: string | null;
  starts_at: RawTimestamp;
  created_at: RawTimestamp;
  expires_at: RawTimestamp;
  updated_at: RawTimestamp;
  fee_tax_basis: string | null;
  fee_tax_rate: string | null;
  fee_per_minute: string | null;
  fee_cancellation_cents: number | null;
};

/** A `due` fee still unsettled after this long is given up as failed. */
export const NO_SHOW_FEE_SETTLE_MAX_HOURS = 24;

async function setFeeState(id: string, state: 'none' | 'charged' | 'failed'): Promise<void> {
  await client`
    UPDATE reservations SET no_show_fee_state = ${state}, updated_at = now()
    WHERE id = ${id} AND no_show_fee_state = 'due'
  `;
}

/**
 * Charges the no-show fee of one expired reservation whose fee is `due`: the
 * holding fee per minute times the minutes held, on the terms snapshotted at
 * creation. Then `charged`, `failed` (declined, no card, provider error) or
 * `none` (the terms have no holding fee, a free vend site included). The
 * charge is idempotent by key and the unique `(reservation_id, charge_type)`
 * index, so a rerun or a second pod charges nothing: a recorded charge sets
 * the state from its payment record, and one still `pending` (a crash, G11)
 * stays `due` until reconciliation resolves it. Fail-open: an error leaves
 * it `due` for the next run.
 */
export async function settleNoShowFee(deps: ReservationExpiryDeps, id: string): Promise<void> {
  try {
    const [row] = await client<FeeRow[]>`
      SELECT r.id, r.driver_id, r.station_id, cs.site_id, r.starts_at, r.created_at,
             r.expires_at, r.updated_at, r.fee_tax_basis, r.fee_tax_rate, r.fee_per_minute,
             r.fee_cancellation_cents
      FROM reservations r
      INNER JOIN charging_stations cs ON cs.id = r.station_id
      WHERE r.id = ${id} AND r.no_show_fee_state = 'due'
    `;
    if (row == null) return;
    if (row.driver_id == null) {
      await setFeeState(id, 'none');
      return;
    }
    const terms = await resolveReservationFeeTerms({
      stationId: row.station_id,
      driverId: row.driver_id,
      feeTaxBasis: row.fee_tax_basis,
      feeTaxRate: row.fee_tax_rate,
      feePerMinute: row.fee_per_minute,
      feeCancellationCents: row.fee_cancellation_cents,
    });
    // Instant reservations have no starts_at: the hold began at created_at.
    const minutes = reservationHoldingMinutes({
      startsAt: toDateOrNull(row.starts_at),
      createdAt: toDate(row.created_at as Date | string),
      expiresAt: toDate(row.expires_at as Date | string),
    });
    if (terms.feePerMinute == null || Number(terms.feePerMinute) <= 0 || minutes <= 0) {
      await setFeeState(id, 'none');
      return;
    }
    const result = await chargeReservationFee(
      {
        type: 'reservation_no_show',
        reservationId: id,
        driverId: row.driver_id,
        siteId: row.site_id,
        fee: { pricePerMinute: terms.feePerMinute, minutes },
        basis: terms.basis,
        taxRate: terms.taxRate,
      },
      deps.payments,
    );
    if (result.status === 'charged') {
      await setFeeState(id, 'charged');
      deps.logger.info(
        { reservationId: id, grossCents: result.grossCents, minutes },
        'Charged no-show reservation fee',
      );
    } else if (result.status === 'failed') {
      await setFeeState(id, 'failed');
      deps.logger.warn(
        { reservationId: id, paymentRecordId: result.paymentRecordId },
        `No-show reservation fee declined: ${result.reason}`,
      );
    } else if (result.status === 'skipped') {
      await setFeeState(id, result.reason === 'no_amount' ? 'none' : 'failed');
    } else {
      const [record] = await client<Array<{ status: string }>>`
        SELECT status FROM payment_records WHERE id = ${result.paymentRecordId}
      `;
      const status = record?.status;
      if (status === 'failed' || status === 'cancelled') await setFeeState(id, 'failed');
      else if (status != null && status !== 'pending') await setFeeState(id, 'charged');
    }
  } catch (err) {
    deps.logger.warn({ err, reservationId: id }, 'No-show fee settle failed; retried next run');
  }
}

/**
 * Settles every `due` no-show fee (the expiry cron, each minute): the fee a
 * crash left between the expiry and the charge (G10). A fee still `due` after
 * NO_SHOW_FEE_SETTLE_MAX_HOURS is marked `failed` and logged.
 */
export async function settleDueNoShowFees(
  deps: ReservationExpiryDeps,
  limit = 100,
): Promise<number> {
  const stale = await client<Array<{ id: string }>>`
    UPDATE reservations SET no_show_fee_state = 'failed', updated_at = now()
    WHERE no_show_fee_state = 'due'
      AND updated_at < now() - make_interval(hours => ${NO_SHOW_FEE_SETTLE_MAX_HOURS})
    RETURNING id
  `;
  for (const row of stale) {
    deps.logger.warn(
      { reservationId: row.id },
      'No-show fee unsettled for 24 hours; marked failed, check its payment record',
    );
    // The reservation insights read fee_failed rows (G17).
    await writeReservationAudit(
      {
        reservationId: row.id,
        action: 'fee_failed',
        actor: 'system',
        reason: 'provider_error',
        notes: `no-show fee unsettled for ${String(NO_SHOW_FEE_SETTLE_MAX_HOURS)} hours`,
      },
      undefined,
      deps.logger,
    );
  }
  const due = await client<Array<{ id: string }>>`
    SELECT id FROM reservations WHERE no_show_fee_state = 'due'
    ORDER BY updated_at LIMIT ${limit}
  `;
  for (const row of due) await settleNoShowFee(deps, row.id);
  return due.length;
}

export interface StationOutageInput {
  stationUuid: string;
  stationOcppId: string;
  siteId: string | null;
  /** The station went offline, or reported a fault. */
  cause: 'offline' | 'faulted';
  /** Only the holds of this EVSE (a connector fault); null for the whole station. */
  evseUuid?: string | null | undefined;
}

/**
 * The station went offline or faulted during a hold (G16, decision E12): its
 * active holds are cancelled as system (`station_unavailable_during_hold`, a
 * `station_faulted` audit row, no fee), the driver is told why, and the
 * station gets CancelReservation (queued until it reconnects when offline).
 * A hold already in use stays: its driver is charging.
 */
export async function cancelHoldsForStationOutage(
  deps: ReservationExpiryDeps,
  input: StationOutageInput,
): Promise<number> {
  const rows =
    input.evseUuid != null
      ? await client<Array<HoldRow>>`
          SELECT id, reservation_id, driver_id, starts_at, created_at FROM reservations
          WHERE station_id = ${input.stationUuid} AND status = 'active'
            AND evse_id = ${input.evseUuid}
        `
      : await client<Array<HoldRow>>`
          SELECT id, reservation_id, driver_id, starts_at, created_at FROM reservations
          WHERE station_id = ${input.stationUuid} AND status = 'active'
        `;
  let cancelled = 0;
  for (const row of rows) {
    try {
      const result = await applyReservationCancellation({
        reservationDbId: row.id,
        siteId: input.siteId,
        driverId: row.driver_id,
        startsAt: toDateOrNull(row.starts_at) ?? toDate(row.created_at as Date | string),
        createdAt: toDate(row.created_at as Date | string),
        actor: 'system',
        reason: 'station_unavailable_during_hold',
        auditAction: 'station_faulted',
        note: input.cause === 'offline' ? 'station offline' : 'station faulted',
        chargeFee: false,
        pubsub: deps.pubsub,
        logger: deps.logger,
      });
      if (!result.cancelled) continue;
      cancelled++;
      await publishCancelReservation(
        deps.pubsub,
        input.stationOcppId,
        row.reservation_id,
        deps.logger,
      );
      await notifyReservationDriver(
        'reservation.Cancelled',
        {
          reservationDbId: row.id,
          reservationOcppId: row.reservation_id,
          stationOcppId: input.stationOcppId,
          driverId: row.driver_id,
        },
        {
          cancellationFeeFormatted: '',
          ...cancelReasonNoticeFlags('station_unavailable_during_hold'),
        },
        deps,
      );
    } catch (err) {
      deps.logger.warn(
        { err, reservationId: row.id, stationId: input.stationOcppId },
        'Cancelling a hold of an unavailable station failed',
      );
    }
  }
  return cancelled;
}

type HoldRow = {
  id: string;
  reservation_id: number;
  driver_id: string | null;
  starts_at: RawTimestamp;
  created_at: RawTimestamp;
};
