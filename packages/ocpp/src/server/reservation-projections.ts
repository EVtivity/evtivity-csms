// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DomainEvent } from '@evtivity/lib';
import { toDate, toDateOrNull, writeReservationAudit } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import { withPaymentActor } from '@evtivity/payments';
import { refreshFleetReservationStatuses } from '@evtivity/services/fleet-reservation-status';
import { applyReservationCancellation } from '@evtivity/services/reservation-cancel';
import type { ReservationCancelReason } from '@evtivity/services/reservation-cancel';
import {
  cancelHoldsForStationOutage,
  expireStationReportedReservation,
} from '@evtivity/services/reservation-expiry';
import type { ReservationExpiryDeps } from '@evtivity/services/reservation-expiry';
import {
  cancelReasonNoticeFlags,
  notifyReservationDriver,
} from '@evtivity/services/reservation-notify';
import {
  reserveNowMatchesStoredHold,
  resendStoredHold,
} from '@evtivity/services/reservation.service';
import type { ProjectionDeps } from './projection-support/context.js';
import type { ProjectionAttempt } from './projection-retry.js';
import { ALL_TEMPLATES_DIRS } from './notification-dispatcher.js';

/**
 * The reservation projections of the OCPP process (v0.1.45 G5, G9, G12, G13,
 * G16, G17): the ReserveNow answer, the station's ReservationStatusUpdate, a
 * station outage during a hold, and the session link at Started and Ended.
 * Every reservation write of the OCPP process lives here or in the shared
 * services it calls (`@evtivity/services/reservation-*`), which audit, publish
 * `reservation.changed` and notify the driver once per winning change.
 */

/** The shared reservation services' dependencies, from the projection deps. */
function expiryDeps(deps: ProjectionDeps): ReservationExpiryDeps {
  return {
    pubsub: deps.pubsub,
    payments: withPaymentActor(deps.payments, {
      actor: 'ocpp',
      actorLabel: 'reservation-projection',
    }),
    logger: deps.logger,
    templatesDirs: ALL_TEMPLATES_DIRS,
  };
}

function noticeOptions(deps: ProjectionDeps) {
  return { pubsub: deps.pubsub, templatesDirs: ALL_TEMPLATES_DIRS, logger: deps.logger };
}

/** The OCPP reservation id of a ReserveNow request (2.1 `id`, 1.6 `reservationId`). */
function reserveNowOcppId(request: Record<string, unknown>): number | null {
  if (typeof request['id'] === 'number') return request['id'];
  if (typeof request['reservationId'] === 'number') return request['reservationId'];
  return null;
}

// Raw rows: timestamps arrive as postgres text (database.md).
type UnackedHoldRow = {
  id: string;
  driver_id: string | null;
  starts_at: RawTimestamp;
  created_at: RawTimestamp;
  expires_at: RawTimestamp;
};

/**
 * `command.ReserveNow`: the station's answer to a ReserveNow (G5, G17).
 * Accepted records `station_ack_at` on the live hold that has none, so the
 * no-show fee can apply. Any other answer cancels the hold as system, but
 * only a hold the station never accepted: an edit re-sent with the same id
 * that the station refuses keeps its earlier hold. The cancel writes the
 * `station_rejected` audit row and the `reservation.changed` SSE, and the
 * driver is told (no fee).
 *
 * The worker builds the payload in the 2.1 shape and the command listener
 * translates it to 1.6 on the wire; the event keeps the 2.1 form, so `id` is
 * the OCPP reservation id.
 */
