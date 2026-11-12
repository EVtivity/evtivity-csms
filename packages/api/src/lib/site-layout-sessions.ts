// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The active session each station of the site layout shows (GET
// /v1/sites/:id/layout `session`). The route decides what the request may see:
// the session needs sessions:read, its driver drivers:read too. An erased
// driver shows as no driver. Avatars go through `withAvatars`, the one avatar
// read path. The car (`vehicle`: color and body type, no make, model or
// plate) shows with sessions:read alone: it names nobody. The departure the
// session charges for (route-aware charging) shows only when the route passes
// the site, which it does with fleets:read; it carries no vehicle or driver id,
// and its readiness only while the site's depot plan runs.

import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  connectors,
  drivers,
  evses,
  isFleetChargingEnabled,
  siteLoadManagement,
  sites,
  vehicleDepartures,
  vehicles,
} from '@evtivity/database';
import type { DepartureReadiness, DepartureReadinessReason } from '@evtivity/lib/charging-plan';
import type { VehicleBodyType, VehicleColor } from '@evtivity/lib/vehicle-appearance';
import { withAvatars } from '../services/account-avatar.js';
import type { AvatarView } from '../services/account-avatar.js';

export interface LayoutSessionDriver {
  id: string;
  name: string | null;
  avatar: AvatarView | null;
}

/** The look of the car a layout session draws. */
export interface LayoutSessionVehicle {
  color: VehicleColor | null;
  bodyType: VehicleBodyType | null;
}

/**
 * The departure a layout session charges for. `readiness`, `reason`,
 * `shortfallKwh` and `predictedReadyAt` are null while the site's depot plan
 * does not run (the fleet charging setting off or another strategy).
 */
export interface LayoutSessionDeparture {
  id: string;
  /** Null for an ad hoc request of a bus depot system (charges from arrival). */
  departureAt: string | null;
  /** IANA time zone of the depot: the departure time shows in it. */
  timezone: string;
  readiness: DepartureReadiness | null;
  reason: DepartureReadinessReason | null;
  /** The energy target in kWh, null for a state of charge target. */
  targetKwh: number | null;
  targetSocPercent: number | null;
  deliveredKwh: number | null;
  shortfallKwh: number | null;
  predictedReadyAt: string | null;
}

export interface LayoutStationSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  /** The OCPP EVSE id the session runs on, null when the station has not named it. */
  evseId: number | null;
  driver: LayoutSessionDriver | null;
  vehicle: LayoutSessionVehicle | null;
  /** Present only when the route asked for departures (fleets:read). */
  departure?: LayoutSessionDeparture | null;
}

interface VehicleLook extends LayoutSessionVehicle {
  id: string;
  driverId: string;
}

/**
 * Which vehicle a session draws: the session's own vehicle, else the
 * driver's only vehicle, else the driver's most recently used vehicle (the
 * newest session linked to one of its vehicles), else none.
 */
export function chooseLayoutVehicle(
  session: { vehicleId: string | null; driverId: string | null },
  vehicleById: ReadonlyMap<string, VehicleLook>,
  vehiclesByDriver: ReadonlyMap<string, readonly VehicleLook[]>,
  lastUsedByDriver: ReadonlyMap<string, string>,
): LayoutSessionVehicle | null {
  const look = (v: VehicleLook | undefined): LayoutSessionVehicle | null =>
    v == null ? null : { color: v.color, bodyType: v.bodyType };
  if (session.vehicleId != null) {
    const own = vehicleById.get(session.vehicleId);
    if (own != null) return look(own);
  }
  if (session.driverId == null) return null;
  const list = vehiclesByDriver.get(session.driverId) ?? [];
  if (list.length === 1) return look(list[0]);
  const lastUsed = lastUsedByDriver.get(session.driverId);
  if (lastUsed != null) return look(list.find((v) => v.id === lastUsed));
  return null;
}

/**
 * Ids per `IN (...)` list of one query: well under the 65535 bind parameters a
 * PostgreSQL extended-protocol message carries (a 16-bit count, PostgreSQL
 * Frontend/Backend Protocol, Bind message), so a long day replay never fails.
 */
export const IN_LIST_CHUNK = 5000;

