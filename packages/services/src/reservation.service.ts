// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  chargingStations,
  connectors,
  db,
  driverPaymentMethods,
  drivers,
  driverTokens,
  evses,
  fleetDrivers,
  getReservationSettings,
  isStationLevelUnavailable,
  reservations,
  sites,
  snapshotReservationFeeTerms,
  writeReservationAudit,
} from '@evtivity/database';
import { AppError, publishOcppCommand } from '@evtivity/lib';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { assertNoMaintenanceConflict } from './maintenance-check.js';
import { sendOcppCommandAndWait } from './ocpp-command.js';
import type { CommandResult } from './ocpp-command.js';
import { applyReservationCancellation } from './reservation-cancel.js';
import type {
  ReservationCancelInput,
  ReservationCancelReason,
  ReservationCancelResult,
} from './reservation-cancel.js';
import { cancelReasonNoticeFlags, notifyReservationDriver } from './reservation-notify.js';

/**
 * The single writer of reservation creates, edits and reassigns (P3, v0.1.45
 * G1, G2, G3, G4, G14, G15). Cancels go through `applyReservationCancellation`
 * (`cancelReservationWithStation` adds the station side), expiry through
 * `reservation-expiry.ts`. Routes call these and never write `reservations`.
 */

export type ReservationRow = typeof reservations.$inferSelect;

/** The station fields every reservation check reads. */
export interface ReservationStation {
  id: string;
  stationId: string;
  siteId: string | null;
  isOnline: boolean;
  reservationsEnabled: boolean;
  disabledReason: string | null;
  firmwareState: string | null;
  reportedStatus: string | null;
}

export type ReservationActor =
  | { kind: 'operator'; userId: string }
  | { kind: 'driver'; driverId: string };

/** The shortest reservation, and the slack for a start or an end close to now. */
export const RESERVATION_MIN_DURATION_MS = 60_000;

function auditActor(actor: ReservationActor): {
  actor: 'operator' | 'driver';
  actorUserId: string | null;
  actorDriverId: string | null;
} {
  return actor.kind === 'operator'
    ? { actor: 'operator', actorUserId: actor.userId, actorDriverId: null }
    : { actor: 'driver', actorUserId: null, actorDriverId: actor.driverId };
}

function publishReservationChanged(
  pubsub: PubSubClient,
  stationUuid: string | null,
  siteId: string | null,
  logger?: ServiceLogger,
): void {
  void pubsub
    .publish(
      'csms_events',
      JSON.stringify({
        eventType: 'reservation.changed',
        stationId: stationUuid,
        siteId,
        sessionId: null,
      }),
    )
    .catch((err: unknown) => {
      // fail-open: the Reservations page refreshes on its next fetch (P9).
      logger?.warn({ err }, 'reservation.changed publish failed');
    });
}

/**
 * System-wide, site and station reservation switches, and the station-level
 * availability the start gate applies. Every create and reassign runs it.
 */
export async function assertReservationsAllowed(
  station: Pick<
    ReservationStation,
    'reservationsEnabled' | 'siteId' | 'disabledReason' | 'firmwareState' | 'reportedStatus'
  >,
): Promise<void> {
  const config = await getReservationSettings();
  if (!config.enabled) {
    throw new AppError('Reservations are disabled system-wide', 403, 'RESERVATION_DISABLED');
  }
  if (station.siteId != null) {
    const [site] = await db
      .select({ reservationsEnabled: sites.reservationsEnabled })
      .from(sites)
      .where(eq(sites.id, station.siteId));
    if (site != null && !site.reservationsEnabled) {
      throw new AppError('Reservations are disabled for this site', 403, 'RESERVATION_DISABLED');
    }
  }
  if (!station.reservationsEnabled) {
    throw new AppError('Reservations are disabled for this station', 403, 'RESERVATION_DISABLED');
  }
  if (isStationLevelUnavailable(station)) {
    throw new AppError('Station is unavailable', 409, 'STATION_UNAVAILABLE');
  }
}

/**
 * The reservation window rules of create and edit: at least 60 seconds long,
 * an explicit start not in the past (60 seconds slack for form drift), an end
 * at least 60 seconds ahead, and no longer than `reservation.maxHours`.
 */