export async function projectReserveNowResult(
  deps: ProjectionDeps,
  event: DomainEvent,
): Promise<void> {
  const { sql, logger, lookups } = deps;
  const request = event.payload.request as Record<string, unknown>;
  const response = event.payload.response as Record<string, unknown> | undefined;
  const status = response != null ? (response['status'] as string | undefined) : undefined;
  if (status == null) return;
  const reservationOcppId = reserveNowOcppId(request);
  if (reservationOcppId == null) return;
  const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
  if (stationUuid == null) return;

  if (status === 'Accepted') {
    const acked = await sql<Array<{ id: string }>>`
      UPDATE reservations SET station_ack_at = now(), updated_at = now()
      WHERE station_id = ${stationUuid} AND reservation_id = ${reservationOcppId}
        AND status = 'active' AND station_ack_at IS NULL
      RETURNING id
    `;
    if (acked.length > 0) return;
    // An accepted hold answering again: an edit re-send. A late Accepted of an
    // edit the database already rolled back leaves the station holding the
    // edit's values, so it gets the stored ones again (the create path's G3).
    const [held] = await sql<Array<{ id: string }>>`
      SELECT id FROM reservations
      WHERE station_id = ${stationUuid} AND reservation_id = ${reservationOcppId}
        AND status = 'active' AND station_ack_at IS NOT NULL
      LIMIT 1
    `;
    if (held != null && !(await reserveNowMatchesStoredHold(held.id, request))) {
      await resendStoredHold(held.id, {
        stationOcppId: event.aggregateId,
        cause: 'a late Accepted of an edit the database rolled back',
        pubsub: deps.pubsub,
        logger,
      });
    }
    return;
  }

  const [row] = await sql<UnackedHoldRow[]>`
    SELECT id, driver_id, starts_at, created_at, expires_at FROM reservations
    WHERE station_id = ${stationUuid} AND reservation_id = ${reservationOcppId}
      AND status IN ('active', 'scheduled') AND station_ack_at IS NULL
    LIMIT 1
  `;
  if (row == null) return;
  const reason: ReservationCancelReason =
    status === 'Occupied' ? 'station_rejected_occupied' : 'station_rejected_other';
  const createdAt = toDate(row.created_at as Date | string);
  const result = await applyReservationCancellation({
    reservationDbId: row.id,
    siteId: await lookups.resolveSiteId(stationUuid),
    driverId: row.driver_id,
    startsAt: toDateOrNull(row.starts_at) ?? createdAt,
    createdAt,
    actor: 'system',
    reason,
    auditAction: 'station_rejected',
    chargeFee: false,
    pubsub: deps.pubsub,
    logger,
  });
  if (!result.cancelled) return;
  logger.warn(
    { stationId: event.aggregateId, reservationOcppId, status, cancelReason: reason },
    'Station rejected ReserveNow; reservation cancelled',
  );
  await notifyReservationDriver(
    'reservation.Cancelled',
    {
      reservationDbId: row.id,
      reservationOcppId,
      stationOcppId: event.aggregateId,
      driverId: row.driver_id,
      expiresAt: toDateOrNull(row.expires_at),
    },
    { cancellationFeeFormatted: '', ...cancelReasonNoticeFlags(reason) },
    noticeOptions(deps),
  );
}

/**
 * `ocpp.ReservationStatusUpdate` (G9). `Expired`: the shared expiry of the
 * reporting station's live hold, never an `in_use` one, with the no-show fee
 * and the driver notice once. `Removed`: a system cancel of the reporting
 * station's hold (`system_cleanup`, no fee) and the driver notice.
 */
export async function projectReservationStatusUpdate(
  deps: ProjectionDeps,
  event: DomainEvent,
): Promise<void> {
  const { sql, logger, lookups } = deps;
  const reservationOcppId = event.payload.reservationId as number;
  const updateStatus = event.payload.reservationUpdateStatus as string;
  if (updateStatus !== 'Expired' && updateStatus !== 'Removed') return;
  const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
  if (stationUuid == null) return;

  if (updateStatus === 'Expired') {
    await expireStationReportedReservation(expiryDeps(deps), { stationUuid, reservationOcppId });
    return;
  }

  const [row] = await sql<UnackedHoldRow[]>`
    SELECT id, driver_id, starts_at, created_at, expires_at FROM reservations
    WHERE station_id = ${stationUuid} AND reservation_id = ${reservationOcppId}
      AND status IN ('active', 'scheduled')
    LIMIT 1
  `;
  if (row == null) return;
  const createdAt = toDate(row.created_at as Date | string);
  const result = await applyReservationCancellation({
    reservationDbId: row.id,
    siteId: await lookups.resolveSiteId(stationUuid),
    driverId: row.driver_id,
    startsAt: toDateOrNull(row.starts_at) ?? createdAt,
    createdAt,
    actor: 'system',
    reason: 'system_cleanup',
    note: 'station-reported removal',
    chargeFee: false,
    pubsub: deps.pubsub,
    logger,
  });
  if (!result.cancelled) return;
  await notifyReservationDriver(
    'reservation.Cancelled',
    {
      reservationDbId: row.id,
      reservationOcppId,
      stationOcppId: event.aggregateId,
      driverId: row.driver_id,
      expiresAt: toDateOrNull(row.expires_at),
    },
    { cancellationFeeFormatted: '' },
    noticeOptions(deps),
  );
}