/** The items in consecutive lists of at most `size`. */
export function inListChunks<T>(items: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The vehicle each session draws, keyed by session id (the live layout and the day replay). */
export async function readSessionVehicles(
  rows: readonly { id: string; vehicleId: string | null; driverId: string | null }[],
): Promise<Map<string, LayoutSessionVehicle | null>> {
  const out = new Map<string, LayoutSessionVehicle | null>();
  if (rows.length === 0) return out;
  const vehicleIds = [...new Set(rows.flatMap((r) => (r.vehicleId != null ? [r.vehicleId] : [])))];
  const driverIds = [
    ...new Set(
      rows.flatMap((r) => (r.vehicleId == null && r.driverId != null ? [r.driverId] : [])),
    ),
  ];
  const cols = {
    id: vehicles.id,
    driverId: vehicles.driverId,
    color: vehicles.color,
    bodyType: vehicles.bodyType,
  };
  // One query per IN_LIST_CHUNK ids, one after the other (the pool stays free).
  const own: VehicleLook[] = [];
  for (const ids of inListChunks(vehicleIds)) {
    own.push(...(await db.select(cols).from(vehicles).where(inArray(vehicles.id, ids))));
  }
  const byDriver: VehicleLook[] = [];
  for (const ids of inListChunks(driverIds)) {
    byDriver.push(...(await db.select(cols).from(vehicles).where(inArray(vehicles.driverId, ids))));
  }
  const vehicleById = new Map<string, VehicleLook>();
  const vehiclesByDriver = new Map<string, VehicleLook[]>();
  for (const v of own) vehicleById.set(v.id, v);
  for (const v of byDriver) {
    vehicleById.set(v.id, v);
    const list = vehiclesByDriver.get(v.driverId) ?? [];
    list.push(v);
    vehiclesByDriver.set(v.driverId, list);
  }
  // Only drivers with more than one vehicle need the last used one.
  const multi = [...vehiclesByDriver.entries()].filter(([, l]) => l.length > 1).map(([d]) => d);
  const lastUsedByDriver = new Map<string, string>();
  for (const ids of inListChunks(multi)) {
    const used = await db
      .selectDistinctOn([chargingSessions.driverId], {
        driverId: chargingSessions.driverId,
        vehicleId: chargingSessions.vehicleId,
      })
      .from(chargingSessions)
      .where(and(inArray(chargingSessions.driverId, ids), isNotNull(chargingSessions.vehicleId)))
      .orderBy(chargingSessions.driverId, desc(chargingSessions.createdAt));
    for (const u of used) {
      if (u.driverId != null && u.vehicleId != null) lastUsedByDriver.set(u.driverId, u.vehicleId);
    }
  }
  for (const r of rows) {
    out.set(r.id, chooseLayoutVehicle(r, vehicleById, vehiclesByDriver, lastUsedByDriver));
  }
  return out;
}

/** A driver's display name: first and last name, null when both are blank. */
export function layoutDriverName(firstName: string, lastName: string): string | null {
  const name = `${firstName} ${lastName}`.trim();
  return name === '' ? null : name;
}

const numberOrNull = (value: string | null): number | null =>
  value == null ? null : Number(value);

/**
 * The earliest scheduled departure of the site each session is bound to,
 * keyed by session id, with the readiness only while the depot plan runs.
 */
export async function readLayoutSessionDepartures(
  siteId: string,
  sessionIds: readonly string[],
): Promise<Map<string, LayoutSessionDeparture>> {
  const out = new Map<string, LayoutSessionDeparture>();
  if (sessionIds.length === 0) return out;
  const [rows, [site], [config], planningOn] = await Promise.all([
    db
      .select({
        id: vehicleDepartures.id,
        sessionId: vehicleDepartures.sessionId,
        departureAt: vehicleDepartures.departureAt,
        targetKind: vehicleDepartures.targetKind,
        targetEnergyKwh: vehicleDepartures.targetEnergyKwh,
        targetSocPercent: vehicleDepartures.targetSocPercent,
        readiness: vehicleDepartures.readiness,
        readinessReason: vehicleDepartures.readinessReason,
        deliveredKwh: vehicleDepartures.deliveredKwh,
        shortfallKwh: vehicleDepartures.shortfallKwh,
        predictedReadyAt: vehicleDepartures.predictedReadyAt,
      })
      .from(vehicleDepartures)
      .where(
        and(
          eq(vehicleDepartures.siteId, siteId),
          eq(vehicleDepartures.status, 'scheduled'),
          inArray(vehicleDepartures.sessionId, [...sessionIds]),
        ),
      )
      // An ad hoc departure (no time) charges first, as in the plan view.
      .orderBy(sql`${vehicleDepartures.departureAt} ASC NULLS FIRST`, asc(vehicleDepartures.id)),
    db.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, siteId)),
    db
      .select({ strategy: siteLoadManagement.strategy })
      .from(siteLoadManagement)
      .where(eq(siteLoadManagement.siteId, siteId)),
    isFleetChargingEnabled(),
  ]);
  const planning = planningOn && config?.strategy === 'departure_aware';
  const timezone = site?.timezone ?? 'UTC';
  for (const r of rows) {
    if (r.sessionId == null || out.has(r.sessionId)) continue;
    out.set(r.sessionId, {
      id: r.id,
      departureAt: r.departureAt?.toISOString() ?? null,
      timezone,
      readiness: planning ? r.readiness : null,
      reason: planning ? r.readinessReason : null,
      targetKwh: r.targetKind === 'energy' ? numberOrNull(r.targetEnergyKwh) : null,
      targetSocPercent: r.targetKind === 'soc' ? r.targetSocPercent : null,
      deliveredKwh: numberOrNull(r.deliveredKwh),
      shortfallKwh: planning ? numberOrNull(r.shortfallKwh) : null,
      predictedReadyAt: planning ? (r.predictedReadyAt?.toISOString() ?? null) : null,
    });
  }
  return out;
}