export async function assertReservationWindow(window: {
  startsAt: Date | null;
  /** The start of a reservation without startsAt (now, or its creation). */
  effectiveStart: Date;
  expiresAt: Date;
  /** Edits of an active reservation keep their start; only creates check it. */
  checkStartInPast: boolean;
}): Promise<void> {
  const start = window.effectiveStart.getTime();
  const end = window.expiresAt.getTime();
  const now = Date.now();
  if (end - start < RESERVATION_MIN_DURATION_MS) {
    throw new AppError(
      'Reservation must end at least 60 seconds after it starts',
      400,
      'RESERVATION_WINDOW_TOO_SHORT',
    );
  }
  if (
    window.checkStartInPast &&
    window.startsAt != null &&
    window.startsAt.getTime() < now - RESERVATION_MIN_DURATION_MS
  ) {
    throw new AppError(
      'Reservation start time cannot be in the past',
      400,
      'RESERVATION_STARTS_IN_PAST',
    );
  }
  if (end - now < RESERVATION_MIN_DURATION_MS) {
    throw new AppError(
      'Reservation must end at least 60 seconds in the future',
      400,
      'RESERVATION_EXPIRES_TOO_SOON',
    );
  }
  const { maxHours } = await getReservationSettings();
  const maxMs = maxHours * 3_600_000;
  if (maxMs > 0 && end - start > maxMs) {
    throw new AppError(
      `Reservation cannot exceed ${String(maxHours)} hours`,
      400,
      'RESERVATION_TOO_LONG',
    );
  }
}

/** The EVSE row id of an OCPP EVSE number on the station (404 when unknown). */
async function resolveEvse(stationUuid: string, evseOcppId: number | null | undefined) {
  if (evseOcppId == null) return null;
  const [evse] = await db
    .select({ id: evses.id })
    .from(evses)
    .where(and(eq(evses.stationId, stationUuid), eq(evses.evseId, evseOcppId)));
  if (evse == null) throw new AppError('EVSE not found', 404, 'EVSE_NOT_FOUND');
  return evse.id;
}

/**
 * Refuses a reservation that starts within `reservation.activeSessionCheckHours`
 * on an EVSE (or, station-wide, a station) whose connector is not Available:
 * OCPP ReserveNow needs an Available connector, and a plugged cable answers
 * Occupied. Later starts are checked again at activation.
 */
async function assertEvseFree(
  stationUuid: string,
  evseUuid: string | null,
  start: Date,
): Promise<void> {
  const { activeSessionCheckHours } = await getReservationSettings();
  const checkMs = activeSessionCheckHours * 3_600_000;
  if (checkMs <= 0 || start.getTime() - Date.now() >= checkMs) return;
  const conditions = [eq(evses.stationId, stationUuid), sql`${connectors.status} <> 'available'`];
  if (evseUuid != null) conditions.push(eq(evses.id, evseUuid));
  const [busy] = await db
    .select({ status: connectors.status })
    .from(connectors)
    .innerJoin(evses, eq(connectors.evseId, evses.id))
    .where(and(...conditions))
    .limit(1);
  if (busy != null) {
    throw new AppError(
      evseUuid != null
        ? `EVSE is not available (connector status: ${busy.status})`
        : `Station has no available connector (status: ${busy.status})`,
      409,
      'EVSE_IN_USE',
    );
  }
}

async function assertDriverCanReserve(driverId: string, fleetId: string | null): Promise<void> {
  const [driver] = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) throw new AppError('Driver not found', 400, 'DRIVER_NOT_FOUND');
  if (fleetId != null) {
    const [member] = await db
      .select({ id: fleetDrivers.id })
      .from(fleetDrivers)
      .where(and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, driverId)))
      .limit(1);
    if (member == null) {
      throw new AppError('Driver is not a member of this fleet', 400, 'VALIDATION_ERROR');
    }
  }
  // A no-show or cancellation fee needs a card on file.
  const [pm] = await db
    .select({ id: driverPaymentMethods.id })
    .from(driverPaymentMethods)
    .where(
      and(eq(driverPaymentMethods.driverId, driverId), eq(driverPaymentMethods.isDefault, true)),
    )
    .limit(1);
  if (pm == null) {
    throw new AppError('Driver has no default payment method', 400, 'PAYMENT_METHOD_REQUIRED');
  }
}

/**
 * The token a reservation is bound to: an explicit one must belong to the
 * driver; without one, the driver's most recently used active token, so the
 * station can match the card the driver taps (G2, E14). Null when the driver
 * has no token.
 */
async function resolveBoundToken(
  driverId: string | null,
  tokenId: string | null | undefined,
): Promise<string | null> {
  if (tokenId != null) {
    if (driverId == null) throw new AppError('tokenId requires driverId', 400, 'VALIDATION_ERROR');
    const [token] = await db
      .select({ id: driverTokens.id, driverId: driverTokens.driverId })
      .from(driverTokens)
      .where(eq(driverTokens.id, tokenId))
      .limit(1);
    if (token == null || token.driverId !== driverId) {
      throw new AppError('tokenId does not belong to driver', 400, 'VALIDATION_ERROR');
    }
    return token.id;
  }
  if (driverId == null || tokenId === null) return null;
  const [latest] = await db
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(eq(driverTokens.driverId, driverId), eq(driverTokens.isActive, true)))
    .orderBy(desc(driverTokens.updatedAt))
    .limit(1);
  return latest?.id ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serializes reservation writes per station (E15): conflict check and write in one lock. */
