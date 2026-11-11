// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Reads and reply shapes of fleet departures and departure schedules (route-aware
// charging). Writes go through @evtivity/services/departure.service.

import { z } from 'zod';
import { and, asc, count, eq, exists, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  depotSystems,
  fleetDrivers,
  isFleetChargingEnabled,
  siteLoadManagement,
  sites,
  vehicleDepartures,
  vehicleDepartureSchedules,
  vehicles,
  DEPARTURE_CANCEL_REASONS,
  DEPARTURE_OUTCOMES,
  DEPARTURE_READINESS_REASONS,
  DEPARTURE_READINESS_STATES,
  DEPARTURE_SOURCES,
  DEPARTURE_STATUSES,
  DEPARTURE_TARGET_KINDS,
  type VehicleDeparture,
  type VehicleDepartureSchedule,
} from '@evtivity/database';
import { escapeLikePattern } from '@evtivity/lib';
import type { ListSortParams } from './list-sort.js';
import { departureScheduleListSort } from './sorts/departure-schedule-list-sort.js';

const numberOrNull = (value: string | null): number | null =>
  value == null ? null : Number(value);

/** The vehicle and site names a list row carries. */
const departureVehicleItem = z
  .object({
    id: z.string().describe('Vehicle identifier'),
    driverId: z.string().optional().describe('Driver who owns the vehicle'),
    make: z.string().nullable().describe('Vehicle make'),
    model: z.string().nullable().describe('Vehicle model'),
    licensePlate: z.string().nullable().describe('License plate'),
  })
  .loose()
  .describe('The vehicle (list replies only)');

export const departureScheduleItem = z
  .object({
    id: z.string().describe('Departure schedule identifier (vds_)'),
    vehicleId: z.string().describe('Vehicle that departs'),
    siteId: z.string().describe('Site (depot) the vehicle leaves from'),
    siteName: z.string().optional().describe('Site name (list replies only)'),
    siteTimezone: z
      .string()
      .optional()
      .describe('IANA time zone of the site (list replies only); departureTime is local to it'),
    vehicle: departureVehicleItem.optional(),
    daysOfWeek: z
      .array(z.number().int())
      .describe('ISO days of the week, 1 (Monday) to 7 (Sunday)'),
    departureTime: z.string().describe('Departure time HH:MM, local time of the site'),
    targetKind: z.enum(DEPARTURE_TARGET_KINDS).describe('energy (kWh) or soc (state of charge)'),
    targetEnergyKwh: z
      .number()
      .nullable()
      .describe('Energy from the charger in kWh (energy targets)'),
    targetSocPercent: z
      .number()
      .int()
      .nullable()
      .describe('Minimum state of charge in percent (soc targets)'),
    targetSocMaxPercent: z
      .number()
      .int()
      .nullable()
      .describe('Charge further up to this state of charge from spare capacity; null for none'),
    priority: z.number().int().describe('1 lowest to 10 highest'),
    validFrom: z.string().nullable().describe('First local date the schedule applies (YYYY-MM-DD)'),
    validTo: z.string().nullable().describe('Last local date the schedule applies (YYYY-MM-DD)'),
    isActive: z.boolean().describe('False stops new occurrences and cancels the upcoming ones'),
    notes: z.string().nullable().describe('Free text notes'),
    createdAt: z.coerce.date().describe('When the schedule was created'),
    updatedAt: z.coerce.date().describe('When the schedule last changed'),
  })
  .loose();

