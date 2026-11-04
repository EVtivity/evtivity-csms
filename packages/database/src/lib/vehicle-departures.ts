// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DepartureReadiness, DepartureReadinessReason } from '@evtivity/lib/charging-plan';
import { createLogger } from '@evtivity/lib';
import { isDcConnector, type ConnectorPowerInput } from '@evtivity/lib/connector-power';
import type { ServiceLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { sites } from '../schema/assets.js';
import { chargingSessions } from '../schema/charging.js';
import { fleetDrivers, vehicles } from '../schema/drivers.js';
import { siteLoadManagement } from '../schema/load-management.js';
import {
  siteChargingPlans,
  vehicleDepartureNotices,
  vehicleDeparturePreconditioning,
  vehicleDepartures,
  vehicleDepartureSchedules,
  type DepartureCancelReason,
  type DepartureNoticeKind,
  type DepartureOutcome,
} from '../schema/departures.js';

// The only writer of vehicle_departure_schedules, vehicle_departures,
// vehicle_departure_notices, vehicle_departure_preconditioning and
// site_charging_plans (guard test
// departure-writer-guard.test.ts). No rules and no audit here: the departure
// service decides and audits. Every function takes the caller's transaction.
// Status changes only ever move a `scheduled` row, so a late write never
// overwrites a cancelled or completed departure.
//
// Stale marks are stored to the millisecond, so the planner can compare the
// mark it read (a JavaScript Date) with the stored one exactly.

const logger = createLogger('vehicle-departures');

export type VehicleDepartureSchedule = typeof vehicleDepartureSchedules.$inferSelect;
export type VehicleDeparture = typeof vehicleDepartures.$inferSelect;
export type NewVehicleDepartureSchedule = Omit<
  typeof vehicleDepartureSchedules.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;
export type NewVehicleDeparture = Omit<
  typeof vehicleDepartures.$inferInsert,
  | 'id'
  | 'status'
  | 'outcome'
  | 'readiness'
  | 'readinessReason'
  | 'plannedKwh'
  | 'deliveredKwh'
  | 'shortfallKwh'
  | 'predictedReadyAt'
  | 'predictedMaxReadyAt'
  | 'plannedAt'
  | 'cancelReason'
  | 'createdAt'
  | 'updatedAt'
>;
export type DepartureDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'
>;

/** The fields a schedule edit may change. */
export type ScheduleChanges = Partial<
  Pick<
    VehicleDepartureSchedule,
    | 'siteId'
    | 'daysOfWeek'
    | 'departureTime'
    | 'targetKind'
    | 'targetEnergyKwh'
    | 'targetSocPercent'
    | 'targetSocMaxPercent'
    | 'priority'
    | 'validFrom'
    | 'validTo'
    | 'isActive'
    | 'notes'
  >
>;

/** The fields a departure edit may change (an operator edit, or a schedule edit of an occurrence). */
export type DepartureChanges = Partial<
  Pick<
    VehicleDeparture,
    | 'siteId'
    | 'departureAt'
    | 'adHoc'
    | 'targetKind'
    | 'targetEnergyKwh'
    | 'targetSocPercent'
    | 'targetSocMaxPercent'
    | 'expectedArrivalAt'
    | 'expectedArrivalSocPercent'
    | 'requestedEvseId'
    | 'priority'
    | 'externalPriority'
    | 'sessionId'
    | 'overridden'
  >
>;

/** A vehicle as departure rules see it. */
export interface DepartureVehicle {
  id: string;
  driverId: string;
  batteryCapacityKwh: number | null;
  /** The vehicle's driver is a member of the fleet asked about. */
  inFleet: boolean;
}

export async function getDepartureVehicle(
  vehicleId: string,
  fleetId: string,
  tx: DepartureDb = db,
): Promise<DepartureVehicle | null> {
  const [row] = await tx
    .select({
      id: vehicles.id,
      driverId: vehicles.driverId,
      batteryCapacityKwh: vehicles.batteryCapacityKwh,
      fleetDriverId: fleetDrivers.id,
    })
    .from(vehicles)
    .leftJoin(
      fleetDrivers,
      and(eq(fleetDrivers.driverId, vehicles.driverId), eq(fleetDrivers.fleetId, fleetId)),
    )
    .where(eq(vehicles.id, vehicleId))
    .limit(1);
  if (row == null) return null;
  return {
    id: row.id,
    driverId: row.driverId,
    batteryCapacityKwh: row.batteryCapacityKwh == null ? null : Number(row.batteryCapacityKwh),
    inFleet: row.fleetDriverId != null,
  };
}

/** The battery capacity of a vehicle in kWh, null when unknown or the vehicle is gone. */
export async function getVehicleBatteryCapacity(
  vehicleId: string,
  tx: DepartureDb = db,
): Promise<number | null> {
  const [row] = await tx
    .select({ capacity: vehicles.batteryCapacityKwh })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));
  return row?.capacity == null ? null : Number(row.capacity);
}

export async function getDepartureSite(
  siteId: string,
  tx: DepartureDb = db,
): Promise<{ id: string; timezone: string } | null> {
  const [row] = await tx
    .select({ id: sites.id, timezone: sites.timezone })
    .from(sites)
    .where(eq(sites.id, siteId));
  return row ?? null;
}

export async function getDepartureSchedule(
  id: string,
  tx: DepartureDb = db,
  options: { forUpdate?: boolean; forShare?: boolean } = {},
): Promise<VehicleDepartureSchedule | null> {
  const query = tx
    .select()
    .from(vehicleDepartureSchedules)
    .where(eq(vehicleDepartureSchedules.id, id));
  const [row] =
    options.forUpdate === true
      ? await query.for('update')
      : options.forShare === true
        ? await query.for('share')
        : await query;
  return row ?? null;
}

export async function getDeparture(
  id: string,
  tx: DepartureDb = db,
  options: { forUpdate?: boolean } = {},
): Promise<VehicleDeparture | null> {
  const query = tx.select().from(vehicleDepartures).where(eq(vehicleDepartures.id, id));
  const [row] = options.forUpdate === true ? await query.for('update') : await query;
  return row ?? null;
}