async function lockStation(tx: Tx, stationUuid: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`reservation:${stationUuid}`}))`);
}

/**
 * Live reservations of the station whose window overlaps [start, end]: the
 * same EVSE or a station-wide one for an EVSE request, any for a station-wide
 * request. Scheduled ones count (G14).
 */
async function hasConflict(
  tx: Tx,
  q: { stationUuid: string; evseUuid: string | null; start: Date; end: Date; excludeId?: string },
): Promise<boolean> {
  const conditions: SQL[] = [
    eq(reservations.stationId, q.stationUuid),
    inArray(reservations.status, ['active', 'scheduled']),
    sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) < ${q.end.toISOString()}`,
    gt(reservations.expiresAt, q.start),
  ];
  if (q.evseUuid != null) {
    conditions.push(or(eq(reservations.evseId, q.evseUuid), isNull(reservations.evseId)) as SQL);
  }
  if (q.excludeId != null) conditions.push(ne(reservations.id, q.excludeId));
  const [row] = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(and(...conditions))
    .limit(1);
  return row != null;
}

const CONFLICT = (): AppError =>
  new AppError(
    'A reservation already exists for this connector during the requested window',
    409,
    'RESERVATION_CONFLICT',
  );

export interface CreateReservationInput {
  station: ReservationStation;
  evseOcppId?: number | null | undefined;
  driverId: string | null;
  /** Explicit token to bind; undefined binds the driver's latest active token. */
  tokenId?: string | null | undefined;
  startsAt?: Date | null | undefined;
  expiresAt: Date;
  actor: ReservationActor;
  /** Fleet slot: the driver must be a member, the row links the fleet reservation. */
  fleet?: { fleetId: string; fleetReservationId: string } | undefined;
  auditNotes?: string | undefined;
  pubsub?: PubSubClient | undefined;
  logger?: ServiceLogger | undefined;
}

/**
 * Creates a reservation (G1, G15): the window, online, eligibility,
 * maintenance, EVSE, busy EVSE, driver, fleet membership, payment method and
 * token checks, then the overlap check and the insert in one transaction under
 * a per-station advisory lock, so two concurrent creates cannot both pass. A
 * future start is `scheduled`, else `active`. Errors are `AppError`s with the
 * route's status and code. Send the station side with `dispatchReservation`.
 */
export async function createReservation(input: CreateReservationInput): Promise<ReservationRow> {
  const { station } = input;
  const now = new Date();
  const startsAt = input.startsAt ?? null;
  const effectiveStart = startsAt ?? now;
  const isFuture = startsAt != null && startsAt.getTime() > now.getTime();

  await assertReservationWindow({
    startsAt,
    effectiveStart,
    expiresAt: input.expiresAt,
    checkStartInPast: true,
  });
  // A future start may find the station online by then.
  if (!station.isOnline && !isFuture) {
    throw new AppError('Station is offline', 400, 'STATION_OFFLINE');
  }
  await assertReservationsAllowed(station);
  await assertNoMaintenanceConflict(station.id, effectiveStart, input.expiresAt);
  const evseUuid = await resolveEvse(station.id, input.evseOcppId);
  await assertEvseFree(station.id, evseUuid, effectiveStart);
  if (input.driverId != null) {
    await assertDriverCanReserve(input.driverId, input.fleet?.fleetId ?? null);
  }
  const tokenId = await resolveBoundToken(input.driverId, input.tokenId);
  // The fee terms in effect now: a later tariff or setting edit does not
  // change what this reservation is charged.
  const feeTerms = await snapshotReservationFeeTerms({
    stationUuid: station.id,
    driverUuid: input.driverId,
  });

  const row = await db.transaction(async (tx) => {
    await lockStation(tx, station.id);
    if (
      await hasConflict(tx, {
        stationUuid: station.id,
        evseUuid,
        start: effectiveStart,
        end: input.expiresAt,
      })
    ) {
      throw CONFLICT();
    }
    const [idRow] = await tx.execute<{ next_val: string }>(
      sql`SELECT nextval('reservation_id_seq')::int AS next_val`,
    );
    const [inserted] = await tx
      .insert(reservations)
      .values({
        reservationId: Number(idRow?.next_val),
        stationId: station.id,
        evseId: evseUuid,
        driverId: input.driverId,
        tokenId,
        status: isFuture ? 'scheduled' : 'active',
        startsAt,
        expiresAt: input.expiresAt,
        fleetReservationId: input.fleet?.fleetReservationId ?? null,
        ...feeTerms,
      })
      .returning();
    if (inserted == null) {
      throw new AppError('Failed to create reservation', 500, 'RESERVATION_CREATE_FAILED');
    }
    return inserted;
  });

  // After the commit: writeAudit is fail-open, and a failed insert inside the
  // transaction would abort it, so the commit would roll back the reservation
  // without an error.
  await writeReservationAudit(
    {
      reservationId: row.id,
      action: 'created',
      ...auditActor(input.actor),
      driverIdAfter: row.driverId,
      tokenIdAfter: row.tokenId,
      evseIdAfter: row.evseId,
      statusAfter: row.status,
      expiresAtAfter: row.expiresAt,
      notes: input.auditNotes ?? null,
    },
    undefined,
    input.logger,
  );

  publishReservationChanged(input.pubsub ?? getPubSub(), station.id, station.siteId, input.logger);
  return row;
}

