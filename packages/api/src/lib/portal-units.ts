// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chargingStations, db, evses, evseAvailableSql, stationUnits } from '@evtivity/database';
import { haversineKm } from '@evtivity/lib/geo-position';
import { publicStationListed } from './public-station.js';

// The driver view of a station with units (a master box and its extenders):
// every unit is its own charger, and the EVSEs without a unit form one more
// charger named by the station. Starting, check-status and the event stream
// keep their station routes; only the grouping is per unit. A station without
// units has no driver chargers (null) and every view keeps its station path.

/** One in-service EVSE as the driver views see it. */
export interface DriverEvse {
  evseId: number;
  unitId: string | null;
  /** Free for a driver now (evseAvailableSql: open station, not reserved, an Available connector). */
  available: boolean;
}

export interface DriverUnit {
  id: string;
  name: string;
  sortOrder: number;
  /** Where the box stands, both or neither; null keeps the station position. */
  latitude?: string | null;
  longitude?: string | null;
}

export interface DriverCharger {
  /** The unit, or null for the EVSEs without a unit (named by the station). */
  unitId: string | null;
  unitName: string | null;
  evseIds: number[];
  evseCount: number;
  availableCount: number;
  /** The unit position, null for a unit without one and for the EVSEs without a unit. */
  latitude: string | null;
  longitude: string | null;
}

/**
 * The chargers of one station in the station's unit order, then the EVSEs
 * without a unit. A unit with no in-service EVSE is left out (a driver cannot
 * use it). Null for a station without units.
 */
export function driverChargers(
  evseRows: readonly DriverEvse[],
  units: readonly DriverUnit[],
): DriverCharger[] | null {
  if (units.length === 0) return null;
  const ordered = [...units].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const out: DriverCharger[] = [];
  const group = (unit: DriverUnit | null): void => {
    const unitId = unit?.id ?? null;
    const members = evseRows.filter((e) => e.unitId === unitId).sort((a, b) => a.evseId - b.evseId);
    if (members.length === 0) return;
    const hasPosition = unit?.latitude != null && unit.longitude != null;
    out.push({
      unitId,
      unitName: unit?.name ?? null,
      evseIds: members.map((e) => e.evseId),
      evseCount: members.length,
      availableCount: members.filter((e) => e.available).length,
      latitude: hasPosition ? (unit.latitude ?? null) : null,
      longitude: hasPosition ? (unit.longitude ?? null) : null,
    });
  };
  for (const unit of ordered) group(unit);
  const known = new Set(ordered.map((u) => u.id));
  // An EVSE naming a unit the list does not hold counts as without a unit.
  const loose = evseRows.map((e) =>
    e.unitId != null && !known.has(e.unitId) ? { ...e, unitId: null } : e,
  );
  const unassigned = loose.filter((e) => e.unitId == null);
  if (unassigned.length > 0) {
    out.push({
      unitId: null,
      unitName: null,
      evseIds: unassigned.map((e) => e.evseId).sort((a, b) => a - b),
      evseCount: unassigned.length,
      availableCount: unassigned.filter((e) => e.available).length,
      latitude: null,
      longitude: null,
    });
  }
  return out;
}

export interface StationDriverUnits {
  units: DriverUnit[];
  evses: DriverEvse[];
}

/**
 * The units and in-service EVSEs (with driver availability) of the stations
 * that have units, keyed by station row id. A station without units is not in
 * the map, so callers keep their station path for it.
 */