export async function insertDepartureSchedule(
  values: NewVehicleDepartureSchedule,
  tx: DepartureDb = db,
): Promise<VehicleDepartureSchedule> {
  const [row] = await tx.insert(vehicleDepartureSchedules).values(values).returning();
  if (row == null) throw new Error('Departure schedule insert returned no row');
  return row;
}

export async function updateDepartureSchedule(
  id: string,
  changes: ScheduleChanges,
  tx: DepartureDb = db,
): Promise<VehicleDepartureSchedule | null> {
  const [row] = await tx
    .update(vehicleDepartureSchedules)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(vehicleDepartureSchedules.id, id))
    .returning();
  return row ?? null;
}

/** Deletes a schedule. Its occurrences stay, with no schedule (the foreign key sets null). */
export async function deleteDepartureSchedule(
  id: string,
  tx: DepartureDb = db,
): Promise<VehicleDepartureSchedule | null> {
  const [row] = await tx
    .delete(vehicleDepartureSchedules)
    .where(eq(vehicleDepartureSchedules.id, id))
    .returning();
  return row ?? null;
}

/**
 * The occurrences of a schedule that a schedule edit or delete may change:
 * scheduled, not overridden by a person, and still ahead. Locked for update.
 */
export async function futureScheduleOccurrences(
  scheduleId: string,
  now: Date,
  tx: DepartureDb = db,
): Promise<VehicleDeparture[]> {
  return tx
    .select()
    .from(vehicleDepartures)
    .where(
      and(
        eq(vehicleDepartures.scheduleId, scheduleId),
        eq(vehicleDepartures.status, 'scheduled'),
        eq(vehicleDepartures.overridden, false),
        gt(vehicleDepartures.departureAt, now),
      ),
    )
    .orderBy(asc(vehicleDepartures.departureAt), asc(vehicleDepartures.id))
    .for('update');
}

/**
 * The scheduled departures of a vehicle per local date (YYYY-MM-DD in the
 * given time zone), optionally without one departure. Takes a transaction lock
 * on the vehicle first, so two writers in parallel count each other's rows;
 * call it inside the transaction that inserts.
 */
export async function vehicleDayDepartureCounts(
  vehicleId: string,
  timeZone: string,
  tx: DepartureDb,
  excludeId?: string,
): Promise<Map<string, number>> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`vehicle-departures:${vehicleId}`}))`,
  );
  const rows = await tx
    .select({
      day: sql<string>`to_char(${vehicleDepartures.departureAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(vehicleDepartures)
    .where(
      and(
        eq(vehicleDepartures.vehicleId, vehicleId),
        eq(vehicleDepartures.status, 'scheduled'),
        ...(excludeId != null ? [sql`${vehicleDepartures.id} <> ${excludeId}`] : []),
      ),
    )
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.day, r.count]));
}

export async function insertDeparture(
  values: NewVehicleDeparture,
  tx: DepartureDb = db,
): Promise<VehicleDeparture> {
  const [row] = await tx.insert(vehicleDepartures).values(values).returning();
  if (row == null) throw new Error('Departure insert returned no row');
  return row;
}

/**
 * Inserts schedule occurrences, one row per schedule and local date: an
 * occurrence that exists (in any status) is left alone, so the expansion can
 * run twice. Returns the rows it created.
 */
export async function insertScheduleOccurrences(
  rows: NewVehicleDeparture[],
  tx: DepartureDb = db,
): Promise<VehicleDeparture[]> {
  if (rows.length === 0) return [];
  for (const row of rows) {
    if (row.scheduleId == null || row.occurrenceDate == null) {
      throw new Error('A schedule occurrence needs its schedule and local date');
    }
  }
  return tx
    .insert(vehicleDepartures)
    .values(rows)
    .onConflictDoNothing({
      target: [vehicleDepartures.scheduleId, vehicleDepartures.occurrenceDate],
      where: sql`${vehicleDepartures.scheduleId} IS NOT NULL`,
    })
    .returning();
}

/** Changes a departure that is still scheduled; null when it is not (or does not exist). */
export async function updateScheduledDeparture(
  id: string,
  changes: DepartureChanges,
  tx: DepartureDb = db,
): Promise<VehicleDeparture | null> {
  const [row] = await tx
    .update(vehicleDepartures)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(vehicleDepartures.id, id), eq(vehicleDepartures.status, 'scheduled')))
    .returning();
  return row ?? null;
}

/**
 * Cancels the departures that are still scheduled; returns the ones it
 * cancelled. `reason` names a cancel no person made (a depot system).
 */
export async function cancelScheduledDepartures(
  ids: string[],
  tx: DepartureDb = db,
  reason: DepartureCancelReason | null = null,
): Promise<VehicleDeparture[]> {
  if (ids.length === 0) return [];
  return tx
    .update(vehicleDepartures)
    .set({ status: 'cancelled', cancelReason: reason, updatedAt: sql`now()` })
    .where(and(inArray(vehicleDepartures.id, ids), eq(vehicleDepartures.status, 'scheduled')))
    .returning();
}

/** The preconditioning of a departure as stored (one row per departure). */
export type DeparturePreconditioning = typeof vehicleDeparturePreconditioning.$inferSelect;
export type DeparturePreconditioningValues = Omit<
  typeof vehicleDeparturePreconditioning.$inferInsert,
  'departureId' | 'updatedAt'
>;

/** Sets or removes (null) the preconditioning of a departure that is still scheduled. */
export async function setDeparturePreconditioning(
  departureId: string,
  values: DeparturePreconditioningValues | null,
  tx: DepartureDb = db,
): Promise<void> {
  if (values == null) {
    await tx
      .delete(vehicleDeparturePreconditioning)
      .where(eq(vehicleDeparturePreconditioning.departureId, departureId));
    return;
  }
  await tx
    .insert(vehicleDeparturePreconditioning)
    .values({ departureId, ...values, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: vehicleDeparturePreconditioning.departureId,
      set: { ...values, updatedAt: sql`now()` },
    });
}