/**
 * The newest active session of each station (by start, then creation), keyed by
 * the station's internal id. With `includeDriver` false every `driver` is null
 * and no driver row is read. With `departureSiteId` (the caller holds
 * fleets:read) each session carries the departure of that site it charges for.
 */
export async function readLayoutStationSessions(
  stationIds: readonly string[],
  includeDriver: boolean,
  departureSiteId: string | null = null,
): Promise<Map<string, LayoutStationSession>> {
  const out = new Map<string, LayoutStationSession>();
  if (stationIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([chargingSessions.stationId], {
      id: chargingSessions.id,
      stationId: chargingSessions.stationId,
      startedAt: sql<
        Date | string
      >`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      currentCostCents: chargingSessions.currentCostCents,
      currency: chargingSessions.currency,
      driverId: chargingSessions.driverId,
      vehicleId: chargingSessions.vehicleId,
      evseNumber: evses.evseId,
    })
    .from(chargingSessions)
    .leftJoin(connectors, eq(connectors.id, chargingSessions.connectorId))
    .leftJoin(evses, eq(evses.id, sql`coalesce(${chargingSessions.evseId}, ${connectors.evseId})`))
    .where(
      and(
        inArray(chargingSessions.stationId, [...stationIds]),
        eq(chargingSessions.status, 'active'),
      ),
    )
    .orderBy(
      chargingSessions.stationId,
      desc(sql`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`),
      desc(chargingSessions.createdAt),
    );

  const [vehicleBySession, departureBySession] = await Promise.all([
    readSessionVehicles(rows),
    departureSiteId != null
      ? readLayoutSessionDepartures(
          departureSiteId,
          rows.map((r) => r.id),
        )
      : Promise.resolve(null),
  ]);
  const driverById = includeDriver
    ? await readLayoutDrivers(rows.flatMap((r) => (r.driverId != null ? [r.driverId] : [])))
    : new Map<string, LayoutSessionDriver>();

  for (const r of rows) {
    const startedAt = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt);
    out.set(r.stationId, {
      id: r.id,
      startedAt: startedAt.toISOString(),
      energyDeliveredWh: Number(r.energyDeliveredWh ?? '0'),
      currentCostCents: r.currentCostCents,
      currency: r.currency.toUpperCase(),
      evseId: r.evseNumber ?? null,
      driver: r.driverId != null ? (driverById.get(r.driverId) ?? null) : null,
      vehicle: vehicleBySession.get(r.id) ?? null,
      ...(departureBySession != null ? { departure: departureBySession.get(r.id) ?? null } : {}),
    });
  }
  return out;
}

/**
 * The car and driver of one EVSE's active session on the layout (GET
 * /v1/sites/:id/layout `evses[].session`), for every station: each charging
 * car parks at the stall of its own session's EVSE. The same rules as the station session (security case
 * 283): the caller reads it only with sessions:read; the driver needs
 * drivers:read too and an erased driver shows as no driver.
 */
export interface LayoutEvseSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  driver: LayoutSessionDriver | null;
  vehicle: LayoutSessionVehicle | null;
}

/**
 * The newest active session of each EVSE of the given stations (by start,
 * then creation), keyed by the EVSE row id. With `includeDriver` false every
 * `driver` is null and no driver row is read.
 */
export async function readLayoutEvseSessions(
  stationIds: readonly string[],
  includeDriver: boolean,
): Promise<Map<string, LayoutEvseSession>> {
  const out = new Map<string, LayoutEvseSession>();
  if (stationIds.length === 0) return out;
  // The session's EVSE: the one the session names, else its connector's.
  const evseOf = sql<string>`coalesce(${chargingSessions.evseId}, ${connectors.evseId})`;
  const rows = await db
    .selectDistinctOn([evseOf], {
      id: chargingSessions.id,
      evseId: evseOf,
      startedAt: sql<
        Date | string
      >`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      currentCostCents: chargingSessions.currentCostCents,
      currency: chargingSessions.currency,
      driverId: chargingSessions.driverId,
      vehicleId: chargingSessions.vehicleId,
    })
    .from(chargingSessions)
    .leftJoin(connectors, eq(connectors.id, chargingSessions.connectorId))
    .where(
      and(
        inArray(chargingSessions.stationId, [...stationIds]),
        eq(chargingSessions.status, 'active'),
        sql`${evseOf} IS NOT NULL`,
      ),
    )
    .orderBy(
      evseOf,
      desc(sql`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`),
      desc(chargingSessions.createdAt),
    );
  const vehicleBySession = await readSessionVehicles(rows);
  const driverById = includeDriver
    ? await readLayoutDrivers(rows.flatMap((r) => (r.driverId != null ? [r.driverId] : [])))
    : new Map<string, LayoutSessionDriver>();
  for (const r of rows) {
    const startedAt = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt);
    out.set(r.evseId, {
      id: r.id,
      startedAt: startedAt.toISOString(),
      energyDeliveredWh: Number(r.energyDeliveredWh ?? '0'),
      currentCostCents: r.currentCostCents,
      currency: r.currency.toUpperCase(),
      driver: r.driverId != null ? (driverById.get(r.driverId) ?? null) : null,
      vehicle: vehicleBySession.get(r.id) ?? null,
    });
  }
  return out;
}