export interface StationOutageHolds {
  stationUuid: string;
  stationOcppId: string;
  cause: 'offline' | 'faulted';
  /** The faulted EVSE; null or absent for the whole station. */
  evseUuid?: string | null | undefined;
}

type InUseHoldRow = {
  id: string;
  reservation_id: number;
  driver_id: string | null;
  expires_at: RawTimestamp;
};

/**
 * A station went offline, or an EVSE faulted, during a hold (G16, decision
 * E12). A driver charging on an `in_use` hold of an offline station gets
 * `reservation.StationFaulted`. Every `active` hold of the station (or of the
 * faulted EVSE) is cancelled as system with `station_unavailable_during_hold`,
 * no fee, and its driver is told why (`cancelHoldsForStationOutage`).
 */
export async function projectStationOutageHolds(
  deps: ProjectionDeps,
  input: StationOutageHolds,
): Promise<void> {
  const { sql, logger, lookups } = deps;
  if (input.cause === 'offline') {
    try {
      const inUse = await sql<InUseHoldRow[]>`
        SELECT id, reservation_id, driver_id, expires_at FROM reservations
        WHERE station_id = ${input.stationUuid} AND status = 'in_use'
      `;
      for (const row of inUse) {
        await notifyReservationDriver(
          'reservation.StationFaulted',
          {
            reservationDbId: row.id,
            reservationOcppId: row.reservation_id,
            stationOcppId: input.stationOcppId,
            driverId: row.driver_id,
            expiresAt: toDateOrNull(row.expires_at),
          },
          {},
          noticeOptions(deps),
        );
      }
    } catch (err) {
      logger.warn(
        { err, stationId: input.stationOcppId },
        'In-use reservation notice of an offline station failed',
      );
    }
  }
  await cancelHoldsForStationOutage(expiryDeps(deps), {
    stationUuid: input.stationUuid,
    stationOcppId: input.stationOcppId,
    siteId: await lookups.resolveSiteId(input.stationUuid),
    cause: input.cause,
    evseUuid: input.evseUuid ?? null,
  });
}

export interface StartedReservationInput {
  sessionId: string;
  stationUuid: string;
  stationOcppId: string;
  /** The reservation id the station echoed in the Started event, if any. */
  ocppReservationId: number | null;
  /** The idToken that started the session, if any. */
  idToken: string | null;
  /**
   * The Started projection's run, when it is retried on a lost connection: the
   * hold's status write keeps its first result (`memo`) and its audit row,
   * SSE and driver notice run once, so a rerun after the write committed
   * still writes them.
   */
  attempt?: ProjectionAttempt;
}

function memoStep<T>(attempt: ProjectionAttempt | undefined, key: string, step: () => Promise<T>) {
  return attempt != null ? attempt.memo(key, step) : step();
}

function onceStep<T>(attempt: ProjectionAttempt | undefined, key: string, step: () => Promise<T>) {
  return attempt != null ? attempt.once(key, step) : step();
}

type StartedCandidateRow = {
  id: string;
  reservation_id: number;
  driver_id: string | null;
  token_id: string | null;
  evse_id: string | null;
  status: string;
  expires_at: RawTimestamp;
  session_driver_id: string | null;
  session_token_id: string | null;
  session_evse_id: string | null;
  session_reservation_id: string | null;
  id_token_id: string | null;
  id_token_driver_id: string | null;
};