export async function getDeparturePreconditioning(
  departureIds: string[],
  tx: DepartureDb = db,
): Promise<Map<string, DeparturePreconditioning>> {
  if (departureIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(vehicleDeparturePreconditioning)
    .where(inArray(vehicleDeparturePreconditioning.departureId, departureIds));
  return new Map(rows.map((r) => [r.departureId, r]));
}

/**
 * The scheduled departures of a depot system, locked for update, so a list
 * apply decides on rows no other apply changes meanwhile.
 */
export async function lockDepotSystemDepartures(
  depotSystemId: string,
  tx: DepartureDb,
): Promise<VehicleDeparture[]> {
  return tx
    .select()
    .from(vehicleDepartures)
    .where(
      and(
        eq(vehicleDepartures.depotSystemId, depotSystemId),
        eq(vehicleDepartures.status, 'scheduled'),
      ),
    )
    .orderBy(asc(vehicleDepartures.id))
    .for('update');
}

/**
 * Serializes the request lists of every depot system for the rest of the
 * transaction, so two systems applying at once cannot both take one vehicle
 * (decision D9): the caller reads the holders again after it.
 */
export async function lockDepotSystemVehicleHolds(tx: DepartureDb): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('evtivity:depot_system_vehicle_holds'))`,
  );
}

/**
 * Scheduled departures of other depot systems for these vehicles, so a second
 * system cannot take a vehicle another one holds.
 */
export async function otherSystemVehicleIds(
  depotSystemId: string,
  vehicleIds: string[],
  tx: DepartureDb = db,
): Promise<Set<string>> {
  if (vehicleIds.length === 0) return new Set();
  const rows = await tx
    .select({ vehicleId: vehicleDepartures.vehicleId })
    .from(vehicleDepartures)
    .where(
      and(
        inArray(vehicleDepartures.vehicleId, vehicleIds),
        eq(vehicleDepartures.status, 'scheduled'),
        isNotNull(vehicleDepartures.depotSystemId),
        sql`${vehicleDepartures.depotSystemId} <> ${depotSystemId}`,
      ),
    );
  return new Set(rows.map((r) => r.vehicleId));
}

/**
 * Manual, imported and schedule departures of a vehicle at a site within
 * `windowMs` of `at`: a depot system request for that vehicle supersedes them.
 */
export async function supersedableDepartures(
  vehicleId: string,
  siteId: string,
  at: Date,
  windowMs: number,
  tx: DepartureDb,
): Promise<VehicleDeparture[]> {
  return tx
    .select()
    .from(vehicleDepartures)
    .where(
      and(
        eq(vehicleDepartures.vehicleId, vehicleId),
        eq(vehicleDepartures.siteId, siteId),
        eq(vehicleDepartures.status, 'scheduled'),
        inArray(vehicleDepartures.source, ['manual', 'schedule', 'import']),
        sql`${vehicleDepartures.departureAt} BETWEEN ${new Date(at.getTime() - windowMs).toISOString()}::timestamptz AND ${new Date(at.getTime() + windowMs).toISOString()}::timestamptz`,
      ),
    )
    .for('update');
}

/**
 * A depot system is deleted: its scheduled departures become manual ones an
 * operator owns, so they keep planning and can be edited. Ended ones keep
 * their source. Returns the ids changed.
 */
export async function releaseDepotSystemDepartures(
  depotSystemId: string,
  tx: DepartureDb,
  /** Only the departures at these sites (a site the system no longer serves). */
  siteIds?: readonly string[],
): Promise<string[]> {
  if (siteIds?.length === 0) return [];
  const rows = await tx
    .update(vehicleDepartures)
    .set({
      source: 'manual',
      depotSystemId: null,
      externalRequestId: null,
      externalPriority: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(vehicleDepartures.depotSystemId, depotSystemId),
        eq(vehicleDepartures.status, 'scheduled'),
        siteIds != null ? inArray(vehicleDepartures.siteId, [...siteIds]) : undefined,
      ),
    )
    .returning({ id: vehicleDepartures.id });
  return rows.map((r) => r.id);
}

/**
 * Deletes schedule occurrences that nothing refers to yet: still scheduled,
 * not overridden, ahead of `now`, without a session and without a notice. A
 * schedule edit removes these instead of cancelling them, so a day added back
 * (or a schedule turned on again) gets a fresh occurrence. Returns the rows it
 * deleted; the caller cancels the others.
 */
export async function deleteUnusedScheduleOccurrences(
  ids: string[],
  now: Date,
  tx: DepartureDb = db,
): Promise<VehicleDeparture[]> {
  if (ids.length === 0) return [];
  return tx
    .delete(vehicleDepartures)
    .where(
      and(
        inArray(vehicleDepartures.id, ids),
        eq(vehicleDepartures.status, 'scheduled'),
        eq(vehicleDepartures.overridden, false),
        isNull(vehicleDepartures.sessionId),
        gt(vehicleDepartures.departureAt, now),
        sql`NOT EXISTS (SELECT 1 FROM vehicle_departure_notices n WHERE n.departure_id = ${vehicleDepartures.id})`,
      ),
    )
    .returning();
}

/**
 * Deletes completed and cancelled departures whose departure time is more
 * than `retentionDays` days ago (their notices go with them). Zero or less
 * keeps every row. Returns the number deleted.
 */
export async function pruneEndedDepartures(
  retentionDays: number,
  tx: DepartureDb = db,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const rows = await tx
    .delete(vehicleDepartures)
    .where(
      and(
        inArray(vehicleDepartures.status, ['completed', 'cancelled']),
        // An ad hoc departure has no time: its last change stands in for it.
        lt(
          sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.updatedAt})`,
          sql`now() - make_interval(days => ${Math.floor(retentionDays)})`,
        ),
      ),
    )
    .returning({ id: vehicleDepartures.id });
  return rows.length;
}

/** The ids of active schedules still valid on or after `today` (a local date, YYYY-MM-DD). */
export async function listExpandableScheduleIds(
  today: string,
  tx: DepartureDb = db,
): Promise<string[]> {
  const rows = await tx
    .select({ id: vehicleDepartureSchedules.id })
    .from(vehicleDepartureSchedules)
    .where(
      and(
        eq(vehicleDepartureSchedules.isActive, true),
        or(
          isNull(vehicleDepartureSchedules.validTo),
          sql`${vehicleDepartureSchedules.validTo} >= (${today}::date - 1)`,
        ),
      ),
    )
    .orderBy(asc(vehicleDepartureSchedules.id));
  return rows.map((r) => r.id);
}