/** The IdToken ReserveNow carries (G2, E14). */
export interface ReserveNowToken {
  idToken: { idToken: string; type: string };
}

/**
 * The token ReserveNow carries: the bound token (`idToken` and its `type`;
 * OCPP 1.6 sends `idToken.idToken` as `idTag`), so the card the driver taps
 * matches the hold. A driver without a token gets the driver id as a
 * `Central` token (the id the portal remote start uses); a hold without a
 * driver gets `operator`. The data model has no token groups, so no
 * `groupIdToken` is sent.
 */
export async function reserveNowToken(reservation: {
  tokenId: string | null;
  driverId: string | null;
}): Promise<ReserveNowToken> {
  if (reservation.tokenId != null) {
    const [token] = await db
      .select({ idToken: driverTokens.idToken, type: driverTokens.tokenType })
      .from(driverTokens)
      .where(eq(driverTokens.id, reservation.tokenId))
      .limit(1);
    if (token != null) return { idToken: { idToken: token.idToken, type: token.type } };
  }
  return { idToken: { idToken: reservation.driverId ?? 'operator', type: 'Central' } };
}

/**
 * The ReserveNow payload of a reservation, in OCPP 2.1 form without
 * `version`: the command listener translates it for an OCPP 1.6 station
 * (reservationId, connectorId, idTag, expiryDate).
 */
export async function reserveNowPayload(reservation: {
  reservationId: number;
  expiresAt: Date;
  evseId: string | null;
  tokenId: string | null;
  driverId: string | null;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    id: reservation.reservationId,
    expiryDateTime: reservation.expiresAt.toISOString(),
    ...(await reserveNowToken(reservation)),
  };
  if (reservation.evseId != null) {
    const [evse] = await db
      .select({ evseId: evses.evseId })
      .from(evses)
      .where(eq(evses.id, reservation.evseId))
      .limit(1);
    if (evse != null) payload['evseId'] = evse.evseId;
  }
  return payload;
}

/** The station-side terms of a ReserveNow request, in OCPP 2.1 or 1.6 form. */
export interface ReserveNowTerms {
  expiresAtMs: number | null;
  /** EVSE (2.1) or connector (1.6) number; null for any (absent or 0). */
  evseId: number | null;
  idToken: string | null;
}

export function reserveNowTerms(request: Record<string, unknown>): ReserveNowTerms {
  const expiry = request['expiryDateTime'] ?? request['expiryDate'];
  const expiresAtMs = typeof expiry === 'string' ? Date.parse(expiry) : null;
  const evse = request['evseId'] ?? request['connectorId'];
  const token = request['idToken'];
  const idToken =
    token != null && typeof token === 'object'
      ? ((token as Record<string, unknown>)['idToken'] as string | undefined)
      : request['idTag'];
  return {
    expiresAtMs: expiresAtMs != null && Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    evseId: typeof evse === 'number' && evse > 0 ? evse : null,
    idToken: typeof idToken === 'string' ? idToken : null,
  };
}

function sameTerms(a: ReserveNowTerms, b: ReserveNowTerms): boolean {
  return a.expiresAtMs === b.expiresAtMs && a.evseId === b.evseId && a.idToken === b.idToken;
}

/**
 * Whether a ReserveNow the station accepted holds what the reservation row
 * stores (expiry, EVSE, token). False for a late answer to an edit the
 * database already rolled back. True when the row is gone or not active.
 */
export async function reserveNowMatchesStoredHold(
  reservationDbId: string,
  request: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'active')))
    .limit(1);
  if (row == null) return true;
  return sameTerms(reserveNowTerms(request), reserveNowTerms(await reserveNowPayload(row)));
}

/**
 * Sends the station the hold the database stores again (ReserveNow with the
 * same id replaces a reservation in OCPP 2.1 H01 and 1.6 ReserveNow), with an
 * `updated` audit row naming why. Used when an edit got no answer and was
 * rolled back, and when a late Accepted of such an edit arrives: the station
 * may hold the edit's values, the database holds the previous ones. Only an
 * `active` hold is on the station. Fail-open: logged.
 */
export async function resendStoredHold(
  reservationDbId: string,
  options: {
    stationOcppId: string;
    cause: string;
    pubsub?: PubSubClient | undefined;
    logger?: ServiceLogger | undefined;
  },
): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'active')))
      .limit(1);
    if (row == null) return false;
    await publishOcppCommand(options.pubsub ?? getPubSub(), {
      stationId: options.stationOcppId,
      action: 'ReserveNow',
      payload: await reserveNowPayload(row),
    });
    await writeReservationAudit(
      {
        reservationId: row.id,
        action: 'updated',
        actor: 'system',
        statusBefore: row.status,
        statusAfter: row.status,
        expiresAtBefore: row.expiresAt,
        expiresAtAfter: row.expiresAt,
        notes: `ReserveNow re-sent with the stored values: ${options.cause}`,
      },
      undefined,
      options.logger,
    );
    return true;
  } catch (err) {
    options.logger?.warn(
      { err, reservationId: reservationDbId },
      'Re-sending the stored reservation to the station failed',
    );
    return false;
  }
}