/**
 * The drivers a layout session shows, keyed by driver id: the name and the
 * avatar (`withAvatars`, the one avatar read path: a presigned GET of an
 * uploaded image, private, no-store). An erased driver is a stub and is left
 * out (the session shows no driver). The caller decides the permission
 * (sessions:read and drivers:read): the live layout and the day replay.
 */
export async function readLayoutDrivers(
  ids: readonly string[],
): Promise<Map<string, LayoutSessionDriver>> {
  const driverById = new Map<string, LayoutSessionDriver>();
  const driverIds = [...new Set(ids)];
  if (driverIds.length === 0) return driverById;
  const driverRows = await db
    .select({
      id: drivers.id,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      erasedAt: drivers.erasedAt,
      avatarKind: drivers.avatarKind,
      avatarOptions: drivers.avatarOptions,
      avatarS3Key: drivers.avatarS3Key,
      avatarS3Bucket: drivers.avatarS3Bucket,
      avatarUpdatedAt: drivers.avatarUpdatedAt,
    })
    .from(drivers)
    .where(inArray(drivers.id, driverIds));
  // An erased driver is a stub: no name and no avatar on the layout.
  const withAvatar = await withAvatars(driverRows.filter((d) => d.erasedAt == null));
  for (const d of withAvatar) {
    driverById.set(d.id, {
      id: d.id,
      name: layoutDriverName(d.firstName, d.lastName),
      avatar: d.avatar,
    });
  }
  return driverById;
}