export async function loadStationDriverUnits(
  stationUuids: readonly string[],
): Promise<Map<string, StationDriverUnits>> {
  const out = new Map<string, StationDriverUnits>();
  if (stationUuids.length === 0) return out;
  const unitRows = await db
    .select({
      id: stationUnits.id,
      stationId: stationUnits.stationId,
      name: stationUnits.name,
      sortOrder: stationUnits.sortOrder,
      latitude: stationUnits.latitude,
      longitude: stationUnits.longitude,
    })
    .from(stationUnits)
    .where(inArray(stationUnits.stationId, [...stationUuids]))
    .orderBy(asc(stationUnits.sortOrder), asc(stationUnits.name));
  if (unitRows.length === 0) return out;
  for (const u of unitRows) {
    const entry = out.get(u.stationId) ?? { units: [], evses: [] };
    entry.units.push({
      id: u.id,
      name: u.name,
      sortOrder: u.sortOrder,
      latitude: u.latitude,
      longitude: u.longitude,
    });
    out.set(u.stationId, entry);
  }
  const evseRows = await db
    .select({
      stationId: evses.stationId,
      evseId: evses.evseId,
      unitId: evses.unitId,
      available: sql<boolean>`${sql.raw(evseAvailableSql('evses', 'charging_stations'))}`,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
    .where(and(inArray(evses.stationId, [...out.keys()]), isNull(evses.retiredAt)))
    .orderBy(asc(evses.evseId));
  for (const e of evseRows) {
    out
      .get(e.stationId)
      ?.evses.push({ evseId: e.evseId, unitId: e.unitId, available: e.available });
  }
  return out;
}

/** The rows one search page returns: a station with units takes one row per unit. */
export const SEARCH_ROW_LIMIT = 20;

interface ConnectorSummaryRow {
  evseId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface StationListRow {
  stationUuid: string;
  evseCount: number;
  availableCount: number;
  connectors: ConnectorSummaryRow[];
  /** The station position (else its site's), decimal degrees, null when neither has one. */
  latitude?: string | null;
  longitude?: string | null;
}

type ConnectorSummary = Omit<ConnectorSummaryRow, 'evseId'>;

function connectorSummary(c: ConnectorSummaryRow): ConnectorSummary {
  return {
    connectorType: c.connectorType,
    maxPowerKw: c.maxPowerKw,
    maxCurrentAmps: c.maxCurrentAmps,
    status: c.status,
  };
}

/** One row of the charger search or nearby list: the base fields and the charger's own. */
export type DriverChargerRow<B> = B & {
  evseCount: number;
  availableCount: number;
  connectors: ConnectorSummary[];
  unitId: string | null;
  unitName: string | null;
  latitude: string | null;
  longitude: string | null;
};

/**
 * Turns station rows of the charger search and nearby list into driver
 * charger rows: a station without units stays one row (unit fields null), a
 * station with units becomes one row per unit plus one for its EVSEs without a
 * unit, each with its own EVSE count, availability and connectors. A station
 * with units but no EVSE in service stays one row, like a station without units.
 * With `limit`, only whole stations are returned: a station whose chargers
 * would pass the limit ends the page, except the first, which is always whole.
 * Every row carries the position of its charger: a unit with its own position
 * gives its own, every other row the station's. With `distanceFrom`, a unit
 * charger with its own position gets `distanceKm` from it (rounded to 0.1 km);
 * other rows keep the distance `base` gives.
 */
export function expandToDriverChargers<R extends StationListRow, B extends object>(
  rows: readonly R[],
  unitData: ReadonlyMap<string, StationDriverUnits>,
  base: (row: R) => B,
  limit?: number,
  distanceFrom?: { lat: number; lng: number },
): Array<DriverChargerRow<B>> {
  const perStation = rows.map((row): DriverChargerRow<B>[] => {
    const data = unitData.get(row.stationUuid);
    const chargers = data == null ? null : driverChargers(data.evses, data.units);
    if (chargers == null || chargers.length === 0) {
      return [
        {
          ...base(row),
          evseCount: row.evseCount,
          availableCount: row.availableCount,
          connectors: row.connectors.map(connectorSummary),
          unitId: null,
          unitName: null,
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
        },
      ];
    }
    return chargers.map((c): DriverChargerRow<B> => {
      const own = c.latitude != null && c.longitude != null;
      const distance =
        own && distanceFrom != null
          ? {
              distanceKm:
                Math.round(
                  haversineKm(
                    distanceFrom.lat,
                    distanceFrom.lng,
                    Number(c.latitude),
                    Number(c.longitude),
                  ) * 10,
                ) / 10,
            }
          : {};
      return {
        ...base(row),
        ...distance,
        evseCount: c.evseCount,
        availableCount: c.availableCount,
        connectors: row.connectors
          .filter((con) => c.evseIds.includes(con.evseId))
          .map(connectorSummary),
        unitId: c.unitId,
        unitName: c.unitName,
        latitude: own ? c.latitude : (row.latitude ?? null),
        longitude: own ? c.longitude : (row.longitude ?? null),
      };
    });
  });
  if (limit == null) return perStation.flat();
  const out: DriverChargerRow<B>[] = [];
  for (const stationRows of perStation) {
    if (out.length > 0 && out.length + stationRows.length > limit) break;
    out.push(...stationRows);
  }
  return out;
}

/**
 * How many more chargers than stations the listed stations of a site show
 * drivers: a station with units counts its chargers instead of one. 0 for a
 * site without units.
 */
export async function extraUnitChargerCount(siteId: string): Promise<number> {
  const listed = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(and(eq(chargingStations.siteId, siteId), publicStationListed()));
  const unitData = await loadStationDriverUnits(listed.map((r) => r.id));
  let extra = 0;
  for (const data of unitData.values()) {
    const chargers = driverChargers(data.evses, data.units);
    if (chargers != null && chargers.length > 0) extra += chargers.length - 1;
  }
  return extra;
}

/** A charger of the location page: the EVSE rows it groups. */
export interface LocationCharger {
  /** OCPP station identity. */
  stationId: string;
  /**
   * The unit, or null for a station without units (the whole station) and for
   * the EVSEs without a unit of a station with units; both are named by the station.
   */
  unitId: string | null;
  unitName: string | null;
  evseIds: number[];
  evseCount: number;
  /** EVSEs of the charger with a row a driver can start on now. */
  availableCount: number;
}

interface LocationChargerRow {
  stationUuid: string;
  stationId: string;
  evseId: number;
  available: boolean;
}

/**
 * The chargers of a location page, in the order of the page rows: a station
 * without units is one charger; a station with units gives each unit, then its
 * EVSEs without a unit (driverChargers). Only EVSEs the page lists count (an
 * EVSE without a connector has no row), so a charger with none of them is left
 * out, and the availability follows the rows' own rule.
 */
export async function locationChargers(
  rows: readonly LocationChargerRow[],
): Promise<LocationCharger[]> {
  const stationOrder: string[] = [];
  const byStation = new Map<string, LocationChargerRow[]>();
  for (const row of rows) {
    const list = byStation.get(row.stationUuid);
    if (list == null) {
      stationOrder.push(row.stationUuid);
      byStation.set(row.stationUuid, [row]);
    } else {
      list.push(row);
    }
  }
  const unitData = await loadStationDriverUnits(stationOrder);
  const out: LocationCharger[] = [];
  for (const uuid of stationOrder) {
    const stationRows = byStation.get(uuid) ?? [];
    const stationId = stationRows[0]?.stationId ?? '';
    const listedIds: number[] = [];
    for (const r of stationRows) if (!listedIds.includes(r.evseId)) listedIds.push(r.evseId);
    const startable = new Set(stationRows.filter((r) => r.available).map((r) => r.evseId));
    const data = unitData.get(uuid);
    const chargers = data == null ? null : driverChargers(data.evses, data.units);
    const groups =
      chargers == null || chargers.length === 0
        ? [{ unitId: null, unitName: null, evseIds: listedIds.sort((a, b) => a - b) }]
        : chargers;
    for (const c of groups) {
      const evseIds = c.evseIds.filter((id) => listedIds.includes(id));
      if (evseIds.length === 0) continue;
      out.push({
        stationId,
        unitId: c.unitId,
        unitName: c.unitName,
        evseIds,
        evseCount: evseIds.length,
        availableCount: evseIds.filter((id) => startable.has(id)).length,
      });
    }
  }
  return out;
}
