// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, or, isNull, lt, gt, sql } from 'drizzle-orm';
import {
  db,
  client,
  maintenanceEvents,
  maintenanceEventAuditLog,
  maintenanceEventStations,
  chargingStations,
  chargingSessions,
  sites,
  reservations,
  writeAudit,
} from '@evtivity/database';
import { dispatchDriverNotification, AppError, renderMaintenanceMessage } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
import { buildDerivedStatusSubquery } from '../lib/station-derived-status.js';
import { sleep } from '../lib/sleep.js';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { applyReservationCancellation } from '../lib/reservation-cancel.js';
import { invalidateMaintenanceCheckCache } from '../lib/maintenance-check.js';
import {
  pushStationMessageSlot,
  clearStationMessageSlot,
  STATION_MESSAGE_SLOT_UNAVAILABLE,
} from './station-message.service.js';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';

export type MaintenanceEventType = 'immediate' | 'one_off';
export type MaintenanceStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';
export type SessionPolicy = 'ignore' | 'stop_graceful';

export interface MaintenanceActor {
  type: 'operator' | 'system';
  userId?: string | null;
  label?: string | null;
}

export interface CreateMaintenanceInput {
  siteId: string;
  eventType: MaintenanceEventType;
  plannedStartAt: Date;
  plannedEndAt: Date;
  affectedStationIds?: string[] | null;
  activeSessionPolicy: SessionPolicy;
  customMessage?: string | null;
  reason?: string | null;
  actor: MaintenanceActor;
  logger?: FastifyBaseLogger;
}

// When `detachSideEffects` is true the caller is on an HTTP request path and the
// per-station OCPP fan-out (90 stations x ChangeAvailability round-trip + slot
// push + reservation cancels + session stops + driver notifications) must NOT
// run inside the request: it would blow past the nginx 60s proxy timeout and
// the operator would see a 504 even though the state mutation already landed.
// Instead the request publishes the `maintenance_fanout` channel and the worker
// runs the fan-out through BullMQ, so it survives an API restart. When
// false/absent (worker scheduler, tests) the side effects are awaited inline
// because there is no timeout pressure and effects must complete before the
// call resolves.
export interface SideEffectOptions {
  detachSideEffects?: boolean;
}

export type MaintenanceFanoutPhase = 'enter' | 'release' | 'add' | 'remove' | 'reassert';

export interface MaintenanceFanoutActor {
  type: 'operator' | 'system';
  userId?: string | null;
  label?: string | null;
}

export interface MaintenanceFanoutJob {
  eventId: string;
  // Lets the worker take a per-site lock so fan-outs for the same site
  // serialize across worker replicas, not just within one process.
  siteId?: string;
  phase: MaintenanceFanoutPhase;
  stationDbIds?: string[];
  actor?: MaintenanceFanoutActor;
  // Reassert publishes carry a per-reconnect nonce so the worker's
  // deterministic jobId does not collapse a later reconnect's re-assert into
  // an already-completed job for the same station.
  nonce?: string;
}

export const MAINTENANCE_FANOUT_CHANNEL = 'maintenance_fanout';

// Concurrency-bound the per-station fan-out so a site with ~90 stations does not
// open 90 simultaneous OCPP waits. The pool keeps `limit` tasks in flight.
const STATION_FANOUT_CONCURRENCY = 10;

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index] as T);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
}

// Per-station fan-out result tracking. Each runner classifies the
// ChangeAvailability outcome per station and writes one row per station per
// phase to maintenance_event_stations, with the derived station status
// captured before the fan-out started and after it completed. Tracking is
// fail-open: a failed insert must not fail a fan-out that already commanded
// the fleet.
interface FanoutStationOutcome {
  stationDbId: string;
  stationOcppId: string;
  command: string;
  commandStatus: string;
  error: string | null;
}

function classifyCommandResult(result: { response?: Record<string, unknown>; error?: string }): {
  commandStatus: string;
  error: string | null;
} {
  if (result.error != null) {
    const offline = result.error.includes('is not connected');
    return { commandStatus: offline ? 'offline' : 'failed', error: result.error };
  }
  const status = (result.response as { status?: string } | undefined)?.status;
  return { commandStatus: (status ?? 'accepted').toLowerCase(), error: null };
}

// Stations send the StatusNotification that reflects a ChangeAvailability a
// moment after replying Accepted. Snapshotting statusAfter immediately after
// the command loop recorded the pre-command status (e.g. available -> available
// for a station that did go unavailable seconds later), so wait for the
// notifications to land before reading.
const STATUS_AFTER_SETTLE_MS = 5000;

async function loadDerivedStatusesAfterSettle(
  stationDbIds: string[],
): Promise<Map<string, string>> {
  if (stationDbIds.length === 0) return new Map();
  await sleep(STATUS_AFTER_SETTLE_MS);
  return loadDerivedStatuses(stationDbIds);
}

async function loadDerivedStatuses(stationDbIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (stationDbIds.length === 0) return map;
  try {
    const rows = await db
      .select({
        id: chargingStations.id,
        status: buildDerivedStatusSubquery(chargingStations.id),
      })
      .from(chargingStations)
      .where(inArray(chargingStations.id, stationDbIds));
    for (const row of rows) map.set(row.id, row.status);
  } catch {
    // status snapshots are diagnostic; the fan-out proceeds without them
  }
  return map;
}

async function recordFanoutOutcomes(
  eventId: string,
  // Richer than MaintenanceFanoutPhase on purpose: the release runner labels
  // its callers ('exit', 'cancel', 'remove-stations', 'release') so the
  // drill-down distinguishes why stations were released.
  phase: string,
  outcomes: FanoutStationOutcome[],
  statusBefore: Map<string, string>,
  statusAfter: Map<string, string>,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (outcomes.length === 0) return;
  try {
    await db.insert(maintenanceEventStations).values(
      outcomes.map((o) => ({
        eventId,
        stationId: o.stationDbId,
        stationIdSnapshot: o.stationDbId,
        stationOcppId: o.stationOcppId,
        phase,
        command: o.command,
        commandStatus: o.commandStatus,
        error: o.error,
        statusBefore: statusBefore.get(o.stationDbId) ?? null,
        statusAfter: statusAfter.get(o.stationDbId) ?? null,
      })),
    );
  } catch (err) {
    logger?.warn({ err, eventId, phase }, 'maintenance fan-out result tracking insert failed');
  }
}

