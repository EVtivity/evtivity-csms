// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, or, isNull, lt, gt, sql } from 'drizzle-orm';
import {
  db,
  client,
  maintenanceEvents,
  maintenanceEventAuditLog,
  chargingStations,
  chargingSessions,
  sites,
  reservations,
  writeAudit,
} from '@evtivity/database';
import { dispatchDriverNotification, AppError, renderMaintenanceMessage } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
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

export async function createEvent(input: CreateMaintenanceInput): Promise<MaintenanceEventRow> {
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
    await enterMaintenance(created.id, input.actor, input.logger);
    const refreshed = await loadEventById(created.id);
    return refreshed ?? created;
  }

  return created;
}

export async function enterMaintenance(
  eventId: string,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
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

  const [[site], stations] = await Promise.all([
    db.select({ name: sites.name }).from(sites).where(eq(sites.id, event.siteId)),
    loadSiteStations(event.siteId, event.affectedStationIds),
  ]);
  const siteName = site?.name ?? '';
  const message = await renderMaintenanceMessage(client, event, siteName);

  await Promise.all(
    stations.map(async (station) => {
      try {
        await sendOcppCommandAndWait(
          station.stationId,
          'ChangeAvailability',
          { operationalStatus: 'Inoperative', evse: { id: 0 } },
          station.ocppProtocol ?? undefined,
        );
      } catch (err) {
        logger?.warn(
          { err, stationId: station.stationId },
          'ChangeAvailability(Inoperative) failed',
        );
      }
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
    }),
  );

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
          { transactionId: sess.transactionId },
          stationInfo.ocppProtocol ?? undefined,
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

  const stations = await loadSiteStations(event.siteId, event.affectedStationIds);
  await Promise.all(
    stations.map(async (station) => {
      try {
        await sendOcppCommandAndWait(
          station.stationId,
          'ChangeAvailability',
          { operationalStatus: 'Operative', evse: { id: 0 } },
          station.ocppProtocol ?? undefined,
        );
      } catch (err) {
        logger?.warn({ err, stationId: station.stationId }, 'ChangeAvailability(Operative) failed');
      }
      try {
        await clearStationMessageSlot(
          station.stationId,
          station.ocppProtocol,
          STATION_MESSAGE_SLOT_UNAVAILABLE,
        );
      } catch (err) {
        logger?.warn({ err, stationId: station.stationId }, 'maintenance message clear failed');
      }
    }),
  );

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
}

export interface UpdateScheduledEventInput {
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  affectedStationIds?: string[] | null;
  activeSessionPolicy?: SessionPolicy;
  customMessage?: string | null;
  reason?: string | null;
}

export async function updateScheduledEvent(
  eventId: string,
  changes: UpdateScheduledEventInput,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
): Promise<MaintenanceEventRow> {
  const before = await loadEventById(eventId);
  if (before == null) {
    throw new AppError('Maintenance event not found', 404, 'MAINTENANCE_NOT_FOUND');
  }
  if (before.status !== 'scheduled') {
    throw new AppError('Only scheduled events can be edited', 409, 'MAINTENANCE_ALREADY_ACTIVE');
  }

  const start = changes.plannedStartAt ?? before.plannedStartAt;
  const end = changes.plannedEndAt ?? before.plannedEndAt;
  if (end.getTime() <= start.getTime()) {
    throw new AppError('Maintenance end must be after start', 400, 'MAINTENANCE_INVALID_RANGE');
  }

  if (changes.plannedStartAt !== undefined || changes.plannedEndAt !== undefined) {
    const overlaps = await findOverlappingScheduledEvents(before.siteId, start, end, eventId);
    if (overlaps.length > 0) {
      throw new AppError(
        'Maintenance window overlaps an existing event',
        409,
        'MAINTENANCE_OVERLAPS_EXISTING',
      );
    }
  }

  const updateSet: Record<string, unknown> = {
    plannedStartAt: start,
    plannedEndAt: end,
    updatedAt: new Date(),
  };
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

  const [updated] = await db
    .update(maintenanceEvents)
    .set(updateSet)
    .where(and(eq(maintenanceEvents.id, eventId), eq(maintenanceEvents.status, 'scheduled')))
    .returning();
  if (updated == null) {
    throw new AppError('Only scheduled events can be edited', 409, 'MAINTENANCE_ALREADY_ACTIVE');
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

  invalidateMaintenanceCheckCache();
  await publishStateChange(after.siteId, after.id);
  return after;
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

  if (before.status === 'active' && removed.length > 0) {
    const releasedStations = await db
      .select({
        id: chargingStations.id,
        stationId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
      })
      .from(chargingStations)
      .where(inArray(chargingStations.id, removed));

    await Promise.all(
      releasedStations.map(async (station) => {
        try {
          await sendOcppCommandAndWait(
            station.stationId,
            'ChangeAvailability',
            { operationalStatus: 'Operative', evse: { id: 0 } },
            station.ocppProtocol ?? undefined,
          );
        } catch (err) {
          logger?.warn(
            { err, stationId: station.stationId },
            'ChangeAvailability(Operative) failed on station release',
          );
        }
        try {
          await clearStationMessageSlot(
            station.stationId,
            station.ocppProtocol,
            STATION_MESSAGE_SLOT_UNAVAILABLE,
          );
        } catch (err) {
          logger?.warn(
            { err, stationId: station.stationId },
            'slot clear failed on station release',
          );
        }
      }),
    );
  }

  const [updated] = await db
    .update(maintenanceEvents)
    .set({ affectedStationIds: nextList, updatedAt: new Date() })
    .where(
      and(
        eq(maintenanceEvents.id, eventId),
        inArray(maintenanceEvents.status, ['scheduled', 'active']),
      ),
    )
    .returning();
  if (updated == null) {
    throw new AppError(
      'Only scheduled or active events can be edited',
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
  return after;
}

export async function cancelEvent(
  eventId: string,
  actor: MaintenanceActor,
  logger?: FastifyBaseLogger,
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

  if (wasActive) {
    const stations = await loadSiteStations(event.siteId, event.affectedStationIds);
    await Promise.all(
      stations.map(async (station) => {
        try {
          await sendOcppCommandAndWait(
            station.stationId,
            'ChangeAvailability',
            { operationalStatus: 'Operative', evse: { id: 0 } },
            station.ocppProtocol ?? undefined,
          );
        } catch (err) {
          logger?.warn(
            { err, stationId: station.stationId },
            'ChangeAvailability(Operative) failed on cancel',
          );
        }
        try {
          await clearStationMessageSlot(
            station.stationId,
            station.ocppProtocol,
            STATION_MESSAGE_SLOT_UNAVAILABLE,
          );
        } catch (err) {
          logger?.warn(
            { err, stationId: station.stationId },
            'maintenance message clear on cancel failed',
          );
        }
      }),
    );
  }

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

  const refreshed = await loadEventById(event.id);
  return refreshed ?? event;
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