export const departureItem = z
  .object({
    id: z.string().describe('Departure identifier (vdp_)'),
    vehicleId: z.string().describe('Vehicle that departs'),
    siteId: z.string().describe('Site (depot) the vehicle leaves from'),
    siteName: z.string().optional().describe('Site name (list replies only)'),
    siteTimezone: z
      .string()
      .optional()
      .describe('IANA time zone of the site (list replies only), for showing the departure time'),
    vehicle: departureVehicleItem.optional(),
    scheduleId: z.string().nullable().describe('Schedule that created it, null for a one-off'),
    occurrenceDate: z.string().nullable().describe('Local date of a schedule occurrence'),
    departureAt: z.coerce
      .date()
      .nullable()
      .describe('When the vehicle must be ready; null for an ad hoc request (charge from arrival)'),
    adHoc: z
      .boolean()
      .describe('An ad hoc request of a bus depot system: charge as soon as the bus plugs in'),
    targetKind: z.enum(DEPARTURE_TARGET_KINDS).describe('energy (kWh) or soc (state of charge)'),
    targetEnergyKwh: z
      .number()
      .nullable()
      .describe('Energy from the charger in kWh (energy targets)'),
    targetSocPercent: z
      .number()
      .int()
      .nullable()
      .describe('Minimum state of charge in percent (soc targets); readiness measures it'),
    targetSocMaxPercent: z
      .number()
      .int()
      .nullable()
      .describe('Charge further up to this state of charge from spare capacity; null for none'),
    expectedArrivalAt: z.coerce
      .date()
      .nullable()
      .describe('When the vehicle is expected to plug in (bus depot system requests)'),
    expectedArrivalSocPercent: z
      .number()
      .int()
      .nullable()
      .describe('State of charge expected at arrival, used until the vehicle reports one'),
    requestedEvseId: z
      .string()
      .nullable()
      .describe('EVSE a bus depot system assigned; the vehicle may still plug in elsewhere'),
    requestedChargingPointId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The assigned EVSE as the bus depot system names it (`<OCPP station id>/<EVSE id>`); in lists only',
      ),
    priority: z.number().int().describe('1 lowest to 10 highest'),
    source: z.enum(DEPARTURE_SOURCES).describe('Where it came from'),
    depotSystemId: z
      .string()
      .nullable()
      .describe('Bus depot system that requested it (source depot_system), null otherwise'),
    depotSystemName: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Name of the bus depot system that requested it; only for a caller who may list the bus depot systems (settings.integrations:read and every site), else null',
      ),
    managedByDepotSystem: z
      .boolean()
      .optional()
      .describe(
        'A scheduled departure whose bus depot system is enabled: read-only (409 DEPARTURE_MANAGED_BY_DEPOT_SYSTEM)',
      ),
    externalRequestId: z
      .string()
      .nullable()
      .describe('The charging request id of the bus depot system'),
    cancelReason: z
      .enum(DEPARTURE_CANCEL_REASONS)
      .nullable()
      .describe('Why a bus depot system cancelled it; null when a person cancelled it'),
    predictedMaxReadyAt: z.coerce
      .date()
      .nullable()
      .describe('When the plan reaches the maximum state of charge'),
    overridden: z.boolean().describe('A person changed it, so a schedule edit leaves it alone'),
    status: z
      .enum(DEPARTURE_STATUSES)
      .describe('scheduled, cancelled or completed (both terminal)'),
    outcome: z.enum(DEPARTURE_OUTCOMES).nullable().describe('Set at completion'),
    readiness: z.enum(DEPARTURE_READINESS_STATES).nullable().describe('What the planner predicts'),
    readinessReason: z
      .enum(DEPARTURE_READINESS_REASONS)
      .nullable()
      .describe('Why the planner expects it to be short or late'),
    sessionId: z
      .string()
      .nullable()
      .optional()
      .describe('Charging session charging for it; left out without sessions:read'),
    plannedKwh: z.number().nullable().describe('Energy the plan delivers by the departure, kWh'),
    deliveredKwh: z.number().nullable().describe('Energy delivered so far, kWh'),
    shortfallKwh: z.number().nullable().describe('Energy the plan expects to miss, kWh'),
    predictedReadyAt: z.coerce.date().nullable().describe('When the plan expects it to be ready'),
    plannedAt: z.coerce.date().nullable().describe('When the planner last wrote it'),
    createdAt: z.coerce.date().describe('When the departure was created'),
    updatedAt: z.coerce.date().describe('When the departure last changed'),
  })
  .loose();