// Canonical 2.1 payload with no version arg: the OCPP dispatcher translates
// per the station's live protocol (1.6 gets { connectorId: 0, type }).
// Passing a version would skip translation and send this payload raw to 1.6
// stations, which silently ignore it.
async function sendAvailabilityCommand(
  stationOcppId: string,
  operationalStatus: 'Inoperative' | 'Operative',
  logger?: FastifyBaseLogger,
): Promise<{ command: string; commandStatus: string; error: string | null }> {
  const command = `ChangeAvailability(${operationalStatus})`;
  try {
    const result = await sendOcppCommandAndWait(stationOcppId, 'ChangeAvailability', {
      operationalStatus,
    });
    const classified = classifyCommandResult(result);
    if (classified.error != null) {
      logger?.warn({ stationId: stationOcppId, error: classified.error }, `${command} failed`);
    }
    return { command, ...classified };
  } catch (err) {
    logger?.warn({ err, stationId: stationOcppId }, `${command} failed`);
    return {
      command,
      commandStatus: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// Periodic cancellation check for take-offline fan-outs. An End-now or cancel
// that lands while the enter/add run is mid-flight flips the event row
// immediately, but the run loaded the event at job start and would otherwise
// keep commanding stations offline (and cancel reservations / stop sessions)
// for a window that no longer exists. Re-reads the row at most every
// ABORT_RECHECK_MS; once not-active, stays aborted.
const ABORT_RECHECK_MS = 5000;

function makeActiveAbortCheck(eventId: string): () => Promise<boolean> {
  let lastCheckAt = 0;
  let aborted = false;
  return async () => {
    if (aborted) return true;
    const now = Date.now();
    if (now - lastCheckAt < ABORT_RECHECK_MS) return false;
    lastCheckAt = now;
    try {
      const fresh = await loadEventById(eventId);
      aborted = fresh == null || fresh.status !== 'active';
    } catch {
      // a transient read failure must not abort a legitimate fan-out
    }
    return aborted;
  };
}

// Hand the station fan-out to the worker via the `maintenance_fanout` channel.
// A publish failure leaves the event in its committed state (active/completed/
// cancelled) with the fleet uncommanded, so it is logged at ERROR — not warn —
// even though the request still returns success (the state mutation already
// landed). The maintenance-scheduler cron and an operator re-save are the
// recovery paths that re-trigger the fan-out.
async function publishFanout(job: MaintenanceFanoutJob, logger?: FastifyBaseLogger): Promise<void> {
  try {
    await getPubSub().publish(MAINTENANCE_FANOUT_CHANNEL, JSON.stringify(job));
  } catch (err) {
    logger?.error(
      { err, eventId: job.eventId, phase: job.phase },
      'maintenance fan-out publish failed; fleet left uncommanded until re-trigger',
    );
  }
}

function fanoutActor(actor: MaintenanceActor): MaintenanceFanoutActor {
  return { type: actor.type, userId: actor.userId ?? null, label: actor.label ?? null };
}

export interface MaintenanceEventRow {
  id: string;
  siteId: string;
  eventType: MaintenanceEventType;
  status: MaintenanceStatus;
  plannedStartAt: Date;
  plannedEndAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  affectedStationIds: string[] | null;
  activeSessionPolicy: SessionPolicy;
  customMessage: string | null;
  reason: string | null;
  reservationsCancelledCount: number;
  sessionsStoppedCount: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function auditActorFromActor(actor: MaintenanceActor): {
  actor: 'operator' | 'system';
  actorUserId: string | null;
  actorLabel: string | null;
} {
  return {
    actor: actor.type === 'operator' ? 'operator' : 'system',
    actorUserId: actor.userId ?? null,
    actorLabel: actor.label ?? null,
  };
}

async function publishStateChange(siteId: string, eventId: string): Promise<void> {
  const pubsub = getPubSub();
  try {
    await pubsub.publish(
      'csms_events',
      JSON.stringify({ eventType: 'maintenance.changed', siteId, eventId }),
    );
  } catch {
    // best-effort
  }
}

function rowFromDb(row: Record<string, unknown>): MaintenanceEventRow {
  return {
    id: row['id'] as string,
    siteId: row['siteId'] as string,
    eventType: row['eventType'] as MaintenanceEventType,
    status: row['status'] as MaintenanceStatus,
    plannedStartAt: row['plannedStartAt'] as Date,
    plannedEndAt: row['plannedEndAt'] as Date,
    startedAt: (row['startedAt'] as Date | null) ?? null,
    endedAt: (row['endedAt'] as Date | null) ?? null,
    affectedStationIds: (row['affectedStationIds'] as string[] | null) ?? null,
    activeSessionPolicy: row['activeSessionPolicy'] as SessionPolicy,
    customMessage: (row['customMessage'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    reservationsCancelledCount: Number(row['reservationsCancelledCount'] ?? 0),
    sessionsStoppedCount: Number(row['sessionsStoppedCount'] ?? 0),
    createdByUserId: (row['createdByUserId'] as string | null) ?? null,
    createdAt: row['createdAt'] as Date,
    updatedAt: row['updatedAt'] as Date,
  };
}

async function loadEventById(eventId: string): Promise<MaintenanceEventRow | null> {
  const [row] = await db.select().from(maintenanceEvents).where(eq(maintenanceEvents.id, eventId));
  return row != null ? rowFromDb(row) : null;
}

async function loadSiteStations(
  siteId: string,
  filter: string[] | null,
): Promise<Array<{ id: string; stationId: string; ocppProtocol: string | null }>> {
  const conditions = [eq(chargingStations.siteId, siteId)];
  if (filter != null && filter.length > 0) {
    conditions.push(inArray(chargingStations.id, filter));
  }
  return db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(and(...conditions));
}

async function findOverlappingScheduledEvents(
  siteId: string,
  plannedStartAt: Date,
  plannedEndAt: Date,
  excludeId?: string,
): Promise<MaintenanceEventRow[]> {
  const conditions = [
    eq(maintenanceEvents.siteId, siteId),
    inArray(maintenanceEvents.status, ['scheduled', 'active']),
    lt(maintenanceEvents.plannedStartAt, plannedEndAt),
    gt(maintenanceEvents.plannedEndAt, plannedStartAt),
  ];
  const rows = await db
    .select()
    .from(maintenanceEvents)
    .where(and(...conditions));
  const filtered = rows.filter((r) => excludeId == null || r.id !== excludeId);
  return filtered.map((r) => rowFromDb(r as Record<string, unknown>));
}

export async function createEvent(
  input: CreateMaintenanceInput,
  options: SideEffectOptions = {},
): Promise<MaintenanceEventRow> {
  if (input.plannedEndAt.getTime() <= input.plannedStartAt.getTime()) {
    throw new AppError('Maintenance end must be after start', 400, 'MAINTENANCE_INVALID_RANGE');
  }

  const overlaps = await findOverlappingScheduledEvents(
    input.siteId,
    input.plannedStartAt,
    input.plannedEndAt,
  );
  if (overlaps.length > 0) {
    throw new AppError(
      'Maintenance window overlaps an existing event',
      409,
      'MAINTENANCE_OVERLAPS_EXISTING',
    );
  }

  const initialStatus: MaintenanceStatus = 'scheduled';
  const [inserted] = await db
    .insert(maintenanceEvents)
    .values({
      siteId: input.siteId,
      eventType: input.eventType,
      status: initialStatus,
      plannedStartAt: input.plannedStartAt,
      plannedEndAt: input.plannedEndAt,
      affectedStationIds: input.affectedStationIds ?? null,
      activeSessionPolicy: input.activeSessionPolicy,
      customMessage: input.customMessage ?? null,
      reason: input.reason ?? null,
      createdByUserId: input.actor.userId ?? null,
    })
    .returning();

  if (inserted == null) {
    throw new AppError('Failed to create maintenance event', 500, 'INTERNAL_ERROR');
  }
  const created = rowFromDb(inserted);

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: created.id,
      entityIdSnapshot: created.id,
      action: 'created',
      ...auditActorFromActor(input.actor),
      before: null,
      after: created,
    },
    db,
    input.logger,
  );

  invalidateMaintenanceCheckCache();
  await publishStateChange(created.siteId, created.id);

  const isImmediate =
    input.eventType === 'immediate' || created.plannedStartAt.getTime() <= Date.now();
  if (isImmediate) {
    await enterMaintenance(created.id, input.actor, input.logger, options);
    const refreshed = await loadEventById(created.id);
    return refreshed ?? created;
  }

  return created;
}

export async function enterMaintenance(
  eventId: string,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
  options: SideEffectOptions = {},
): Promise<void> {
  const updated = await db.execute<{ id: string }>(
    sql`
      UPDATE ${maintenanceEvents}
      SET status = 'active',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = ${eventId}
        AND status IN ('scheduled', 'active')
        AND started_at IS NULL
      RETURNING id
    `,
  );
  const rows = updated as unknown as Array<{ id: string }>;
  if (rows.length === 0) {
    logger?.info(
      { eventId },
      'maintenance enterMaintenance no-op (event already active or terminal)',
    );
    return;
  }

  const event = await loadEventById(eventId);
  if (event == null) return;

  // Sync state mutation has landed (status='active'). Cache invalidation and the
  // first SSE publish stay in the request so peers see the active state and the
  // UI flips immediately. The station fan-out runs detached on the HTTP path.
  invalidateMaintenanceCheckCache();
  await publishStateChange(event.siteId, event.id);

  if (options.detachSideEffects === true) {
    await publishFanout(
      { eventId: event.id, siteId: event.siteId, phase: 'enter', actor: fanoutActor(actor) },
      logger,
    );
    return;
  }
  await runEnterSideEffects(event, actor, logger);
}

export async function runEnterSideEffects(
  event: MaintenanceEventRow,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const [[site], stations] = await Promise.all([
    db.select({ name: sites.name }).from(sites).where(eq(sites.id, event.siteId)),
    loadSiteStations(event.siteId, event.affectedStationIds),
  ]);
  const siteName = site?.name ?? '';
  const message = await renderMaintenanceMessage(client, event, siteName);

  const statusBefore = await loadDerivedStatuses(stations.map((s) => s.id));
  const outcomes: FanoutStationOutcome[] = [];
  const shouldAbort = makeActiveAbortCheck(event.id);
  let abortedEarly = false as boolean;
  await mapWithConcurrency(stations, STATION_FANOUT_CONCURRENCY, async (station) => {
    if (abortedEarly || (await shouldAbort())) {
      abortedEarly = true;
      return;
    }
    const sent = await sendAvailabilityCommand(station.stationId, 'Inoperative', logger);
    outcomes.push({
      stationDbId: station.id,
      stationOcppId: station.stationId,
      ...sent,
    });
    try {
      await pushStationMessageSlot(
        station.stationId,
        station.ocppProtocol,
        STATION_MESSAGE_SLOT_UNAVAILABLE,
        'Unavailable',
        message,
      );
    } catch (err) {
      logger?.warn({ err, stationId: station.stationId }, 'maintenance message push failed');
    }
  });
  if (abortedEarly) {
    // The event was ended/cancelled mid-run. Record what was actually
    // commanded, then stop: no reservation cancels, session stops, counters,
    // or started-audit for a window that no longer exists. The release job
    // queued by the cancel restores the stations commanded so far.
    const commandedIds = outcomes.map((o) => o.stationDbId);
    const statusAfter = await loadDerivedStatuses(commandedIds);
    await recordFanoutOutcomes(event.id, 'enter', outcomes, statusBefore, statusAfter, logger);
    logger?.info(
      { eventId: event.id, commanded: outcomes.length, total: stations.length },
      'maintenance enter fan-out aborted: event no longer active',
    );
    invalidateMaintenanceCheckCache();
    await publishStateChange(event.siteId, event.id);
    return;
  }
  const statusAfter = await loadDerivedStatusesAfterSettle(stations.map((s) => s.id));
  await recordFanoutOutcomes(event.id, 'enter', outcomes, statusBefore, statusAfter, logger);

  const stationIds = stations.map((s) => s.id);
  const [reservationsCancelled, sessionsStopped] = await Promise.all([
    cancelOverlappingReservations(event, stationIds, logger),
    event.activeSessionPolicy === 'stop_graceful' && stations.length > 0
      ? stopActiveSessionsForStations(event, stations, logger)
      : Promise.resolve(0),
  ]);

  await db
    .update(maintenanceEvents)
    .set({
      reservationsCancelledCount: reservationsCancelled,
      sessionsStoppedCount: sessionsStopped,
      updatedAt: new Date(),
    })
    .where(eq(maintenanceEvents.id, event.id));

  const auditActorBase = auditActorFromActor(actor);
  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: event.id,
      entityIdSnapshot: event.id,
      action: 'started',
      ...auditActorBase,
      notes: `Stations: ${String(stations.length)}, sessions stopped: ${String(sessionsStopped)}, reservations cancelled: ${String(reservationsCancelled)}`,
    },
    db,
    logger,
  );

  if (reservationsCancelled > 0) {
    await writeAudit(
      { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
      {
        entityId: event.id,
        entityIdSnapshot: event.id,
        action: 'reservations_cancelled',
        ...auditActorBase,
        notes: `Cancelled ${String(reservationsCancelled)} reservation(s)`,
      },
      db,
      logger,
    );
  }
  if (sessionsStopped > 0) {
    await writeAudit(
      { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
      {
        entityId: event.id,
        entityIdSnapshot: event.id,
        action: 'sessions_stopped',
        ...auditActorBase,
        notes: `Stopped ${String(sessionsStopped)} session(s)`,
      },
      db,
      logger,
    );
  }

  logger?.info(
    {
      eventId: event.id,
      stations: stations.length,
      reservationsCancelled,
      sessionsStopped,
    },
    'maintenance enter side effects complete',
  );

  // Second SSE publish: the fan-out has finished and the counters are now
  // committed, so the UI refreshes its badges/counters off the same channel.
  invalidateMaintenanceCheckCache();
  await publishStateChange(event.siteId, event.id);
}

async function cancelOverlappingReservations(
  event: MaintenanceEventRow,
  stationIds: string[],
  logger?: FastifyBaseLogger,
): Promise<number> {
  if (stationIds.length === 0) return 0;

  const candidates = await db
    .select({
      id: reservations.id,
      stationId: reservations.stationId,
      driverId: reservations.driverId,
      startsAt: reservations.startsAt,
      createdAt: reservations.createdAt,
    })
    .from(reservations)
    .where(
      and(
        inArray(reservations.stationId, stationIds),
        inArray(reservations.status, ['scheduled', 'active', 'in_use']),
        or(isNull(reservations.startsAt), lt(reservations.startsAt, event.plannedEndAt)),
        gt(reservations.expiresAt, event.plannedStartAt),
      ),
    );

  const results = await Promise.all(
    candidates.map(async (row) => {
      try {
        const result = await applyReservationCancellation({
          reservationDbId: row.id,
          siteId: event.siteId,
          driverId: row.driverId ?? null,
          startsAt: row.startsAt ?? row.createdAt,
          createdAt: row.createdAt,
          actor: 'system',
          reason: 'system_cleanup',
          note: `Cancelled by maintenance event ${event.id}`,
          chargeFee: false,
          ...(logger != null ? { logger } : {}),
        });
        if (!result.cancelled) return false;
        if (row.driverId != null) {
          try {
            await dispatchDriverNotification(
              client,
              'reservation.CancelledForMaintenance',
              row.driverId,
              {
                maintenanceEventId: event.id,
                plannedStartAt: event.plannedStartAt.toISOString(),
                plannedEndAt: event.plannedEndAt.toISOString(),
                reason: event.reason ?? '',
              },
              ALL_TEMPLATES_DIRS,
              getPubSub(),
            );
          } catch (err) {
            logger?.warn(
              { err, driverId: row.driverId },
              'reservation.CancelledForMaintenance notify failed',
            );
          }
        }
        return true;
      } catch (err) {
        logger?.warn({ err, reservationId: row.id }, 'maintenance reservation cancel failed');
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

async function stopActiveSessionsForStations(
  event: MaintenanceEventRow,
  stations: Array<{ id: string; stationId: string; ocppProtocol: string | null }>,
  logger?: FastifyBaseLogger,
): Promise<number> {
  if (stations.length === 0) return 0;

  const stationIds = stations.map((s) => s.id);
  const active = await db
    .select({
      id: chargingSessions.id,
      driverId: chargingSessions.driverId,
      transactionId: chargingSessions.transactionId,
      stationDbId: chargingSessions.stationId,
    })
    .from(chargingSessions)
    .where(
      and(inArray(chargingSessions.stationId, stationIds), eq(chargingSessions.status, 'active')),
    );

  const stationLookup = new Map<string, { stationId: string; ocppProtocol: string | null }>();
  for (const sr of stations) {
    stationLookup.set(sr.id, { stationId: sr.stationId, ocppProtocol: sr.ocppProtocol });
  }

  const results = await Promise.all(
    active.map(async (sess) => {
      const stationInfo = stationLookup.get(sess.stationDbId);
      if (stationInfo == null) return false;
      try {
        const result = await sendOcppCommandAndWait(
          stationInfo.stationId,
          'RequestStopTransaction',
          {
            transactionId: sess.transactionId,
          },
        );
        if (result.error != null) return false;
        if (sess.driverId != null) {
          try {
            await dispatchDriverNotification(
              client,
              'maintenance.SessionStopped',
              sess.driverId,
              {
                maintenanceEventId: event.id,
                sessionId: sess.id,
                plannedEndAt: event.plannedEndAt.toISOString(),
                reason: event.reason ?? '',
              },
              ALL_TEMPLATES_DIRS,
              getPubSub(),
            );
          } catch (err) {
            logger?.warn(
              { err, driverId: sess.driverId },
              'maintenance.SessionStopped notify failed',
            );
          }
        }
        return true;
      } catch (err) {
        logger?.warn({ err, sessionId: sess.id }, 'maintenance stop session failed');
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

export async function exitMaintenance(
  eventId: string,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
  options: SideEffectOptions = {},
): Promise<void> {
  const event = await loadEventById(eventId);
  if (event == null) return;
  if (event.status !== 'active') {
    logger?.info(
      { eventId, status: event.status },
      'maintenance exitMaintenance skipped (event not active)',
    );
    return;
  }

  const updated = await db.execute<{ id: string }>(
    sql`
      UPDATE ${maintenanceEvents}
      SET status = 'completed',
          ended_at = now(),
          updated_at = now()
      WHERE id = ${eventId}
        AND status = 'active'
      RETURNING id
    `,
  );
  const rows = updated as unknown as Array<{ id: string }>;
  if (rows.length === 0) return;

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: event.id,
      entityIdSnapshot: event.id,
      action: 'ended',
      ...auditActorFromActor(actor),
    },
    db,
    logger,
  );

  invalidateMaintenanceCheckCache();
  await publishStateChange(event.siteId, event.id);

  if (options.detachSideEffects === true) {
    await publishFanout(
      { eventId: event.id, siteId: event.siteId, phase: 'release', actor: fanoutActor(actor) },
      logger,
    );
    return;
  }
  await runReleaseStations(event, 'exit', logger);
}

// Shared Operative + clear-slot fan-out for the three release paths
// (exit/cancel/remove). Concurrency-bound and per-station fail-open. Publishes a
// second SSE so detached callers refresh the UI once the stations are released.
async function runReleaseStations(
  event: MaintenanceEventRow,
  phase: string,
  logger?: FastifyBaseLogger,
  stationsOverride?: Array<{ id: string; stationId: string; ocppProtocol: string | null }>,
): Promise<void> {
  const stations =
    stationsOverride ?? (await loadSiteStations(event.siteId, event.affectedStationIds));
  const statusBefore = await loadDerivedStatuses(stations.map((s) => s.id));
  const outcomes: FanoutStationOutcome[] = [];
  await mapWithConcurrency(stations, STATION_FANOUT_CONCURRENCY, async (station) => {
    const sent = await sendAvailabilityCommand(station.stationId, 'Operative', logger);
    outcomes.push({
      stationDbId: station.id,
      stationOcppId: station.stationId,
      ...sent,
    });
    try {
      await clearStationMessageSlot(
        station.stationId,
        station.ocppProtocol,
        STATION_MESSAGE_SLOT_UNAVAILABLE,
      );
    } catch (err) {
      logger?.warn({ err, stationId: station.stationId }, 'maintenance message clear failed');
    }
  });
  const statusAfter = await loadDerivedStatusesAfterSettle(stations.map((s) => s.id));
  await recordFanoutOutcomes(event.id, phase, outcomes, statusBefore, statusAfter, logger);

  logger?.info(
    { eventId: event.id, stations: stations.length, phase },
    'maintenance release side effects complete',
  );
  invalidateMaintenanceCheckCache();
  await publishStateChange(event.siteId, event.id);
}

export interface UpdateEventInput {
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  affectedStationIds?: string[] | null;
  activeSessionPolicy?: SessionPolicy;
  customMessage?: string | null;
  reason?: string | null;
}

// Active events are mid-flight: the start time is in the past, the stations
// have already been put into Unavailable, and the session/reservation policy
// has already been applied at activation time. Only fields that can be
// changed without re-running the activation side effects are editable.
// Adding or removing stations on an active event goes through the dedicated
// add-stations / remove-stations service functions instead, because those
// require ChangeAvailability and message-slot side effects.
const ACTIVE_EDITABLE_FIELDS = new Set<keyof UpdateEventInput>([
  'plannedEndAt',
  'customMessage',
  'reason',
]);

export async function updateEvent(
  eventId: string,
  changes: UpdateEventInput,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
): Promise<MaintenanceEventRow> {
  const before = await loadEventById(eventId);
  if (before == null) {
    throw new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND');
  }
  if (before.status !== 'scheduled' && before.status !== 'active') {
    throw new AppError(
      'Only scheduled or active events can be edited',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }

  if (before.status === 'active') {
    for (const key of Object.keys(changes) as Array<keyof UpdateEventInput>) {
      if (changes[key] === undefined) continue;
      if (!ACTIVE_EDITABLE_FIELDS.has(key)) {
        throw new AppError(
          `Field '${key}' cannot be changed once the event is active`,
          409,
          'MAINTENANCE_ALREADY_ACTIVE',
        );
      }
    }
  }

  const start = changes.plannedStartAt ?? before.plannedStartAt;
  const end = changes.plannedEndAt ?? before.plannedEndAt;
  if (end.getTime() <= start.getTime()) {
    throw new AppError('Maintenance end must be after start', 400, 'MAINTENANCE_INVALID_RANGE');
  }

  if (
    before.status === 'scheduled' &&
    (changes.plannedStartAt !== undefined || changes.plannedEndAt !== undefined)
  ) {
    const overlaps = await findOverlappingScheduledEvents(before.siteId, start, end, eventId);
    if (overlaps.length > 0) {
      throw new AppError(
        'Maintenance window overlaps an existing event',
        409,
        'MAINTENANCE_OVERLAPS_EXISTING',
      );
    }
  }

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (before.status === 'scheduled') {
    updateSet['plannedStartAt'] = start;
  }
  if (changes.plannedEndAt !== undefined) {
    updateSet['plannedEndAt'] = end;
  }
  if (changes.affectedStationIds !== undefined) {
    updateSet['affectedStationIds'] = changes.affectedStationIds;
  }
  if (changes.activeSessionPolicy !== undefined) {
    updateSet['activeSessionPolicy'] = changes.activeSessionPolicy;
  }
  if (changes.customMessage !== undefined) {
    updateSet['customMessage'] = changes.customMessage;
  }
  if (changes.reason !== undefined) {
    updateSet['reason'] = changes.reason;
  }

  // Tight status guard: the field-whitelist branch above keyed off
  // `before.status`. If the cron flipped scheduled→active between
  // loadEventById and this UPDATE, a permissive WHERE (status IN (...))
  // would let immutable fields like plannedStartAt or affectedStationIds
  // get written to an active event with no OCPP side effects. Requiring
  // status to still match the loaded value forces a 409 retry instead.
  const [updated] = await db
    .update(maintenanceEvents)
    .set(updateSet)
    .where(and(eq(maintenanceEvents.id, eventId), eq(maintenanceEvents.status, before.status)))
    .returning();
  if (updated == null) {
    throw new AppError(
      'Maintenance event status changed during edit — refresh and try again',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }
  const after = rowFromDb(updated);

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: after.id,
      entityIdSnapshot: after.id,
      action: 'updated',
      ...auditActorFromActor(actor),
      before,
      after,
    },
    db,
    logger,
  );

  // When a scheduled event's window changes, eagerly cancel any reservations
  // that now fall inside the new window. Without this step, drivers with a
  // booking inside the widened window would only be notified at activation,
  // sometimes hours later. cancelOverlappingReservations is idempotent
  // (filters by reservation status), so this is safe to call even when the
  // window shifted in a way that doesn't introduce new conflicts.
  if (
    before.status === 'scheduled' &&
    (changes.plannedStartAt !== undefined || changes.plannedEndAt !== undefined)
  ) {
    const stations = await loadSiteStations(after.siteId, after.affectedStationIds);
    const stationIds = stations.map((s) => s.id);
    const cancelled = await cancelOverlappingReservations(after, stationIds, logger);
    if (cancelled > 0) {
      await db
        .update(maintenanceEvents)
        .set({
          reservationsCancelledCount: sql`${maintenanceEvents.reservationsCancelledCount} + ${cancelled}`,
        })
        .where(eq(maintenanceEvents.id, after.id));
      await writeAudit(
        { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
        {
          entityId: after.id,
          entityIdSnapshot: after.id,
          action: 'reservations_cancelled',
          ...auditActorFromActor(actor),
          notes: `Cancelled ${String(cancelled)} reservation(s) after window change`,
        },
        db,
        logger,
      );
    }
  }

  invalidateMaintenanceCheckCache();
  await publishStateChange(after.siteId, after.id);
  return after;
}

/**
 * Add one or more stations to a scheduled or active maintenance event.
 *
 * For scheduled events this is a pure DB update. For active events the new
 * stations are immediately taken offline: ChangeAvailability(Inoperative) is
 * sent, slot 9005 is pushed, overlapping reservations are cancelled, and
 * (when policy=stop_graceful) active sessions are stopped — mirroring the
 * activation path so a late-added station ends up in the same state as one
 * that was on the list at activation time.
 *
 * When the event's affected_station_ids was null/empty ("all stations"),
 * the new station list is materialized first so the explicit list reflects
 * the intent going forward.
 */
export async function addStationsToMaintenance(
  eventId: string,
  stationIdsToAdd: string[],
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
  options: SideEffectOptions = {},
): Promise<MaintenanceEventRow> {
  const before = await loadEventById(eventId);
  if (before == null) {
    throw new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND');
  }
  if (stationIdsToAdd.length === 0) return before;
  if (before.status !== 'scheduled' && before.status !== 'active') {
    throw new AppError(
      'Only scheduled or active events can be edited',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }

  const ownedStations = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(
      and(
        eq(chargingStations.siteId, before.siteId),
        inArray(chargingStations.id, stationIdsToAdd),
      ),
    );
  if (ownedStations.length !== stationIdsToAdd.length) {
    throw new AppError('One or more stations do not belong to this site', 400, 'STATION_NOT_FOUND');
  }

  let currentList: string[];
  if (before.affectedStationIds == null || before.affectedStationIds.length === 0) {
    const allSiteStations = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(eq(chargingStations.siteId, before.siteId));
    currentList = allSiteStations.map((s) => s.id);
  } else {
    currentList = before.affectedStationIds;
  }

  const existingSet = new Set(currentList);
  const trulyNew = stationIdsToAdd.filter((id) => !existingSet.has(id));
  if (trulyNew.length === 0) return before;

  const nextList = [...currentList, ...trulyNew];

  // DB UPDATE first, side effects second. If the event transitioned to
  // completed/cancelled between loadEventById and this UPDATE, a permissive
  // status guard would still match and the side effects (ChangeAvailability,
  // slot push, reservation cancel, session stop) would orphan: stations would
  // be left Inoperative with no event listing them, so exitMaintenance/
  // cancelEvent could never Operative them back. Tightening to
  // eq(status, before.status) forces a 409 retry in that case so no OCPP
  // command goes out for a station that's not in a committed event row.
  const [updated] = await db
    .update(maintenanceEvents)
    .set({ affectedStationIds: nextList, updatedAt: new Date() })
    .where(and(eq(maintenanceEvents.id, eventId), eq(maintenanceEvents.status, before.status)))
    .returning();
  if (updated == null) {
    throw new AppError(
      'Maintenance event status changed during edit — refresh and try again',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }
  const after = rowFromDb(updated);

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: after.id,
      entityIdSnapshot: after.id,
      action: 'updated',
      ...auditActorFromActor(actor),
      before,
      after,
      notes: `Added ${String(trulyNew.length)} station(s) to event`,
    },
    db,
    logger,
  );

  invalidateMaintenanceCheckCache();
  await publishStateChange(after.siteId, after.id);

  // Only an active event needs to take the newly added stations offline.
  if (after.status === 'active') {
    if (options.detachSideEffects === true) {
      await publishFanout(
        {
          eventId: after.id,
          siteId: after.siteId,
          phase: 'add',
          stationDbIds: trulyNew,
          actor: fanoutActor(actor),
        },
        logger,
      );
    } else {
      await runAddStationSideEffects(after, trulyNew, actor, logger);
    }
  }

  return after;
}

async function runAddStationSideEffects(
  after: MaintenanceEventRow,
  newStationIds: string[],
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const newStations = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(inArray(chargingStations.id, newStationIds));

  const [site] = await db
    .select({ name: sites.name })
    .from(sites)
    .where(eq(sites.id, after.siteId));
  const siteName = site?.name ?? '';
  const message = await renderMaintenanceMessage(client, after, siteName);

  const statusBefore = await loadDerivedStatuses(newStations.map((s) => s.id));
  const outcomes: FanoutStationOutcome[] = [];
  const shouldAbort = makeActiveAbortCheck(after.id);
  let abortedEarly = false as boolean;
  await mapWithConcurrency(newStations, STATION_FANOUT_CONCURRENCY, async (station) => {
    if (abortedEarly || (await shouldAbort())) {
      abortedEarly = true;
      return;
    }
    const sent = await sendAvailabilityCommand(station.stationId, 'Inoperative', logger);
    outcomes.push({
      stationDbId: station.id,
      stationOcppId: station.stationId,
      ...sent,
    });
    try {
      await pushStationMessageSlot(
        station.stationId,
        station.ocppProtocol,
        STATION_MESSAGE_SLOT_UNAVAILABLE,
        'Unavailable',
        message,
      );
    } catch (err) {
      logger?.warn(
        { err, stationId: station.stationId },
        'slot push failed when adding station to active event',
      );
    }
  });
  if (abortedEarly) {
    const commandedIds = outcomes.map((o) => o.stationDbId);
    const statusAfter = await loadDerivedStatuses(commandedIds);
    await recordFanoutOutcomes(after.id, 'add', outcomes, statusBefore, statusAfter, logger);
    logger?.info(
      { eventId: after.id, commanded: outcomes.length, total: newStations.length },
      'maintenance add fan-out aborted: event no longer active',
    );
    invalidateMaintenanceCheckCache();
    await publishStateChange(after.siteId, after.id);
    return;
  }
  const statusAfter = await loadDerivedStatusesAfterSettle(newStations.map((s) => s.id));
  await recordFanoutOutcomes(after.id, 'add', outcomes, statusBefore, statusAfter, logger);

  const newStationDbIds = newStations.map((s) => s.id);
  const [extraReservationsCancelled, extraSessionsStopped] = await Promise.all([
    cancelOverlappingReservations(after, newStationDbIds, logger),
    after.activeSessionPolicy === 'stop_graceful' && newStations.length > 0
      ? stopActiveSessionsForStations(after, newStations, logger)
      : Promise.resolve(0),
  ]);

  if (extraReservationsCancelled > 0 || extraSessionsStopped > 0) {
    const counterSet: Record<string, unknown> = {};
    if (extraReservationsCancelled > 0) {
      counterSet['reservationsCancelledCount'] =
        sql`${maintenanceEvents.reservationsCancelledCount} + ${extraReservationsCancelled}`;
    }
    if (extraSessionsStopped > 0) {
      counterSet['sessionsStoppedCount'] =
        sql`${maintenanceEvents.sessionsStoppedCount} + ${extraSessionsStopped}`;
    }
    await db.update(maintenanceEvents).set(counterSet).where(eq(maintenanceEvents.id, after.id));
  }

  const auditActorBase = auditActorFromActor(actor);
  if (extraReservationsCancelled > 0) {
    await writeAudit(
      { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
      {
        entityId: after.id,
        entityIdSnapshot: after.id,
        action: 'reservations_cancelled',
        ...auditActorBase,
        notes: `Cancelled ${String(extraReservationsCancelled)} reservation(s) on added station(s)`,
      },
      db,
      logger,
    );
  }
  if (extraSessionsStopped > 0) {
    await writeAudit(
      { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
      {
        entityId: after.id,
        entityIdSnapshot: after.id,
        action: 'sessions_stopped',
        ...auditActorBase,
        notes: `Stopped ${String(extraSessionsStopped)} session(s) on added station(s)`,
      },
      db,
      logger,
    );
  }

  logger?.info(
    {
      eventId: after.id,
      stations: newStations.length,
      reservationsCancelled: extraReservationsCancelled,
      sessionsStopped: extraSessionsStopped,
    },
    'maintenance add-station side effects complete',
  );
  invalidateMaintenanceCheckCache();
  await publishStateChange(after.siteId, after.id);
}

/**
 * Remove one or more stations from a scheduled or active maintenance event.
 *
 * For scheduled events this is a pure DB update. For active events the
 * removed stations are immediately released: ChangeAvailability(Operative) is
 * sent and slot 9005 is cleared so they return to normal operation.
 *
 * When the event's affected_station_ids was null/empty (meaning "all stations
 * at the site"), the current full station list is materialized first so the
 * exclusion is explicit going forward.
 */
export async function removeStationsFromMaintenance(
  eventId: string,
  stationIdsToRemove: string[],
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
  options: SideEffectOptions = {},
): Promise<MaintenanceEventRow> {
  const before = await loadEventById(eventId);
  if (before == null) {
    throw new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND');
  }
  if (stationIdsToRemove.length === 0) return before;
  if (before.status !== 'scheduled' && before.status !== 'active') {
    throw new AppError(
      'Only scheduled or active events can be edited',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }

  const toRemove = new Set(stationIdsToRemove);
  let currentList: string[];
  if (before.affectedStationIds == null || before.affectedStationIds.length === 0) {
    const allSiteStations = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(eq(chargingStations.siteId, before.siteId));
    currentList = allSiteStations.map((s) => s.id);
  } else {
    currentList = before.affectedStationIds;
  }

  const nextList = currentList.filter((id) => !toRemove.has(id));
  if (nextList.length === currentList.length) return before;
  if (nextList.length === 0) {
    throw new AppError(
      'Cannot remove the last station — cancel the event instead',
      400,
      'MAINTENANCE_INVALID_RANGE',
    );
  }

  const removed = currentList.filter((id) => toRemove.has(id));

  // Tight status guard: the post-UPDATE active branch gates whether the
  // Operative side effects run. If status flipped between load and UPDATE, the
  // cron's enterMaintenance/cancelEvent would have already acted on the old
  // list, and a permissive WHERE here would silently shrink the committed list,
  // stranding the removed stations Inoperative without an event to ever
  // Operative them again. The DB UPDATE lands first so a lost race throws 409
  // before any OCPP command goes out.
  const [updated] = await db
    .update(maintenanceEvents)
    .set({ affectedStationIds: nextList, updatedAt: new Date() })
    .where(and(eq(maintenanceEvents.id, eventId), eq(maintenanceEvents.status, before.status)))
    .returning();
  if (updated == null) {
    throw new AppError(
      'Maintenance event status changed during edit — refresh and try again',
      409,
      'MAINTENANCE_ALREADY_ACTIVE',
    );
  }
  const after = rowFromDb(updated);

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: after.id,
      entityIdSnapshot: after.id,
      action: 'updated',
      ...auditActorFromActor(actor),
      before,
      after,
      notes: `Removed ${String(removed.length)} station(s) from event`,
    },
    db,
    logger,
  );

  invalidateMaintenanceCheckCache();
  await publishStateChange(after.siteId, after.id);

  // Only an active event left the removed stations Inoperative; release them.
  if (before.status === 'active' && removed.length > 0) {
    if (options.detachSideEffects === true) {
      await publishFanout(
        {
          eventId: after.id,
          siteId: after.siteId,
          phase: 'remove',
          stationDbIds: removed,
          actor: fanoutActor(actor),
        },
        logger,
      );
    } else {
      await runRemoveStationSideEffects(after, removed, logger);
    }
  }

  return after;
}

async function runRemoveStationSideEffects(
  after: MaintenanceEventRow,
  removedStationIds: string[],
  logger?: FastifyBaseLogger,
): Promise<void> {
  const releasedStations = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(inArray(chargingStations.id, removedStationIds));

  await runReleaseStations(after, 'remove-stations', logger, releasedStations);
}

export async function cancelEvent(
  eventId: string,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
  options: SideEffectOptions = {},
): Promise<MaintenanceEventRow> {
  const event = await loadEventById(eventId);
  if (event == null) {
    throw new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND');
  }
  if (event.status === 'completed' || event.status === 'cancelled') {
    return event;
  }

  // CTE captures the status BEFORE the UPDATE in the same round-trip so
  // there is no TOCTOU window. A row that transitioned scheduled -> active
  // between the initial loadEventById and the UPDATE still produces
  // status_before = 'active' here, so the cleanup branch fires.
  const updated = await db.execute<{ id: string; status_before: string }>(
    sql`
      WITH old AS (
        SELECT id, status AS status_before
        FROM ${maintenanceEvents}
        WHERE id = ${eventId}
          AND status IN ('scheduled', 'active')
      )
      UPDATE ${maintenanceEvents}
      SET status = 'cancelled',
          ended_at = COALESCE(ended_at, now()),
          updated_at = now()
      FROM old
      WHERE ${maintenanceEvents}.id = old.id
      RETURNING ${maintenanceEvents}.id, old.status_before
    `,
  );
  const rows = updated as unknown as Array<{ id: string; status_before: string }>;
  const winner = rows[0];
  if (winner == null) {
    return event;
  }
  const wasActive = winner.status_before === 'active';

  await writeAudit(
    { table: maintenanceEventAuditLog, idColumn: 'maintenance_event_id' },
    {
      entityId: event.id,
      entityIdSnapshot: event.id,
      action: 'cancelled',
      ...auditActorFromActor(actor),
    },
    db,
    logger,
  );

  invalidateMaintenanceCheckCache();
  await publishStateChange(event.siteId, event.id);

  // Only an active event left stations Inoperative. The Operative fan-out is the
  // slow leg, so detach it on the HTTP path and await it on the worker path.
  if (wasActive) {
    if (options.detachSideEffects === true) {
      await publishFanout(
        { eventId: event.id, siteId: event.siteId, phase: 'release', actor: fanoutActor(actor) },
        logger,
      );
    } else {
      await runReleaseStations(event, 'cancel', logger);
    }
  }

  const refreshed = await loadEventById(event.id);
  return refreshed ?? event;
}

// Worker entrypoint for the detached station fan-out. The worker bridge enqueues
// a BullMQ job carrying a MaintenanceFanoutJob; this reloads the event fresh
// (the row may have moved on since the publish) and dispatches to the matching
// runner. The runners reload station rows themselves, so only ids travel on the
// wire. No-ops when the event vanished between publish and processing.
export async function runMaintenanceFanout(
  job: MaintenanceFanoutJob,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const event = await loadEventById(job.eventId);
  if (event == null) {
    logger?.info({ eventId: job.eventId, phase: job.phase }, 'maintenance fan-out event vanished');
    return;
  }
  const actor: MaintenanceActor = {
    type: job.actor?.type ?? 'system',
    userId: job.actor?.userId ?? null,
    label: job.actor?.label ?? null,
  };

  // Take-offline phases only make sense on an active event: an End-now or
  // cancel that landed while this job sat in the queue must not command a
  // fleet offline for a window that no longer exists. Release phases are the
  // cleanup and always run.
  const takeOfflinePhase = job.phase === 'enter' || job.phase === 'add';
  if (takeOfflinePhase && event.status !== 'active') {
    logger?.info(
      { eventId: event.id, phase: job.phase, status: event.status },
      'maintenance fan-out skipped: event no longer active',
    );
    return;
  }

  switch (job.phase) {
    case 'enter':
      await runEnterSideEffects(event, actor, logger);
      return;
    case 'release':
      await runReleaseStations(event, 'release', logger);
      return;
    case 'add':
      await runAddStationSideEffects(event, job.stationDbIds ?? [], actor, logger);
      return;
    case 'remove':
      await runRemoveStationSideEffects(event, job.stationDbIds ?? [], logger);
      return;
    case 'reassert':
      // The event may have completed or been cancelled between the station's
      // reconnect and this job running; re-asserting then would wrongly take
      // the station out of service.
      if (event.status !== 'active') {
        logger?.info(
          { eventId: event.id, status: event.status },
          'maintenance re-assert skipped: event no longer active',
        );
        return;
      }
      await runReassertStations(event, job.stationDbIds ?? [], logger);
      return;
  }
}

// Re-applies the maintenance state to stations that reconnected mid-window.
// A station offline during the enter fan-out (or one that rebooted and lost
// state) comes back reporting Available; this sends ChangeAvailability
// (Inoperative) and the slot 9005 message again for just those stations.
// Reservation cancels, session stops, counters, and audits already ran in the
// enter fan-out and are intentionally not repeated here.
export async function runReassertStations(
  event: MaintenanceEventRow,
  stationDbIds: string[],
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (stationDbIds.length === 0) return;
  const [[site], covered] = await Promise.all([
    db.select({ name: sites.name }).from(sites).where(eq(sites.id, event.siteId)),
    loadSiteStations(event.siteId, event.affectedStationIds),
  ]);
  // Only re-assert stations the event actually covers; the reconnect publish
  // carries whatever station came back, which may have been removed from the
  // event since.
  const targets = covered.filter((s) => stationDbIds.includes(s.id));
  if (targets.length === 0) return;
  const message = await renderMaintenanceMessage(client, event, site?.name ?? '');

  const statusBefore = await loadDerivedStatuses(targets.map((s) => s.id));
  const outcomes: FanoutStationOutcome[] = [];
  await mapWithConcurrency(targets, STATION_FANOUT_CONCURRENCY, async (station) => {
    const sent = await sendAvailabilityCommand(station.stationId, 'Inoperative', logger);
    outcomes.push({
      stationDbId: station.id,
      stationOcppId: station.stationId,
      ...sent,
    });
    try {
      await pushStationMessageSlot(
        station.stationId,
        station.ocppProtocol,
        STATION_MESSAGE_SLOT_UNAVAILABLE,
        'Unavailable',
        message,
      );
    } catch (err) {
      logger?.warn(
        { err, stationId: station.stationId },
        'maintenance message push failed during re-assert',
      );
    }
  });
  // No settle here: reasserts are single-station and arrive in bursts after a
  // fleet reconnect; the 5s settle made each queued job ~5s and a wave of
  // reconnects monopolized the serialized fan-out queue for minutes. The
  // drill-down's live currentStatus column is the accurate after-the-fact
  // reading for these rows.
  const statusAfter = await loadDerivedStatuses(targets.map((s) => s.id));
  await recordFanoutOutcomes(event.id, 'reassert', outcomes, statusBefore, statusAfter, logger);
  logger?.info({ eventId: event.id, stations: targets.length }, 'maintenance re-assert complete');
}

export async function getActiveMaintenanceForStation(
  stationId: string,
): Promise<MaintenanceEventRow | null> {
  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  if (station == null || station.siteId == null) return null;

  const now = new Date();
  const rows = await db
    .select()
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, station.siteId),
        eq(maintenanceEvents.status, 'active'),
        lt(maintenanceEvents.plannedStartAt, now),
        gt(maintenanceEvents.plannedEndAt, now),
        or(
          isNull(maintenanceEvents.affectedStationIds),
          sql`${maintenanceEvents.affectedStationIds} = '{}'::text[]`,
          sql`${stationId} = ANY(${maintenanceEvents.affectedStationIds})`,
        ),
      ),
    );
  const first = rows[0];
  return first != null ? rowFromDb(first) : null;
}

export async function getActiveMaintenanceForSite(
  siteId: string,
): Promise<MaintenanceEventRow | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, siteId),
        eq(maintenanceEvents.status, 'active'),
        lt(maintenanceEvents.plannedStartAt, now),
        gt(maintenanceEvents.plannedEndAt, now),
      ),
    );
  const first = rows[0];
  return first != null ? rowFromDb(first) : null;
}