/**
 * Whether the session's starter holds the reservation: the session's driver
 * (or the idToken's driver) is the reservation's driver, or the session's
 * token (or the idToken's token) is the reservation's token. The idToken
 * lookup covers a free vend session, whose driver is not resolved.
 */
function isHolder(row: StartedCandidateRow): boolean {
  const drivers = [row.session_driver_id, row.id_token_driver_id].filter((d) => d != null);
  const tokens = [row.session_token_id, row.id_token_id].filter((t) => t != null);
  return (
    (row.driver_id != null && drivers.includes(row.driver_id)) ||
    (row.token_id != null && tokens.includes(row.token_id))
  );
}

/** A reservation with a driver that the starter is not: a start by someone else. */
function isNonHolder(row: StartedCandidateRow): boolean {
  return row.driver_id != null && !isHolder(row);
}

/**
 * Links a started session to its reservation (G12, G13). The candidates are
 * the reservation the session is already linked to (a rerun, or a remote
 * start the activation linked), then:
 *
 * - the reservation id the station echoed, while `active`: its holder (same
 *   driver or token), or a starter the CSMS cannot resolve to a driver, links
 *   it; a starter resolved to another driver takes it and does not link;
 * - without an echoed id, an `active` hold on the station whose EVSE is the
 *   session's EVSE (or none) and whose window contains now: its holder links
 *   it; a start by someone else takes only a hold of the session's EVSE (a
 *   station-wide hold is not taken by a start on another EVSE).
 *
 * Linking moves `active -> in_use` (audit `used`). A taken hold stays
 * `active`, its no-show fee is waived (decision E13), audit `taken_by_other`,
 * and its holder is told. Returns the linked reservation's row id.
 */
export async function linkStartedReservation(
  deps: ProjectionDeps,
  input: StartedReservationInput,
): Promise<string | null> {
  const { sql } = deps;
  const { sessionId, stationUuid, ocppReservationId, idToken } = input;
  const candidates =
    ocppReservationId != null
      ? await sql<StartedCandidateRow[]>`
          SELECT r.id, r.reservation_id, r.driver_id, r.token_id, r.evse_id, r.status, r.expires_at,
                 cs.driver_id AS session_driver_id, cs.token_id AS session_token_id,
                 cs.evse_id AS session_evse_id, cs.reservation_id AS session_reservation_id,
                 dt.id AS id_token_id, dt.driver_id AS id_token_driver_id
          FROM charging_sessions cs
          JOIN reservations r ON r.station_id = cs.station_id
          LEFT JOIN LATERAL (
            SELECT id, driver_id FROM driver_tokens
            WHERE id_token = ${idToken} AND is_active = true LIMIT 1
          ) dt ON true
          WHERE cs.id = ${sessionId} AND cs.station_id = ${stationUuid}
            AND r.reservation_id = ${ocppReservationId}
            AND (r.status = 'active' OR r.id = cs.reservation_id)
          ORDER BY (r.id = cs.reservation_id) DESC NULLS LAST
          LIMIT 1
        `
      : await sql<StartedCandidateRow[]>`
          SELECT r.id, r.reservation_id, r.driver_id, r.token_id, r.evse_id, r.status, r.expires_at,
                 cs.driver_id AS session_driver_id, cs.token_id AS session_token_id,
                 cs.evse_id AS session_evse_id, cs.reservation_id AS session_reservation_id,
                 dt.id AS id_token_id, dt.driver_id AS id_token_driver_id
          FROM charging_sessions cs
          JOIN reservations r ON r.station_id = cs.station_id
          LEFT JOIN LATERAL (
            SELECT id, driver_id FROM driver_tokens
            WHERE id_token = ${idToken} AND is_active = true LIMIT 1
          ) dt ON true
          WHERE cs.id = ${sessionId} AND cs.station_id = ${stationUuid}
            AND (
              r.id = cs.reservation_id
              OR (
                r.status = 'active'
                AND (r.evse_id = cs.evse_id OR r.evse_id IS NULL)
                AND (r.starts_at IS NULL OR r.starts_at <= now())
                AND r.expires_at > now()
              )
            )
          ORDER BY (r.id = cs.reservation_id) DESC NULLS LAST, (r.evse_id IS NULL) ASC,
                   r.expires_at ASC
        `;

  const linked = candidates.find((r) => r.id === r.session_reservation_id);
  if (linked != null) {
    await linkReservation(deps, input, linked);
    return linked.id;
  }
  if (ocppReservationId != null) {
    const echoed = candidates[0];
    if (echoed == null) return null;
    // The station enforced the hold before echoing its id (OCPP H01), so
    // only a starter resolved to another driver takes it; an unresolved one
    // (roaming, guest, a token the CSMS does not know) links it.
    const starterResolved = echoed.session_driver_id != null || echoed.id_token_driver_id != null;
    if (starterResolved && isNonHolder(echoed)) {
      await markTakenByOther(deps, input, echoed);
      return null;
    }
    await linkReservation(deps, input, echoed);
    return echoed.id;
  }
  const held = candidates.find(isHolder);
  if (held != null) {
    await linkReservation(deps, input, held);
    return held.id;
  }
  for (const row of candidates) {
    if (row.evse_id != null && row.evse_id === row.session_evse_id && isNonHolder(row)) {
      await markTakenByOther(deps, input, row);
    }
  }
  return null;
}