export function scheduleView(s: VehicleDepartureSchedule): Record<string, unknown> {
  return {
    id: s.id,
    vehicleId: s.vehicleId,
    siteId: s.siteId,
    daysOfWeek: s.daysOfWeek,
    departureTime: s.departureTime,
    targetKind: s.targetKind,
    targetEnergyKwh: numberOrNull(s.targetEnergyKwh),
    targetSocPercent: s.targetSocPercent,
    targetSocMaxPercent: s.targetSocMaxPercent,
    priority: s.priority,
    validFrom: s.validFrom,
    validTo: s.validTo,
    isActive: s.isActive,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** What the reader of a departure may see beyond the departure. */
export interface DepartureReader {
  /** sessions:read: the id of the session charging for it. */
  sessionIds: boolean;
  /**
   * settings.integrations:read with access to every site (who may list the
   * bus depot systems): the name of the system that requested it.
   */
  depotSystemNames?: boolean;
}

/** The requesting bus depot system's name and switch, read with a departure. */
export const depotSystemColumns = {
  depotSystemName: sql<
    string | null
  >`(SELECT ds.name FROM depot_systems ds WHERE ds.id = ${vehicleDepartures.depotSystemId})`,
  depotSystemEnabled: sql<
    boolean | null
  >`(SELECT ds.is_enabled FROM depot_systems ds WHERE ds.id = ${vehicleDepartures.depotSystemId})`,
};

/**
 * The bus depot system part of a departure view: every reader learns that a
 * system manages it (read-only while the system is on); only a reader who may
 * list the systems gets its name.
 */
export function withDepotSystem(
  view: Record<string, unknown>,
  row: { depotSystemName: string | null; depotSystemEnabled: boolean | null },
  reader: DepartureReader,
): Record<string, unknown> {
  return {
    ...view,
    depotSystemName: reader.depotSystemNames === true ? row.depotSystemName : null,
    managedByDepotSystem: view['status'] === 'scheduled' && row.depotSystemEnabled === true,
  };
}

/** The bus depot system columns of one departure (a write reply). */
export async function depotSystemOfDeparture(
  d: Pick<VehicleDeparture, 'depotSystemId'>,
): Promise<{ depotSystemName: string | null; depotSystemEnabled: boolean | null }> {
  if (d.depotSystemId == null) return { depotSystemName: null, depotSystemEnabled: null };
  const [row] = await db
    .select({ name: depotSystems.name, enabled: depotSystems.isEnabled })
    .from(depotSystems)
    .where(eq(depotSystems.id, d.depotSystemId));
  return { depotSystemName: row?.name ?? null, depotSystemEnabled: row?.enabled ?? null };
}

export function departureView(
  d: VehicleDeparture,
  reader: DepartureReader,
): Record<string, unknown> {
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    siteId: d.siteId,
    scheduleId: d.scheduleId,
    occurrenceDate: d.occurrenceDate,
    departureAt: d.departureAt,
    adHoc: d.adHoc,
    targetKind: d.targetKind,
    targetEnergyKwh: numberOrNull(d.targetEnergyKwh),
    targetSocPercent: d.targetSocPercent,
    targetSocMaxPercent: d.targetSocMaxPercent,
    expectedArrivalAt: d.expectedArrivalAt,
    expectedArrivalSocPercent: d.expectedArrivalSocPercent,
    requestedEvseId: d.requestedEvseId,
    priority: d.priority,
    source: d.source,
    depotSystemId: d.depotSystemId,
    externalRequestId: d.externalRequestId,
    cancelReason: d.cancelReason,
    predictedMaxReadyAt: d.predictedMaxReadyAt,
    overridden: d.overridden,
    status: d.status,
    outcome: d.outcome,
    readiness: d.readiness,
    readinessReason: d.readinessReason,
    ...(reader.sessionIds ? { sessionId: d.sessionId } : {}),
    plannedKwh: numberOrNull(d.plannedKwh),
    deliveredKwh: numberOrNull(d.deliveredKwh),
    shortfallKwh: numberOrNull(d.shortfallKwh),
    predictedReadyAt: d.predictedReadyAt,
    plannedAt: d.plannedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * A departure view without the planner output (readiness, reason, predicted
 * ready time, shortfall): what a reply shows while the site's depot plan does
 * not run, so a value the planner wrote earlier never reads as current.
 */
export function withoutPlanReadiness(view: Record<string, unknown>): Record<string, unknown> {
  return {
    ...view,
    readiness: null,
    readinessReason: null,
    predictedReadyAt: null,
    predictedMaxReadyAt: null,
    shortfallKwh: null,
  };
}

/**
 * The sites among `siteIds` whose depot plan runs: the fleet charging setting
 * on and the site on the Departure Aware strategy.
 */
export async function planningSiteIds(siteIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(siteIds)];
  if (unique.length === 0 || !(await isFleetChargingEnabled())) return new Set();
  const rows = await db
    .select({ siteId: siteLoadManagement.siteId })
    .from(siteLoadManagement)
    .where(
      and(
        inArray(siteLoadManagement.siteId, unique),
        eq(siteLoadManagement.strategy, 'departure_aware'),
      ),
    );
  return new Set(rows.map((r) => r.siteId));
}

/** Rows of vehicles that belong to a driver of the fleet. */
function vehicleInFleet(fleetId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(fleetDrivers)
      .where(and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, vehicles.driverId))),
  );
}

