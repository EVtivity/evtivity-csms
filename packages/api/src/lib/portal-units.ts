// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chargingStations, db, evses, evseAvailableSql, stationUnits } from '@evtivity/database';
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
}

export interface DriverCharger {
  /** The unit, or null for the EVSEs without a unit (named by the station). */
  unitId: string | null;
  unitName: string | null;
  evseIds: number[];
  evseCount: number;
  availableCount: number;
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
  const group = (unitId: string | null, unitName: string | null): void => {
    const members = evseRows.filter((e) => e.unitId === unitId).sort((a, b) => a.evseId - b.evseId);
    if (members.length === 0) return;
    out.push({
      unitId,
      unitName,
      evseIds: members.map((e) => e.evseId),
      evseCount: members.length,
      availableCount: members.filter((e) => e.available).length,
    });
  };
  for (const unit of ordered) group(unit.id, unit.name);
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
    })
    .from(stationUnits)
    .where(inArray(stationUnits.stationId, [...stationUuids]))
    .orderBy(asc(stationUnits.sortOrder), asc(stationUnits.name));
  if (unitRows.length === 0) return out;
  for (const u of unitRows) {
    const entry = out.get(u.stationId) ?? { units: [], evses: [] };
    entry.units.push({ id: u.id, name: u.name, sortOrder: u.sortOrder });
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

/**
 * Turns station rows of the charger search and nearby list into driver
 * charger rows: a station without units stays one row (unit fields null), a
 * station with units becomes one row per unit plus one for its EVSEs without a
 * unit, each with its own EVSE count, availability and connectors.
 */
export function expandToDriverChargers<R extends StationListRow, B extends object>(
  rows: readonly R[],
  unitData: ReadonlyMap<string, StationDriverUnits>,
  base: (row: R) => B,
): Array<
  B & {
    evseCount: number;
    availableCount: number;
    connectors: ConnectorSummary[];
    unitId: string | null;
    unitName: string | null;
  }
> {
  return rows.flatMap((row) => {
    const data = unitData.get(row.stationUuid);
    const chargers = data == null ? null : driverChargers(data.evses, data.units);
    if (chargers == null) {
      return [
        {
          ...base(row),
          evseCount: row.evseCount,
          availableCount: row.availableCount,
          connectors: row.connectors.map(connectorSummary),
          unitId: null,
          unitName: null,
        },
      ];
    }
    return chargers.map((c) => ({
      ...base(row),
      evseCount: c.evseCount,
      availableCount: c.availableCount,
      connectors: row.connectors
        .filter((con) => c.evseIds.includes(con.evseId))
        .map(connectorSummary),
      unitId: c.unitId,
      unitName: c.unitName,
    }));
  });
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