/**
 * Links the session to the reservation and moves the hold `active -> in_use`
 * (one guarded writer audits). A holder who started with another of their
 * cards keeps the `reservationTokenMismatch` marker on the session.
 */
async function linkReservation(
  deps: ProjectionDeps,
  input: StartedReservationInput,
  row: StartedCandidateRow,
): Promise<void> {
  const { sql, logger, lookups, notify } = deps;
  const { sessionId, stationUuid, attempt } = input;
  await sql`
    UPDATE charging_sessions SET reservation_id = ${row.id}, updated_at = now()
    WHERE id = ${sessionId}
  `;
  // A rerun whose first run lost the answer of this write (it may have
  // committed) also takes an `in_use` hold this session is linked to as moved:
  // the first run wrote no audit row for it. The link above is this session's,
  // and only this write moves a hold to `in_use`.
  const rerun = attempt != null && attempt.number > 1;
  const moved = await memoStep(attempt, 'started:reservation-in-use', () =>
    sql<Array<{ id: string; fleet_reservation_id: string | null }>>`
      UPDATE reservations SET status = 'in_use', updated_at = now()
      WHERE id = ${row.id} AND (status = 'active' OR (${rerun}::boolean AND status = 'in_use'))
      RETURNING id, fleet_reservation_id
    `.then((rows) => rows.map((r) => ({ id: r.id, fleet_reservation_id: r.fleet_reservation_id }))),
  );
  if (moved.length > 0) {
    await refreshFleetReservationStatuses(
      moved.map((m) => m.fleet_reservation_id),
      logger,
    );
    await onceStep(attempt, 'started:reservation-used-audit', () =>
      writeReservationAudit(
        {
          reservationId: row.id,
          action: 'used',
          actor: 'system',
          driverIdBefore: row.driver_id,
          driverIdAfter: row.driver_id,
          statusBefore: 'active',
          statusAfter: 'in_use',
          notes: `session ${sessionId}`,
        },
        undefined,
        logger,
      ),
    );
    const siteId = await lookups.resolveSiteId(stationUuid);
    await onceStep(attempt, 'started:reservation-used-changed', () =>
      notify.notifyChange('reservation.changed', stationUuid, siteId, sessionId),
    );
  }

  // A reservation bound to a token, started with another token of its
  // driver: logged and marked on the session, never blocked (the
  // transaction is already underway).
  if (row.token_id != null && row.session_token_id !== row.token_id) {
    logger.warn(
      {
        sessionId,
        reservationUuid: row.id,
        expectedTokenId: row.token_id,
        actualTokenId: row.session_token_id,
      },
      'Reservation fulfilled by different token than reserved',
    );
    await sql`
      UPDATE charging_sessions
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'reservationTokenMismatch', jsonb_build_object(
          'expected', ${row.token_id}::text,
          'actual', ${row.session_token_id}::text
        )
      ),
      updated_at = now()
      WHERE id = ${sessionId}
    `;
  }
}