/** Records that the station accepted the hold (G5): a no-show fee needs it. */
export async function markStationAck(reservationDbId: string): Promise<void> {
  await db
    .update(reservations)
    .set({ stationAckAt: new Date(), updatedAt: new Date() })
    .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'active')));
}

export type DispatchOutcome =
  | { kind: 'scheduled' }
  | { kind: 'accepted' }
  /** The station answered with another status; the hold is cancelled. */
  | { kind: 'rejected'; status: string; reason: ReservationCancelReason }
  /** No answer (timeout or queued for an offline station); the hold is cancelled. */
  | { kind: 'no_response'; error: string }
  /** The command could not be sent; the hold is cancelled. */
  | { kind: 'failed'; error: string };

export interface DispatchReservationOptions {
  stationOcppId: string;
  /** The station's site, for the operator SSE of a rollback. */
  siteId: string | null;
  /** Send reservation.Created when the hold is scheduled or accepted. */
  notifyCreated: boolean;
  pubsub?: PubSubClient | undefined;
  logger?: ServiceLogger | undefined;
}

/**
 * Sends a new reservation to its station. A scheduled one goes to the worker
 * (`reservation_schedule`, a delayed activation job). An active one waits for
 * the ReserveNow answer (G4): Accepted sets `station_ack_at`; any other answer
 * or no answer cancels it as system with a `station_rejected` audit row and
 * notifies the driver, and a hold without an answer also gets a best-effort
 * CancelReservation, so a late Accepted does not leave the station holding
 * the EVSE (G3). No fee on any of these.
 */
export async function dispatchReservation(
  reservation: ReservationRow,
  options: DispatchReservationOptions,
): Promise<DispatchOutcome> {
  const pubsub = options.pubsub ?? getPubSub();
  const target = {
    reservationDbId: reservation.id,
    reservationOcppId: reservation.reservationId,
    stationOcppId: options.stationOcppId,
    driverId: reservation.driverId,
    expiresAt: reservation.expiresAt,
  };
  if (reservation.status === 'scheduled') {
    const delayMs = Math.max(0, (reservation.startsAt?.getTime() ?? Date.now()) - Date.now());
    try {
      await pubsub.publish(
        'reservation_schedule',
        JSON.stringify({ reservationDbId: reservation.id, delayMs }),
      );
    } catch (err) {
      // fail-open: the expiry cron activates scheduled rows whose start passed
      // (G6), so a lost publish delays nothing. The row is already stored.
      options.logger?.warn(
        { err, reservationId: reservation.id },
        'reservation_schedule publish failed; the expiry cron activates it at its start',
      );
    }
    if (options.notifyCreated) {
      await notifyReservationDriver('reservation.Created', target, {}, options);
    }
    return { kind: 'scheduled' };
  }

  const result = await sendOcppCommandAndWait(
    options.stationOcppId,
    'ReserveNow',
    await reserveNowPayload(reservation),
  );
  const status = result.response?.['status'] as string | undefined;
  if (result.error == null && (status == null || status === 'Accepted')) {
    await markStationAck(reservation.id);
    if (options.notifyCreated) {
      await notifyReservationDriver('reservation.Created', target, {}, options);
    }
    return { kind: 'accepted' };
  }

  const noAnswer = result.error != null && (result.queued === true || result.timedOut === true);
  // A command that never reached the station (send error) has no station
  // answer either: no_response, not a station rejection.
  const reason: ReservationCancelReason =
    result.error != null
      ? 'station_no_response'
      : status === 'Occupied'
        ? 'station_rejected_occupied'
        : 'station_rejected_other';
  const rollback = await applyReservationCancellation({
    reservationDbId: reservation.id,
    siteId: options.siteId,
    driverId: reservation.driverId,
    startsAt: reservation.startsAt ?? reservation.createdAt,
    createdAt: reservation.createdAt,
    actor: 'system',
    reason,
    auditAction: 'station_rejected',
    ...(result.error != null ? { note: result.error } : {}),
    chargeFee: false,
    pubsub,
    logger: options.logger,
  });
  if (result.error != null) {
    // A late Accepted would leave the EVSE held on the station (G3).
    await publishCancelReservation(
      pubsub,
      options.stationOcppId,
      reservation.reservationId,
      options.logger,
    );
  }
  if (rollback.cancelled) {
    await notifyReservationDriver(
      'reservation.Cancelled',
      target,
      { cancellationFeeFormatted: '', ...cancelReasonNoticeFlags(reason) },
      options,
    );
  }
  if (result.error == null) return { kind: 'rejected', status: status ?? 'Rejected', reason };
  return noAnswer
    ? { kind: 'no_response', error: result.error }
    : { kind: 'failed', error: result.error };
}