/** A departure `completePassedDepartures` completed. */
export interface CompletedDeparture {
  id: string;
  siteId: string;
  outcome: DepartureOutcome;
}

/**
 * The completion UPDATE: scheduled departures whose time is at or before
 * `now`, oldest first, at most `limit`, with the outcome from the bound
 * session (met: ready, or the session delivered the energy or reached the
 * state of charge target; no_vehicle: never bound; else short) and the
 * delivered energy of that session. Rows another run holds are skipped.
 */
export function completePassedDeparturesSql(now: Date, limit: number): SQL {
  return sql`UPDATE vehicle_departures AS d SET
      status = 'completed',
      outcome = CASE
        WHEN d.readiness = 'ready'
          OR (d.target_kind = 'energy' AND x.energy_wh IS NOT NULL
            AND x.energy_wh / 1000 >= d.target_energy_kwh)
          OR (d.target_kind = 'soc' AND x.soc IS NOT NULL AND x.soc >= d.target_soc_percent)
          THEN 'met'
        WHEN d.session_id IS NULL THEN 'no_vehicle'
        ELSE 'short'
      END,
      delivered_kwh = COALESCE(round(x.energy_wh / 1000, 2), d.delivered_kwh),
      updated_at = now()
    FROM (
      SELECT d2.id, s.energy_delivered_wh AS energy_wh, s.last_soc_percent AS soc
      FROM vehicle_departures d2
      LEFT JOIN charging_sessions s ON s.id = d2.session_id
      WHERE d2.status = 'scheduled' AND (
        d2.departure_at <= ${now.toISOString()}::timestamptz
        -- An ad hoc departure ends with its session, or a day after it was
        -- requested when no vehicle ever plugged in.
        OR (d2.ad_hoc AND (
          (d2.session_id IS NOT NULL AND s.status IS DISTINCT FROM 'active')
          OR (d2.session_id IS NULL AND d2.created_at <= ${now.toISOString()}::timestamptz - interval '24 hours')
        ))
      )
      ORDER BY COALESCE(d2.departure_at, d2.created_at), d2.id
      LIMIT ${limit}
      FOR UPDATE OF d2 SKIP LOCKED
    ) AS x
    WHERE d.id = x.id AND d.status = 'scheduled'
    RETURNING d.id, d.site_id, d.outcome`;
}

/**
 * Completes departures whose time passed (status guarded: a cancelled or
 * completed row never changes). Returns the rows it completed.
 */
export async function completePassedDepartures(
  now: Date,
  limit = 1000,
  tx: DepartureDb = db,
): Promise<CompletedDeparture[]> {
  const rows = (await tx.execute(completePassedDeparturesSql(now, limit))) as unknown as Array<{
    id: string;
    site_id: string;
    outcome: DepartureOutcome;
  }>;
  return rows.map((r) => ({ id: r.id, siteId: r.site_id, outcome: r.outcome }));
}

/**
 * Claims the one notice of a kind for a departure. True for the caller that
 * claimed it, false when it was sent before (a re-plan never notifies twice).
 */
export async function claimDepartureNotice(
  departureId: string,
  kind: DepartureNoticeKind,
  tx: DepartureDb = db,
): Promise<boolean> {
  const rows = await tx
    .insert(vehicleDepartureNotices)
    .values({ departureId, kind })
    .onConflictDoNothing()
    .returning({ departureId: vehicleDepartureNotices.departureId });
  return rows.length > 0;
}

const STALE_NOW = sql`date_trunc('milliseconds', clock_timestamp())`;

/** The stale mark of a site's plan as stored, for the planner to pass back to `writeSitePlan`. */
export async function getSitePlanStaleAt(
  siteId: string,
  tx: DepartureDb = db,
): Promise<Date | null> {
  const [row] = await tx
    .select({ staleAt: siteChargingPlans.staleAt })
    .from(siteChargingPlans)
    .where(eq(siteChargingPlans.siteId, siteId));
  return row?.staleAt ?? null;
}

/**
 * Marks the site's plan stale, so the next load management cycle plans again
 * (creates the plan row, without a plan, when the site has none). Never throws:
 * a missed mark is healed by the next slot boundary, so a failure is logged.
 */
export async function markSitePlanStale(
  siteId: string,
  trigger: string,
  log: ServiceLogger = logger,
  options: { departureAwareOnly?: boolean } = {},
): Promise<boolean> {
  try {
    if (options.departureAwareOnly === true) {
      // Only a site that plans departures gets a plan row: one statement, so
      // the strategy read and the mark cannot disagree.
      await db.execute(sql`INSERT INTO site_charging_plans (site_id, computed_at, stale_at, trigger)
        SELECT ${siteId}, now(), ${STALE_NOW}, ${trigger}
        WHERE EXISTS (
          SELECT 1 FROM site_load_management
          WHERE site_id = ${siteId} AND strategy = 'departure_aware'
        )
        ON CONFLICT (site_id) DO UPDATE SET stale_at = EXCLUDED.stale_at, trigger = EXCLUDED.trigger`);
      return true;
    }
    await db
      .insert(siteChargingPlans)
      .values({ siteId, computedAt: sql`now()`, staleAt: STALE_NOW, trigger })
      .onConflictDoUpdate({
        target: siteChargingPlans.siteId,
        set: { staleAt: STALE_NOW, trigger },
      });
    return true;
  } catch (err: unknown) {
    log.warn(
      { err, siteId, trigger },
      'Site charging plan not marked stale, the next cycle replans',
    );
    return false;
  }
}

/** The stored plan row of a site, as the load management cycle reads it. */
export interface StoredSitePlan {
  computedAt: Date;
  staleAt: Date | null;
  trigger: string | null;
  slotStarts: unknown;
  plan: unknown;
}