/**
 * Another driver started on the reserved EVSE (G13, decision E13): the hold
 * stays `active` and unlinked, its no-show fee is waived, audit
 * `taken_by_other`, and the holder is told. The waiver is the one-winner
 * guard, so a rerun or a resent Started audits and notifies once.
 */
async function markTakenByOther(
  deps: ProjectionDeps,
  input: StartedReservationInput,
  row: StartedCandidateRow,
): Promise<void> {
  const { sql, logger, lookups, notify } = deps;
  const { sessionId, stationUuid, attempt } = input;
  // Memoized: a rerun after a later step lost its connection keeps the waiver
  // and still writes the audit row and tells the holder, once each.
  const waived = await memoStep(attempt, `started:reservation-taken:${row.id}`, () =>
    sql<Array<{ id: string }>>`
      UPDATE reservations SET no_show_fee_state = 'waived', updated_at = now()
      WHERE id = ${row.id} AND status = 'active' AND no_show_fee_state = 'none'
      RETURNING id
    `.then((rows) => rows.map((r) => r.id)),
  );
  if (waived.length === 0) return;
  logger.info(
    { sessionId, reservationUuid: row.id, stationId: input.stationOcppId },
    'Reserved EVSE taken by another driver; no-show fee waived',
  );
  await onceStep(attempt, `started:reservation-taken-audit:${row.id}`, () =>
    writeReservationAudit(
      {
        reservationId: row.id,
        action: 'taken_by_other',
        actor: 'system',
        driverIdBefore: row.driver_id,
        driverIdAfter: row.driver_id,
        statusBefore: 'active',
        statusAfter: 'active',
        notes: `session ${sessionId}`,
      },
      undefined,
      logger,
    ),
  );
  const siteId = await lookups.resolveSiteId(stationUuid);
  await onceStep(attempt, `started:reservation-taken-changed:${row.id}`, () =>
    notify.notifyChange('reservation.changed', stationUuid, siteId, sessionId),
  );
  await onceStep(attempt, `started:reservation-taken-notice:${row.id}`, () =>
    notifyReservationDriver(
      'reservation.TakenByOther',
      {
        reservationDbId: row.id,
        reservationOcppId: row.reservation_id,
        stationOcppId: input.stationOcppId,
        driverId: row.driver_id,
        expiresAt: toDateOrNull(row.expires_at),
      },
      {},
      noticeOptions(deps),
    ),
  );
}

/**
 * The session of an `in_use` hold ended (G17): `in_use -> used`, audited by
 * the one guarded writer, then `reservation.changed`.
 */
export async function markReservationUsed(
  deps: ProjectionDeps,
  input: { reservationDbId: string; sessionId: string; stationUuid: string; siteId: string | null },
): Promise<void> {
  const { sql, logger, notify } = deps;
  const used = await sql<Array<{ driver_id: string | null; fleet_reservation_id: string | null }>>`
    UPDATE reservations SET status = 'used', updated_at = now()
    WHERE id = ${input.reservationDbId} AND status = 'in_use'
    RETURNING driver_id, fleet_reservation_id
  `;
  const row = used[0];
  if (row == null) return;
  await refreshFleetReservationStatuses([row.fleet_reservation_id], logger);
  await writeReservationAudit(
    {
      reservationId: input.reservationDbId,
      action: 'used',
      actor: 'system',
      driverIdBefore: row.driver_id,
      driverIdAfter: row.driver_id,
      statusBefore: 'in_use',
      statusAfter: 'used',
      notes: `session ${input.sessionId}`,
    },
    undefined,
    logger,
  );
  await notify.notifyChange(
    'reservation.changed',
    input.stationUuid,
    input.siteId,
    input.sessionId,
  );
}