/** Best-effort CancelReservation (fire-and-forget, fail-open). */
export async function publishCancelReservation(
  pubsub: PubSubClient,
  stationOcppId: string,
  reservationOcppId: number,
  logger?: ServiceLogger,
): Promise<void> {
  try {
    await publishOcppCommand(pubsub, {
      stationId: stationOcppId,
      action: 'CancelReservation',
      payload: { reservationId: reservationOcppId },
    });
  } catch (err) {
    logger?.warn({ err, stationOcppId, reservationOcppId }, 'CancelReservation publish failed');
  }
}

/** Why a station did not confirm a CancelReservation (`station_cancel_failed` reason). */
function cancelFailureReason(
  result: CommandResult,
): 'station_offline' | 'station_rejected' | 'station_no_response' | null {
  if (result.queued === true) return 'station_offline';
  if (result.error != null) return 'station_no_response';
  const status = result.response?.['status'] as string | undefined;
  return status != null && status !== 'Accepted' ? 'station_rejected' : null;
}

export type CancelWithStationInput = ReservationCancelInput & {
  stationOcppId: string;
  reservationOcppId: number;
  /**
   * Wait for the station's answer (operator cancel, G7) and audit a refusal or
   * no answer; otherwise publish fire-and-forget.
   */
  waitForStation: boolean;
};

export type CancelWithStationResult = ReservationCancelResult & {
  /** Set when the station refused the cancel or did not answer. */
  warning?: 'station_cancel_failed';
};

/**
 * Cancels a reservation, database first (G7): `applyReservationCancellation`
 * flips the row (one winner, which audits and may charge the fee), then only
 * the winner of an `active` hold sends CancelReservation, since a scheduled
 * one never reached the station. A crash between the two leaves a cancelled,
 * unbillable row. A refused or unanswered cancel writes a
 * `station_cancel_failed` audit row and returns a warning; the row stays
 * cancelled.
 */
export async function cancelReservationWithStation(
  input: CancelWithStationInput,
): Promise<CancelWithStationResult> {
  const { stationOcppId, reservationOcppId, waitForStation, ...cancelInput } = input;
  const result = await applyReservationCancellation(cancelInput);
  if (!result.cancelled || result.statusBefore !== 'active') return result;

  const pubsub = input.pubsub ?? getPubSub();
  if (!waitForStation) {
    await publishCancelReservation(pubsub, stationOcppId, reservationOcppId, input.logger);
    return result;
  }
  const answer = await sendOcppCommandAndWait(stationOcppId, 'CancelReservation', {
    reservationId: reservationOcppId,
  });
  const failure = cancelFailureReason(answer);
  if (failure == null) return result;
  await writeReservationAudit(
    {
      reservationId: input.reservationDbId,
      action: 'station_cancel_failed',
      actor: 'system',
      reason: failure,
      notes:
        answer.error ??
        `CancelReservation answered ${(answer.response?.['status'] as string | undefined) ?? 'unknown'}`,
    },
    undefined,
    input.logger,
  );
  return { ...result, warning: 'station_cancel_failed' };
}

async function loadReservation(reservationDbId: string) {
  const [row] = await db
    .select({
      reservation: reservations,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
    })
    .from(reservations)
    .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
    .where(eq(reservations.id, reservationDbId))
    .limit(1);
  if (row == null) throw new AppError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');
  return row;
}

function assertLive(status: string): void {
  if (status !== 'active' && status !== 'scheduled') {
    throw new AppError('Reservation is not active', 400, 'RESERVATION_NOT_ACTIVE');
  }
}

const NO_LONGER_ACTIVE = (): AppError =>
  new AppError('Reservation is not active', 409, 'RESERVATION_NOT_ACTIVE');

export interface UpdateReservationInput {
  reservationDbId: string;
  changes: {
    driverId?: string | null | undefined;
    evseOcppId?: number | null | undefined;
    expiresAt?: Date | undefined;
    tokenId?: string | null | undefined;
  };
  actor: ReservationActor;
  pubsub?: PubSubClient | undefined;
  logger?: ServiceLogger | undefined;
}

function reserveNowFailure(result: CommandResult): AppError | null {
  if (result.error != null) {
    return result.timedOut === true || result.queued === true
      ? new AppError(result.error, 504, 'RESERVATION_TIMEOUT')
      : new AppError(result.error, 502, 'RESERVATION_REJECTED');
  }
  const status = result.response?.['status'] as string | undefined;
  if (status != null && status !== 'Accepted') {
    return new AppError(`Station rejected reservation: ${status}`, 502, 'RESERVATION_REJECTED');
  }
  return null;
}