export async function getSitePlan(
  siteId: string,
  tx: DepartureDb = db,
): Promise<StoredSitePlan | null> {
  const [row] = await tx
    .select({
      computedAt: siteChargingPlans.computedAt,
      staleAt: siteChargingPlans.staleAt,
      trigger: siteChargingPlans.trigger,
      slotStarts: siteChargingPlans.slotStarts,
      plan: siteChargingPlans.plan,
    })
    .from(siteChargingPlans)
    .where(eq(siteChargingPlans.siteId, siteId));
  return row ?? null;
}

/** What the planner needs to know about a site besides its electrical tree. */
export interface SitePlanSettings {
  timezone: string;
  bufferMinutes: number;
}

export async function getSitePlanSettings(
  siteId: string,
  tx: DepartureDb = db,
): Promise<SitePlanSettings | null> {
  const [row] = await tx
    .select({
      timezone: sites.timezone,
      bufferMinutes: siteLoadManagement.departureBufferMinutes,
    })
    .from(sites)
    .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
    .where(eq(sites.id, siteId));
  if (row == null) return null;
  return { timezone: row.timezone, bufferMinutes: row.bufferMinutes ?? 30 };
}

/** A scheduled departure of a site, with what the planner reads of its vehicle. */
export interface PlanDepartureRow {
  id: string;
  vehicleId: string;
  /** Null for an ad hoc departure (charge from arrival, no departure time). */
  departureAt: Date | null;
  adHoc?: boolean;
  targetKind: 'energy' | 'soc';
  targetEnergyKwh: number | null;
  /** The minimum target SoC. */
  targetSocPercent: number | null;
  targetSocMaxPercent?: number | null;
  expectedArrivalAt?: Date | null;
  expectedArrivalSocPercent?: number | null;
  requestedEvseId?: string | null;
  /** The station of the requested EVSE. */
  requestedStationDbId?: string | null;
  /**
   * A cancelled request a depot system terminated whose session still
   * charges: planned at zero power until the session ends.
   */
  held?: boolean;
  priority: number;
  sessionId: string | null;
  batteryCapacityKwh: number | null;
  maxChargePowerKw: number | null;
  /** The vehicle's preconditioning power and automatic window length. */
  preconditioningPowerKw?: number | null;
  preconditioningMinutes?: number;
  preconditioning?: PlanPreconditioning | null;
  /** The depot system that requested it, null for an operator departure. */
  depotSystemId?: string | null;
  externalRequestId?: string | null;
  createdAt?: Date;
}

/** A departure's preconditioning as the planner reads it (kW as numbers). */
export interface PlanPreconditioning {
  climate: string | null;
  startAt: Date | null;
  finishAt: Date | null;
  hvacStartAt: Date | null;
  hvacKw: number | null;
  systemStartAt: Date | null;
  systemKw: number | null;
}

function numberOrNull(value: string | number | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Scheduled departures of a site up to `until`, past ones included until the
 * close job completes them, and every scheduled ad hoc departure (first).
 */
export async function listPlanDepartures(
  siteId: string,
  until: Date,
  tx: DepartureDb = db,
): Promise<PlanDepartureRow[]> {
  const rows = await tx
    .select({
      id: vehicleDepartures.id,
      vehicleId: vehicleDepartures.vehicleId,
      departureAt: vehicleDepartures.departureAt,
      adHoc: vehicleDepartures.adHoc,
      held: sql<boolean>`(${vehicleDepartures.status} = 'cancelled')`,
      requestedStationDbId: sql<
        string | null
      >`(SELECT e.station_id FROM evses e WHERE e.id = ${vehicleDepartures.requestedEvseId})`,
      targetKind: vehicleDepartures.targetKind,
      targetEnergyKwh: vehicleDepartures.targetEnergyKwh,
      targetSocPercent: vehicleDepartures.targetSocPercent,
      targetSocMaxPercent: vehicleDepartures.targetSocMaxPercent,
      expectedArrivalAt: vehicleDepartures.expectedArrivalAt,
      expectedArrivalSocPercent: vehicleDepartures.expectedArrivalSocPercent,
      requestedEvseId: vehicleDepartures.requestedEvseId,
      priority: vehicleDepartures.priority,
      sessionId: vehicleDepartures.sessionId,
      depotSystemId: vehicleDepartures.depotSystemId,
      externalRequestId: vehicleDepartures.externalRequestId,
      createdAt: vehicleDepartures.createdAt,
      batteryCapacityKwh: vehicles.batteryCapacityKwh,
      maxChargePowerKw: vehicles.maxChargePowerKw,
      preconditioningPowerKw: vehicles.preconditioningPowerKw,
      preconditioningMinutes: vehicles.preconditioningMinutes,
      pClimate: vehicleDeparturePreconditioning.climate,
      pStartAt: vehicleDeparturePreconditioning.startAt,
      pFinishAt: vehicleDeparturePreconditioning.finishAt,
      pHvacStartAt: vehicleDeparturePreconditioning.hvacStartAt,
      pHvacKw: vehicleDeparturePreconditioning.hvacKw,
      pSystemStartAt: vehicleDeparturePreconditioning.systemStartAt,
      pSystemKw: vehicleDeparturePreconditioning.systemKw,
      pDepartureId: vehicleDeparturePreconditioning.departureId,
    })
    .from(vehicleDepartures)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDepartures.vehicleId))
    .leftJoin(
      vehicleDeparturePreconditioning,
      eq(vehicleDeparturePreconditioning.departureId, vehicleDepartures.id),
    )
    .where(
      and(
        eq(vehicleDepartures.siteId, siteId),
        or(
          and(
            eq(vehicleDepartures.status, 'scheduled'),
            or(lt(vehicleDepartures.departureAt, until), eq(vehicleDepartures.adHoc, true)),
          ),
          // A request a depot system terminated holds its still active session
          // at zero power (decision D5), so the session stays in the plan.
          and(
            eq(vehicleDepartures.status, 'cancelled'),
            eq(vehicleDepartures.cancelReason, 'terminated_by_depot_system'),
            sql`EXISTS (SELECT 1 FROM charging_sessions s WHERE s.id = ${vehicleDepartures.sessionId} AND s.status = 'active')`,
          ),
        ),
      ),
    )
    .orderBy(
      sql`${vehicleDepartures.departureAt} ASC NULLS FIRST`,
      asc(vehicleDepartures.createdAt),
      asc(vehicleDepartures.id),
    );
  return rows.map(
    ({
      pClimate,
      pStartAt,
      pFinishAt,
      pHvacStartAt,
      pHvacKw,
      pSystemStartAt,
      pSystemKw,
      pDepartureId,
      ...row
    }) => ({
      ...row,
      targetEnergyKwh: numberOrNull(row.targetEnergyKwh),
      batteryCapacityKwh: numberOrNull(row.batteryCapacityKwh),
      maxChargePowerKw: numberOrNull(row.maxChargePowerKw),
      preconditioningPowerKw: numberOrNull(row.preconditioningPowerKw),
      preconditioning:
        pDepartureId == null
          ? null
          : {
              climate: pClimate,
              startAt: pStartAt,
              finishAt: pFinishAt,
              hvacStartAt: pHvacStartAt,
              hvacKw: numberOrNull(pHvacKw),
              systemStartAt: pSystemStartAt,
              systemKw: numberOrNull(pSystemKw),
            },
    }),
  );
}