/** The site filter of a caller: none for every site, nothing for no site. */
function siteScopeCondition(
  column: typeof vehicleDepartures.siteId | typeof vehicleDepartureSchedules.siteId,
  siteScope: string[] | null,
): SQL | undefined {
  if (siteScope == null) return undefined;
  if (siteScope.length === 0) return sql`false`;
  return inArray(column, siteScope);
}

function searchCondition(search: string | undefined): SQL | undefined {
  const trimmed = search?.trim();
  if (trimmed == null || trimmed === '') return undefined;
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return or(
    ilike(vehicles.licensePlate, pattern),
    ilike(vehicles.make, pattern),
    ilike(vehicles.model, pattern),
    ilike(sites.name, pattern),
  );
}

/** The assigned EVSE as a charging point id (`<OCPP station id>/<EVSE id>`), or null. */
export const requestedChargingPointSql = sql<string | null>`(
  SELECT cs.station_id || '/' || e.evse_id::text FROM evses e
  JOIN charging_stations cs ON cs.id = e.station_id
  WHERE e.id = ${vehicleDepartures.requestedEvseId})`;

const vehicleColumns = {
  vehicleDriverId: vehicles.driverId,
  vehicleMake: vehicles.make,
  vehicleModel: vehicles.model,
  vehicleLicensePlate: vehicles.licensePlate,
  siteName: sites.name,
  siteTimezone: sites.timezone,
};

function withNames(
  view: Record<string, unknown>,
  row: {
    vehicleDriverId: string;
    vehicleMake: string | null;
    vehicleModel: string | null;
    vehicleLicensePlate: string | null;
    siteName: string;
    siteTimezone: string;
    requestedChargingPointId?: string | null;
  },
  base: { vehicleId: string },
): Record<string, unknown> {
  return {
    ...view,
    ...(row.requestedChargingPointId !== undefined
      ? { requestedChargingPointId: row.requestedChargingPointId }
      : {}),
    siteName: row.siteName,
    siteTimezone: row.siteTimezone,
    vehicle: {
      id: base.vehicleId,
      driverId: row.vehicleDriverId,
      make: row.vehicleMake,
      model: row.vehicleModel,
      licensePlate: row.vehicleLicensePlate,
    },
  };
}

export interface ScheduleListFilters extends ListSortParams {
  page: number;
  limit: number;
  search?: string | undefined;
  siteId?: string | undefined;
  vehicleId?: string | undefined;
}