/**
 * Edits a live reservation (G14): the create window rules on a new expiry,
 * driver, payment method and token checks, then the overlap check (scheduled
 * and station-wide holds included) and a guarded UPDATE in one transaction
 * under the station lock. A row cancelled meanwhile answers 409. An edit of
 * an active hold that changes what the station holds re-sends ReserveNow with
 * the same id (OCPP replaces it); when the station refuses or does not answer,
 * the row goes back to its previous values and the edit answers 502 or 504.
 */
export async function updateReservation(input: UpdateReservationInput): Promise<ReservationRow> {
  const {
    reservation: existing,
    stationOcppId,
    siteId,
  } = await loadReservation(input.reservationDbId);
  assertLive(existing.status);
  const { changes } = input;

  const driverId = changes.driverId !== undefined ? changes.driverId : existing.driverId;
  const driverChanged = driverId !== existing.driverId;
  let tokenId = existing.tokenId;
  if (changes.tokenId !== undefined) {
    tokenId = changes.tokenId === null ? null : await resolveBoundToken(driverId, changes.tokenId);
  } else if (driverChanged) {
    // A new driver never keeps the previous driver's card.
    tokenId = await resolveBoundToken(driverId, undefined);
  }
  if (driverChanged && driverId != null) await assertDriverCanReserve(driverId, null);

  const evseId =
    changes.evseOcppId !== undefined
      ? await resolveEvse(existing.stationId, changes.evseOcppId)
      : existing.evseId;
  const expiresAt = changes.expiresAt ?? existing.expiresAt;
  const start = existing.startsAt ?? existing.createdAt;
  if (changes.expiresAt !== undefined) {
    await assertReservationWindow({
      startsAt: existing.startsAt,
      effectiveStart: start,
      expiresAt,
      checkStartInPast: false,
    });
  }

  const before = {
    driverId: existing.driverId,
    tokenId: existing.tokenId,
    evseId: existing.evseId,
    expiresAt: existing.expiresAt,
  };
  const after = { driverId, tokenId, evseId, expiresAt };
  const stationSideChanged =
    before.tokenId !== after.tokenId ||
    before.driverId !== after.driverId ||
    before.evseId !== after.evseId ||
    before.expiresAt.getTime() !== after.expiresAt.getTime();

  const writeValues = async (
    values: typeof after,
    guardStatus: 'active' | 'scheduled' | null,
  ): Promise<ReservationRow | undefined> =>
    db.transaction(async (tx) => {
      await lockStation(tx, existing.stationId);
      if (
        await hasConflict(tx, {
          stationUuid: existing.stationId,
          evseUuid: values.evseId,
          start,
          end: values.expiresAt,
          excludeId: existing.id,
        })
      ) {
        throw CONFLICT();
      }
      const [row] = await tx
        .update(reservations)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(reservations.id, existing.id),
            // A concurrent reassign moved it: this edit's EVSE belongs to the old station.
            eq(reservations.stationId, existing.stationId),
            guardStatus != null
              ? eq(reservations.status, guardStatus)
              : inArray(reservations.status, ['active', 'scheduled']),
          ),
        )
        .returning();
      return row;
    });

  const updated = await writeValues(after, null);
  if (updated == null) throw NO_LONGER_ACTIVE();

  if (updated.status === 'active' && stationSideChanged) {
    const answer = await sendOcppCommandAndWait(
      stationOcppId,
      'ReserveNow',
      await reserveNowPayload(updated),
    );
    const failure = reserveNowFailure(answer);
    if (failure != null) {
      // The station keeps the hold it had: put the row back to match it.
      await writeValues(before, 'active').catch((err: unknown) => {
        input.logger?.error(
          { err, reservationId: existing.id },
          'Restoring a reservation after a refused edit failed',
        );
      });
      // No answer (timeout, queued, send error): the station may still apply
      // the edit later, so it gets the stored values again behind it. A
      // station that answered with a refusal keeps the hold it had.
      if (answer.error != null) {
        await resendStoredHold(existing.id, {
          stationOcppId,
          cause: 'the edit got no answer from the station and was rolled back',
          pubsub: input.pubsub,
          logger: input.logger,
        });
      }
      throw failure;
    }
  }

  if (
    before.driverId !== after.driverId ||
    before.tokenId !== after.tokenId ||
    before.evseId !== after.evseId ||
    before.expiresAt.getTime() !== after.expiresAt.getTime()
  ) {
    await writeReservationAudit(
      {
        reservationId: existing.id,
        action: 'updated',
        ...auditActor(input.actor),
        driverIdBefore: before.driverId,
        driverIdAfter: after.driverId,
        tokenIdBefore: before.tokenId,
        tokenIdAfter: after.tokenId,
        evseIdBefore: before.evseId,
        evseIdAfter: after.evseId,
        statusBefore: existing.status,
        statusAfter: updated.status,
        expiresAtBefore: before.expiresAt,
        expiresAtAfter: after.expiresAt,
      },
      undefined,
      input.logger,
    );
  }
  publishReservationChanged(input.pubsub ?? getPubSub(), existing.stationId, siteId, input.logger);
  return updated;
}