/** An active session on a station of the site, with its vehicle and EVSE limits. */
export interface PlanSessionRow {
  id: string;
  stationDbId: string;
  evseDbId: string | null;
  vehicleId: string | null;
  transactionId: string;
  energyDeliveredWh: number;
  lastSocPercent: number | null;
  lastSocAt: Date | null;
  /** Highest connector rating of the session's EVSE, null when unknown. */
  evseMaxKw: number | null;
  /** The EVSE has connectors and none of them is DC. */
  acCharging: boolean;
  /** The OCPP number of the session's EVSE, null without one. */
  evseNumber: number | null;
  /** When the session started: charging needs older than it belong to an earlier EV. */
  startedAt?: Date | null;
}

export async function listPlanSessions(
  stationDbIds: string[],
  tx: DepartureDb = db,
): Promise<PlanSessionRow[]> {
  if (stationDbIds.length === 0) return [];
  const rows = await tx
    .select({
      id: chargingSessions.id,
      stationDbId: chargingSessions.stationId,
      evseDbId: chargingSessions.evseId,
      vehicleId: chargingSessions.vehicleId,
      transactionId: chargingSessions.transactionId,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      lastSocPercent: chargingSessions.lastSocPercent,
      lastSocAt: chargingSessions.lastSocAt,
      startedAt: chargingSessions.startedAt,
      evseMaxKw: sql<
        string | null
      >`(SELECT max(c.max_power_kw) FROM connectors c WHERE c.evse_id = "charging_sessions"."evse_id")`,
      evseNumber: sql<
        number | null
      >`(SELECT e.evse_id FROM evses e WHERE e.id = "charging_sessions"."evse_id")`,
      evseConnectors: sql<
        ConnectorPowerInput[] | null
      >`(SELECT json_agg(json_build_object('connectorType', c.connector_type, 'maxPowerKw', c.max_power_kw)) FROM connectors c WHERE c.evse_id = "charging_sessions"."evse_id")`,
    })
    .from(chargingSessions)
    .where(
      and(eq(chargingSessions.status, 'active'), inArray(chargingSessions.stationId, stationDbIds)),
    );
  return rows.map(({ evseConnectors, ...row }) => {
    const evseMaxKw = numberOrNull(row.evseMaxKw);
    const connectors = Array.isArray(evseConnectors) ? evseConnectors : [];
    return {
      ...row,
      acCharging: connectors.length > 0 && !connectors.some(isDcConnector),
      energyDeliveredWh: numberOrNull(row.energyDeliveredWh) ?? 0,
      lastSocPercent: numberOrNull(row.lastSocPercent),
      evseMaxKw: evseMaxKw != null && evseMaxKw > 0 ? evseMaxKw : null,
    };
  });
}

/**
 * Records which session charges for each departure (`vehicle_departures.session_id`).
 * Scheduled departures of the site only, and only rows that change. Returns the
 * ids written.
 */