/** The schedules of the fleet's vehicles at the caller's sites, newest first. */
export async function listFleetDepartureSchedules(
  fleetId: string,
  filters: ScheduleListFilters,
  siteScope: string[] | null,
): Promise<{ data: Record<string, unknown>[]; total: number }> {
  const where = and(
    vehicleInFleet(fleetId),
    siteScopeCondition(vehicleDepartureSchedules.siteId, siteScope),
    filters.siteId != null ? eq(vehicleDepartureSchedules.siteId, filters.siteId) : undefined,
    filters.vehicleId != null
      ? eq(vehicleDepartureSchedules.vehicleId, filters.vehicleId)
      : undefined,
    searchCondition(filters.search),
  );
  const base = db
    .select({ schedule: vehicleDepartureSchedules, ...vehicleColumns })
    .from(vehicleDepartureSchedules)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDepartureSchedules.vehicleId))
    .innerJoin(sites, eq(sites.id, vehicleDepartureSchedules.siteId))
    .where(where);
  const [rows, totals] = await Promise.all([
    base
      .orderBy(...departureScheduleListSort.orderBy(filters))
      .limit(filters.limit)
      .offset((filters.page - 1) * filters.limit),
    db
      .select({ total: count() })
      .from(vehicleDepartureSchedules)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDepartureSchedules.vehicleId))
      .innerJoin(sites, eq(sites.id, vehicleDepartureSchedules.siteId))
      .where(where),
  ]);
  return {
    data: rows.map((r) => withNames(scheduleView(r.schedule), r, r.schedule)),
    total: totals[0]?.total ?? 0,
  };
}

export interface DepartureListFilters {
  page: number;
  limit: number;
  from: Date;
  to: Date;
  status?: (typeof DEPARTURE_STATUSES)[number] | undefined;
  siteId?: string | undefined;
  vehicleId?: string | undefined;
}

/**
 * The departures of the fleet's vehicles at the caller's sites with a departure
 * time from `from` (included) to `to` (excluded), in departure order.
 */
export async function listFleetDepartures(
  fleetId: string,
  filters: DepartureListFilters,
  siteScope: string[] | null,
  reader: DepartureReader,
): Promise<{ data: Record<string, unknown>[]; total: number }> {
  const where = and(
    vehicleInFleet(fleetId),
    siteScopeCondition(vehicleDepartures.siteId, siteScope),
    // An ad hoc request has no time; it lists by when it was requested.
    gte(
      sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.createdAt})`,
      filters.from,
    ),
    lt(sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.createdAt})`, filters.to),
    filters.status != null ? eq(vehicleDepartures.status, filters.status) : undefined,
    filters.siteId != null ? eq(vehicleDepartures.siteId, filters.siteId) : undefined,
    filters.vehicleId != null ? eq(vehicleDepartures.vehicleId, filters.vehicleId) : undefined,
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        departure: vehicleDepartures,
        requestedChargingPointId: requestedChargingPointSql,
        ...depotSystemColumns,
        ...vehicleColumns,
      })
      .from(vehicleDepartures)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDepartures.vehicleId))
      .innerJoin(sites, eq(sites.id, vehicleDepartures.siteId))
      .where(where)
      .orderBy(
        asc(sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.createdAt})`),
        asc(vehicleDepartures.id),
      )
      .limit(filters.limit)
      .offset((filters.page - 1) * filters.limit),
    db
      .select({ total: count() })
      .from(vehicleDepartures)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDepartures.vehicleId))
      .innerJoin(sites, eq(sites.id, vehicleDepartures.siteId))
      .where(where),
  ]);
  const planning = await planningSiteIds(rows.map((r) => r.departure.siteId));
  return {
    data: rows.map((r) => {
      const view = withDepotSystem(departureView(r.departure, reader), r, reader);
      return withNames(
        planning.has(r.departure.siteId) ? view : withoutPlanReadiness(view),
        r,
        r.departure,
      );
    }),
    total: totals[0]?.total ?? 0,
  };
}