export interface ReassignReservationInput {
  reservationDbId: string;
  newStation: ReservationStation;
  newEvseOcppId?: number | null | undefined;
  actor: ReservationActor;
  pubsub?: PubSubClient | undefined;
  logger?: ServiceLogger | undefined;
}

/**
 * Moves a live reservation to another station (G14): online (active only),
 * eligibility, maintenance, EVSE, busy EVSE and overlap checks on the new
 * station. A scheduled one moves with a guarded UPDATE (the worker sends
 * ReserveNow at its start). An active one sends ReserveNow to the new station
 * first, then moves the row under the new station's lock with a status guard:
 * a row cancelled (or a window taken) meanwhile gets CancelReservation on the
 * new station and answers 409; a moved row gets CancelReservation on the old
 * station. Both publish `reservation.changed`.
 */
export async function reassignReservation(
  input: ReassignReservationInput,
): Promise<{ reservation: ReservationRow; previousStationOcppId: string }> {
  const {
    reservation: existing,
    stationOcppId: oldStationOcppId,
    siteId: oldSiteId,
  } = await loadReservation(input.reservationDbId);
  assertLive(existing.status);
  const { newStation } = input;
  const isScheduled = existing.status === 'scheduled';
  const start = existing.startsAt ?? existing.createdAt;

  // A move within the station is an edit of its EVSE: updateReservation
  // restores the row when the station refuses, a reassign could not.
  if (newStation.id === existing.stationId) {
    throw new AppError(
      'The reservation is already on this station; change its EVSE instead',
      400,
      'VALIDATION_ERROR',
    );
  }
  if (!isScheduled && !newStation.isOnline) {
    throw new AppError('Station is offline', 400, 'STATION_OFFLINE');
  }
  await assertReservationsAllowed(newStation);
  await assertNoMaintenanceConflict(newStation.id, start, existing.expiresAt);
  const evseUuid = await resolveEvse(newStation.id, input.newEvseOcppId);
  await assertEvseFree(newStation.id, evseUuid, isScheduled ? start : new Date());

  const move = async (guard: 'active' | 'scheduled'): Promise<ReservationRow | 'conflict' | null> =>
    db.transaction(async (tx) => {
      await lockStation(tx, newStation.id);
      if (
        await hasConflict(tx, {
          stationUuid: newStation.id,
          evseUuid,
          start,
          end: existing.expiresAt,
          excludeId: existing.id,
        })
      ) {
        return 'conflict' as const;
      }
      const [row] = await tx
        .update(reservations)
        .set({
          stationId: newStation.id,
          evseId: evseUuid,
          updatedAt: new Date(),
          ...(guard === 'active' ? { stationAckAt: new Date() } : {}),
        })
        .where(
          and(
            eq(reservations.id, existing.id),
            // A concurrent reassign or edit loses: it read another station.
            eq(reservations.stationId, existing.stationId),
            eq(reservations.status, guard),
          ),
        )
        .returning();
      return row ?? null;
    });

  const pubsub = input.pubsub ?? getPubSub();
  let moved: ReservationRow | 'conflict' | null;
  if (isScheduled) {
    moved = await move('scheduled');
  } else {
    const answer = await sendOcppCommandAndWait(
      newStation.stationId,
      'ReserveNow',
      await reserveNowPayload({ ...existing, evseId: evseUuid }),
    );
    const failure = reserveNowFailure(answer);
    if (failure != null) {
      // A late Accepted would leave the new station holding an EVSE for a
      // reservation that stays on the old one (G3).
      if (answer.error != null) {
        await publishCancelReservation(
          pubsub,
          newStation.stationId,
          existing.reservationId,
          input.logger,
        );
      }
      throw new AppError(failure.message, 400, 'RESERVATION_REJECTED');
    }
    moved = await move('active');
    if (moved == null || moved === 'conflict') {
      // The new station holds an EVSE for a reservation that no longer moves.
      await publishCancelReservation(
        pubsub,
        newStation.stationId,
        existing.reservationId,
        input.logger,
      );
    }
  }
  if (moved === 'conflict') throw CONFLICT();
  if (moved == null) throw NO_LONGER_ACTIVE();

  await writeReservationAudit(
    {
      reservationId: existing.id,
      action: 'updated',
      ...auditActor(input.actor),
      evseIdBefore: existing.evseId,
      evseIdAfter: evseUuid,
      notes: `reassigned to station ${newStation.stationId} (was ${oldStationOcppId})`,
    },
    undefined,
    input.logger,
  );
  if (!isScheduled) {
    await publishCancelReservation(pubsub, oldStationOcppId, existing.reservationId, input.logger);
  }
  publishReservationChanged(pubsub, existing.stationId, oldSiteId, input.logger);
  publishReservationChanged(pubsub, newStation.id, newStation.siteId, input.logger);
  return { reservation: moved, previousStationOcppId: oldStationOcppId };
}