export async function bindDepartureSessions(
  siteId: string,
  bindings: Array<{ departureId: string; sessionId: string | null }>,
  tx: DepartureDb = db,
): Promise<string[]> {
  if (bindings.length === 0) return [];
  const values = sql.join(
    bindings.map((b) => sql`(${b.departureId}::text, ${b.sessionId}::text)`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`UPDATE vehicle_departures AS d SET
      session_id = v.session_id,
      updated_at = now()
    FROM (VALUES ${values}) AS v(id, session_id)
    WHERE d.id = v.id
      AND d.site_id = ${siteId}
      AND d.status = 'scheduled'
      AND d.session_id IS DISTINCT FROM v.session_id
    RETURNING d.id`)) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

type PlanEntryRecord = Record<string, unknown>;

function isEntry(value: unknown): value is PlanEntryRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function patched(entry: PlanEntryRecord, patch: Record<string, unknown>): PlanEntryRecord {
  const merged: PlanEntryRecord = { ...entry, ...patch };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
}

/**
 * Merges fields into the stored plan entries of the sessions named (a null
 * value removes the field): the profile sent to the station and the
 * measurement state of each planned session. Locks the plan row; returns the
 * number of entries changed. A plan written meanwhile keeps its own entries.
 */
export async function patchSitePlanEntries(
  siteId: string,
  patches: Array<{ sessionId: string; patch: Record<string, unknown> }>,
  tx: DepartureDb = db,
): Promise<number> {
  if (patches.length === 0) return 0;
  const bySession = new Map(patches.map((p) => [p.sessionId, p.patch]));
  return tx.transaction(async (t) => {
    const [row] = await t
      .select({ plan: siteChargingPlans.plan })
      .from(siteChargingPlans)
      .where(eq(siteChargingPlans.siteId, siteId))
      .for('update');
    if (row == null || !Array.isArray(row.plan)) return 0;
    let changed = 0;
    const next = (row.plan as unknown[]).map((entry) => {
      if (!isEntry(entry) || typeof entry['sessionId'] !== 'string') return entry;
      const patch = bySession.get(entry['sessionId']);
      if (patch == null) return entry;
      changed += 1;
      return patched(entry, patch);
    });
    if (changed > 0) {
      await t
        .update(siteChargingPlans)
        .set({ plan: next })
        .where(eq(siteChargingPlans.siteId, siteId));
    }
    return changed;
  });
}

/** What became of a planned TxProfile: the station's answer, or no answer at all. */
export type PlanProfileReplyOutcome = 'accepted' | 'rejected' | 'not_sent';

export interface PlanProfileReplyOptions {
  /** Hash of the request the reply answers: a reply to an older profile is ignored. */
  hash?: string | null;
  /** The rate unit of a refused request, so the next send uses the other one. */
  rejectedUnit?: 'A' | 'W' | null;
}

/**
 * Records what became of a planned TxProfile (`profile.id` of the entry on
 * that station): `accepted`, `rejected` with its time (retried at most once an
 * hour, and its unit kept so the next send uses the other one), or `not_sent`
 * (no answer or a send failure: sent again at the next slot). A reply whose
 * request hash is not the one stored answers an older profile and changes
 * nothing. Returns the site and whether the state changed, or null when no
 * plan entry has the profile.
 */
export async function recordChargingPlanProfileReply(
  stationDbId: string,
  profileId: number,
  outcome: PlanProfileReplyOutcome,
  at: Date = new Date(),
  options: PlanProfileReplyOptions = {},
  tx: DepartureDb = db,
): Promise<{ siteId: string; changed: boolean; stale: boolean } | null> {
  return tx.transaction(async (t) => {
    const rows = (await t.execute(sql`SELECT p.site_id, p.plan
      FROM site_charging_plans p
      JOIN charging_stations s ON s.site_id = p.site_id
      WHERE s.id = ${stationDbId}
      FOR UPDATE OF p`)) as unknown as Array<{ site_id: string; plan: unknown }>;
    const row = rows[0];
    if (row == null || !Array.isArray(row.plan)) return null;
    const seen = { found: false, changed: false, stale: false };
    const next = (row.plan as unknown[]).map((entry) => {
      if (!isEntry(entry) || entry['stationDbId'] !== stationDbId) return entry;
      const profile = entry['profile'];
      if (!isEntry(profile) || profile['id'] !== profileId) return entry;
      seen.found = true;
      if (options.hash != null && profile['hash'] !== options.hash) {
        seen.stale = true;
        return entry;
      }
      const units = Array.isArray(profile['rejectedUnits'])
        ? (profile['rejectedUnits'] as unknown[]).filter(
            (u): u is 'A' | 'W' => u === 'A' || u === 'W',
          )
        : [];
      const newUnit =
        outcome === 'rejected' &&
        options.rejectedUnit != null &&
        !units.includes(options.rejectedUnit)
          ? options.rejectedUnit
          : null;
      if (profile['state'] === outcome && newUnit == null) return entry;
      seen.changed = true;
      const rest = Object.fromEntries(
        Object.entries(profile).filter(([key]) => key !== 'rejectedAt' && key !== 'rejectedUnits'),
      );
      const rejectedUnits = newUnit != null ? [...units, newUnit] : units;
      return {
        ...entry,
        profile: {
          ...rest,
          state: outcome,
          repliedAt: at.toISOString(),
          ...(outcome === 'rejected' ? { rejectedAt: at.toISOString() } : {}),
          ...(rejectedUnits.length > 0 ? { rejectedUnits } : {}),
        },
      };
    });
    if (!seen.found) return null;
    if (seen.changed) {
      await t
        .update(siteChargingPlans)
        .set({ plan: next })
        .where(eq(siteChargingPlans.siteId, row.site_id));
    }
    return { siteId: row.site_id, changed: seen.changed, stale: seen.stale };
  });
}

/**
 * The plan to store, merged with the row locked for the write: the profile
 * state of each session comes from the locked row (a reply or a send stored
 * while the planner ran wins over the copy it read), the measurement state
 * from the new entry when the planner measured, else the locked one. A
 * session that leaves the plan while the station still holds its TxProfile
 * stays as a `left` entry until the dispatcher has cleared that profile.
 */
export function mergeLockedPlanEntries(next: unknown, locked: unknown): unknown {
  if (!Array.isArray(next)) return next;
  const lockedEntries = Array.isArray(locked) ? (locked as unknown[]).filter(isEntry) : [];
  const lockedBySession = new Map<string, PlanEntryRecord>();
  for (const entry of lockedEntries) {
    const sessionId = entry['sessionId'];
    if (typeof sessionId !== 'string') continue;
    // A planned entry wins over a left one of the same session.
    if (lockedBySession.has(sessionId) && entry['left'] === true) continue;
    lockedBySession.set(sessionId, entry);
  }
  const planned = new Set<string>();
  const merged: unknown[] = (next as unknown[]).map((entry) => {
    if (!isEntry(entry) || typeof entry['sessionId'] !== 'string') return entry;
    planned.add(entry['sessionId']);
    const previous = lockedBySession.get(entry['sessionId']);
    const out: PlanEntryRecord = Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== 'profile'),
    );
    if (previous != null && isEntry(previous['profile'])) out['profile'] = previous['profile'];
    if (out['measure'] == null && previous != null && isEntry(previous['measure'])) {
      out['measure'] = previous['measure'];
    }
    return out;
  });
  for (const [sessionId, entry] of lockedBySession) {
    if (planned.has(sessionId)) continue;
    const profile = entry['profile'];
    if (!isEntry(profile) || profile['state'] === 'cleared') continue;
    merged.push({ ...entry, left: true });
  }
  return merged;
}

/** The stored plan of a site (one row per site). */
export interface SitePlanWrite {
  /**
   * The stale mark the planner read before it planned (`getSitePlanStaleAt`).
   * The write clears the mark only when it is still that value, so a mark
   * made while the planner ran survives and the next cycle plans again.
   */
  staleAtRead: Date | null;
  trigger: string | null;
  slotStarts: unknown;
  plan: unknown;
  siteLoadKw: unknown;
  capacityKw: unknown;
  pricePerKwh: unknown;
  runtimeMs: number | null;
}

/** The planner's view of one departure. A null readiness (departed) leaves the stored row alone. */
export interface DepartureReadinessWrite {
  departureId: string;
  readiness: DepartureReadiness | null;
  readinessReason: DepartureReadinessReason | null;
  plannedKwh: number | null;
  deliveredKwh: number | null;
  shortfallKwh: number | null;
  predictedReadyAt: Date | null;
  /** When the plan reaches the maximum target SoC; null without one or when out of reach. */
  predictedMaxReadyAt?: Date | null;
}

export interface SitePlanWriteResult {
  /** The departures whose stored planner fields changed, with their new readiness. */
  changed: Array<{
    id: string;
    readiness: DepartureReadiness | null;
    readinessReason: DepartureReadinessReason | null;
  }>;
}

const READINESS_CHUNK = 1000;

function kwhParam(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : value.toFixed(2);
}

/** One VALUES row of the readiness update, every value cast so the first row types the column. */
function readinessRow(entry: DepartureReadinessWrite): SQL {
  return sql`(${entry.departureId}::text, ${entry.readiness}::varchar, ${entry.readinessReason}::varchar, ${kwhParam(entry.plannedKwh)}::numeric(8,2), ${kwhParam(entry.deliveredKwh)}::numeric(8,2), ${kwhParam(entry.shortfallKwh)}::numeric(8,2), ${entry.predictedReadyAt?.toISOString() ?? null}::timestamptz, ${entry.predictedMaxReadyAt?.toISOString() ?? null}::timestamptz)`;
}

/** The batched readiness UPDATE: scheduled departures of the site only, and only rows that change. */
export function readinessUpdateSql(siteId: string, entries: DepartureReadinessWrite[]): SQL {
  const values = sql.join(entries.map(readinessRow), sql`, `);
  return sql`UPDATE vehicle_departures AS d SET
      readiness = v.readiness,
      readiness_reason = v.readiness_reason,
      planned_kwh = v.planned_kwh,
      delivered_kwh = v.delivered_kwh,
      shortfall_kwh = v.shortfall_kwh,
      predicted_ready_at = v.predicted_ready_at,
      predicted_max_ready_at = v.predicted_max_ready_at,
      planned_at = now(),
      updated_at = now()
    FROM (VALUES ${values}) AS v(id, readiness, readiness_reason, planned_kwh, delivered_kwh, shortfall_kwh, predicted_ready_at, predicted_max_ready_at)
    WHERE d.id = v.id
      AND d.site_id = ${siteId}
      AND d.status = 'scheduled'
      AND (d.readiness IS DISTINCT FROM v.readiness
        OR d.readiness_reason IS DISTINCT FROM v.readiness_reason
        OR d.planned_kwh IS DISTINCT FROM v.planned_kwh
        OR d.delivered_kwh IS DISTINCT FROM v.delivered_kwh
        OR d.shortfall_kwh IS DISTINCT FROM v.shortfall_kwh
        OR d.predicted_ready_at IS DISTINCT FROM v.predicted_ready_at
        OR d.predicted_max_ready_at IS DISTINCT FROM v.predicted_max_ready_at)
    RETURNING d.id, d.readiness, d.readiness_reason`;
}

/**
 * Stores the plan of a site and the readiness of its departures in one
 * transaction. Only `scheduled` departures of the site take a readiness (a
 * completed or cancelled one keeps its outcome when a late plan arrives), a
 * departed entry (null readiness) keeps its stored values, and a row whose
 * values did not change is not written. The plan row clears its stale mark
 * unless a trigger marked it again after the planner read its inputs.
 * Scheduled departures of the site that the run did not list get their
 * readiness and reason cleared.
 */
export async function writeSitePlan(
  siteId: string,
  plan: SitePlanWrite,
  readiness: DepartureReadinessWrite[],
  tx: DepartureDb = db,
): Promise<SitePlanWriteResult> {
  return tx.transaction(async (t) => {
    const [locked] = await t
      .select({ plan: siteChargingPlans.plan })
      .from(siteChargingPlans)
      .where(eq(siteChargingPlans.siteId, siteId))
      .for('update');
    const values = {
      computedAt: sql`now()`,
      trigger: plan.trigger,
      slotStarts: plan.slotStarts,
      plan: mergeLockedPlanEntries(plan.plan, locked?.plan),
      siteLoadKw: plan.siteLoadKw,
      capacityKw: plan.capacityKw,
      pricePerKwh: plan.pricePerKwh,
      runtimeMs: plan.runtimeMs,
    };
    await t
      .insert(siteChargingPlans)
      .values({ siteId, staleAt: null, ...values })
      .onConflictDoUpdate({
        target: siteChargingPlans.siteId,
        set: {
          ...values,
          staleAt: sql`CASE WHEN ${siteChargingPlans.staleAt} IS NOT DISTINCT FROM ${plan.staleAtRead?.toISOString() ?? null}::timestamptz THEN NULL ELSE ${siteChargingPlans.staleAt} END`,
        },
      });

    const planned = readiness.filter((entry) => entry.readiness != null);
    const changed: SitePlanWriteResult['changed'] = [];
    for (let i = 0; i < planned.length; i += READINESS_CHUNK) {
      const rows = (await t.execute(
        readinessUpdateSql(siteId, planned.slice(i, i + READINESS_CHUNK)),
      )) as unknown as Array<{
        id: string;
        readiness: DepartureReadiness | null;
        readiness_reason: DepartureReadinessReason | null;
      }>;
      for (const row of rows) {
        changed.push({
          id: row.id,
          readiness: row.readiness,
          readinessReason: row.readiness_reason,
        });
      }
    }

    // Scheduled departures of the site this run did not list (moved here or
    // left out by the planner) lose a readiness that no longer applies.
    const listed = readiness.map((entry) => entry.departureId);
    const cleared = await t
      .update(vehicleDepartures)
      .set({ readiness: null, readinessReason: null, plannedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(vehicleDepartures.siteId, siteId),
          eq(vehicleDepartures.status, 'scheduled'),
          or(isNotNull(vehicleDepartures.readiness), isNotNull(vehicleDepartures.readinessReason)),
          listed.length > 0 ? notInArray(vehicleDepartures.id, listed) : undefined,
        ),
      )
      .returning({ id: vehicleDepartures.id });
    for (const row of cleared) changed.push({ id: row.id, readiness: null, readinessReason: null });
    return { changed };
  });
}
