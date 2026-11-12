// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of `station_units` and `evses.unit_id`. A unit is a physical
// charger box (a master or an extender) under one OCPP station: a CSMS
// grouping of the station's EVSEs, with no protocol meaning. Every write locks
// the station row first, so concurrent edits of one station run one after the
// other, and checks that an EVSE and a unit belong to the same station (the
// composite foreign key fk_evses_unit_same_station refuses it too). The
// service in the API audits and announces each change; this module only
// writes and returns what changed.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { chargingStations, evses, stationUnits } from '../schema/assets.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from './pg-errors.js';

/** The most units one station holds. */
export const STATION_UNITS_MAX = 64;
/** The most characters of a unit name after trimming (`station_units.name`). */
export const STATION_UNIT_NAME_MAX = 50;

export type StationUnitRow = typeof stationUnits.$inferSelect;

/** A unit as the audit row records it: its id, name and EVSE numbers. */
export interface UnitSnapshot {
  id: string;
  name: string;
  evseIds: number[];
}

/** A unit with its EVSEs, ordered by EVSE number. */
export interface StationUnitView {
  id: string;
  stationId: string;
  name: string;
  sortOrder: number;
  evseIds: string[];
  evseNumbers: number[];
}

export type UnitWriteFailure =
  | 'station_not_found'
  | 'not_found'
  | 'evse_not_found'
  | 'name_in_use'
  | 'limit'
  | 'other_station';

export type UnitWriteResult<T> =
  | {
      ok: true;
      value: T;
      changed: boolean;
      before: UnitSnapshot | null;
      after: UnitSnapshot | null;
    }
  | { ok: false; reason: UnitWriteFailure };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockStation(tx: Tx, stationUuid: string): Promise<boolean> {
  const rows = await tx
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationUuid))
    .for('update');
  return rows.length > 0;
}

async function snapshot(tx: Tx, unit: StationUnitRow): Promise<UnitSnapshot> {
  const rows = await tx
    .select({ evseId: evses.evseId })
    .from(evses)
    .where(eq(evses.unitId, unit.id))
    .orderBy(asc(evses.evseId));
  return { id: unit.id, name: unit.name, evseIds: rows.map((r) => r.evseId) };
}

async function nameTaken(
  tx: Tx,
  stationUuid: string,
  name: string,
  exceptUnitId: string | null,
): Promise<boolean> {
  const rows = await tx
    .select({ id: stationUnits.id })
    .from(stationUnits)
    .where(
      and(
        eq(stationUnits.stationId, stationUuid),
        sql`lower(${stationUnits.name}) = lower(${name})`,
        exceptUnitId == null ? undefined : sql`${stationUnits.id} <> ${exceptUnitId}`,
      ),
    );
  return rows.length > 0;
}

async function runUnitWrite<T>(
  work: (tx: Tx) => Promise<UnitWriteResult<T>>,
): Promise<UnitWriteResult<T>> {
  try {
    return await db.transaction(work);
  } catch (err: unknown) {
    // Two creates or renames of one name that raced past the read above.
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'name_in_use' };
    throw err;
  }
}

/**
 * Creates a unit at the end of the station's order. `evseIds` (EVSE row ids)
 * move into the new unit from wherever they were; each must be an EVSE of
 * the station.
 */
export async function createStationUnit(
  stationUuid: string,
  input: { name: string; evseIds?: string[] },
): Promise<UnitWriteResult<StationUnitRow>> {
  const name = input.name.trim();
  return runUnitWrite(async (tx) => {
    if (!(await lockStation(tx, stationUuid))) return { ok: false, reason: 'station_not_found' };
    const counts = await tx
      .select({
        n: sql<number>`count(*)::int`,
        maxOrder: sql<number>`coalesce(max(${stationUnits.sortOrder}), -1)::int`,
      })
      .from(stationUnits)
      .where(eq(stationUnits.stationId, stationUuid));
    const n = counts[0]?.n ?? 0;
    if (n >= STATION_UNITS_MAX) return { ok: false, reason: 'limit' };
    if (await nameTaken(tx, stationUuid, name, null)) return { ok: false, reason: 'name_in_use' };
    const evseIds = [...new Set(input.evseIds ?? [])];
    if (evseIds.length > 0) {
      const found = await tx
        .select({ id: evses.id, stationId: evses.stationId })
        .from(evses)
        .where(inArray(evses.id, evseIds))
        .for('update');
      if (found.length !== evseIds.length) return { ok: false, reason: 'evse_not_found' };
      if (found.some((e) => e.stationId !== stationUuid)) {
        return { ok: false, reason: 'other_station' };
      }
    }
    const [unit] = await tx
      .insert(stationUnits)
      .values({ stationId: stationUuid, name, sortOrder: (counts[0]?.maxOrder ?? -1) + 1 })
      .returning();
    if (unit == null) throw new Error('Station unit insert returned no row');
    if (evseIds.length > 0) {
      await tx
        .update(evses)
        .set({ unitId: unit.id, updatedAt: new Date() })
        .where(and(inArray(evses.id, evseIds), eq(evses.stationId, stationUuid)));
    }
    return { ok: true, value: unit, changed: true, before: null, after: await snapshot(tx, unit) };
  });
}

/** Renames a unit or moves it in the station's order. */
export async function updateStationUnit(
  stationUuid: string,
  unitId: string,
  input: { name?: string; sortOrder?: number },
): Promise<UnitWriteResult<StationUnitRow>> {
  return runUnitWrite(async (tx) => {
    if (!(await lockStation(tx, stationUuid))) return { ok: false, reason: 'station_not_found' };
    const [unit] = await tx
      .select()
      .from(stationUnits)
      .where(and(eq(stationUnits.id, unitId), eq(stationUnits.stationId, stationUuid)));
    if (unit == null) return { ok: false, reason: 'not_found' };
    const name = input.name?.trim();
    const nameChanged = name != null && name !== unit.name;
    const orderChanged = input.sortOrder != null && input.sortOrder !== unit.sortOrder;
    const before = await snapshot(tx, unit);
    if (!nameChanged && !orderChanged) {
      return { ok: true, value: unit, changed: false, before, after: before };
    }
    if (nameChanged && (await nameTaken(tx, stationUuid, name, unit.id))) {
      return { ok: false, reason: 'name_in_use' };
    }
    const [updated] = await tx
      .update(stationUnits)
      .set({
        ...(nameChanged ? { name } : {}),
        ...(orderChanged ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(stationUnits.id, unit.id))
      .returning();
    if (updated == null) throw new Error('Station unit update returned no row');
    return {
      ok: true,
      value: updated,
      changed: true,
      before,
      after: { ...before, name: updated.name },
    };
  });
}

/**
 * Deletes a unit. Its EVSEs leave the unit first in the same transaction (the
 * foreign key refuses a delete while an EVSE still names the unit); its
 * favorites, watches and 2D board position go with it (cascade).
 */
export async function deleteStationUnit(
  stationUuid: string,
  unitId: string,
): Promise<UnitWriteResult<null>> {
  return runUnitWrite(async (tx) => {
    if (!(await lockStation(tx, stationUuid))) return { ok: false, reason: 'station_not_found' };
    const [unit] = await tx
      .select()
      .from(stationUnits)
      .where(and(eq(stationUnits.id, unitId), eq(stationUnits.stationId, stationUuid)));
    if (unit == null) return { ok: false, reason: 'not_found' };
    const before = await snapshot(tx, unit);
    await tx
      .update(evses)
      .set({ unitId: null, updatedAt: new Date() })
      .where(and(eq(evses.unitId, unit.id), eq(evses.stationId, stationUuid)));
    await tx.delete(stationUnits).where(eq(stationUnits.id, unit.id));
    return { ok: true, value: null, changed: true, before, after: null };
  });
}

/**
 * Moves one EVSE into a unit of its station, or out of every unit (null). An
 * EVSE already in that unit writes nothing (`changed: false`). `before` is the
 * unit the EVSE left and `after` the unit it joined, each as it is after the
 * move, so the audit row names both.
 */
export async function setEvseUnit(
  stationUuid: string,
  evseUuid: string,
  unitId: string | null,
): Promise<UnitWriteResult<null>> {
  return runUnitWrite(async (tx) => {
    if (!(await lockStation(tx, stationUuid))) return { ok: false, reason: 'station_not_found' };
    const [evse] = await tx
      .select({ id: evses.id, stationId: evses.stationId, unitId: evses.unitId })
      .from(evses)
      .where(eq(evses.id, evseUuid))
      .for('update');
    if (evse == null || evse.stationId !== stationUuid)
      return { ok: false, reason: 'evse_not_found' };
    let target: StationUnitRow | null = null;
    if (unitId != null) {
      const [unit] = await tx.select().from(stationUnits).where(eq(stationUnits.id, unitId));
      if (unit == null) return { ok: false, reason: 'not_found' };
      if (unit.stationId !== stationUuid) return { ok: false, reason: 'other_station' };
      target = unit;
    }
    const previous =
      evse.unitId == null
        ? null
        : ((await tx.select().from(stationUnits).where(eq(stationUnits.id, evse.unitId)))[0] ??
          null);
    if (evse.unitId === unitId) {
      const same = previous == null ? null : await snapshot(tx, previous);
      return { ok: true, value: null, changed: false, before: same, after: same };
    }
    await tx
      .update(evses)
      .set({ unitId, updatedAt: new Date() })
      .where(and(eq(evses.id, evse.id), eq(evses.stationId, stationUuid)));
    return {
      ok: true,
      value: null,
      changed: true,
      before: previous == null ? null : await snapshot(tx, previous),
      after: target == null ? null : await snapshot(tx, target),
    };
  });
}

/** The units of several stations with their EVSEs, keyed by station row id. */
export async function readUnitsOfStations(
  stationUuids: string[],
): Promise<Map<string, StationUnitView[]>> {
  const out = new Map<string, StationUnitView[]>();
  if (stationUuids.length === 0) return out;
  const units = await db
    .select()
    .from(stationUnits)
    .where(inArray(stationUnits.stationId, stationUuids))
    .orderBy(asc(stationUnits.stationId), asc(stationUnits.sortOrder), asc(stationUnits.name));
  if (units.length === 0) return out;
  const members = await db
    .select({ id: evses.id, evseId: evses.evseId, unitId: evses.unitId })
    .from(evses)
    .where(
      inArray(
        evses.unitId,
        units.map((u) => u.id),
      ),
    )
    .orderBy(asc(evses.evseId));
  const byUnit = new Map<string, { id: string; evseId: number }[]>();
  for (const m of members) {
    if (m.unitId == null) continue;
    const list = byUnit.get(m.unitId) ?? [];
    list.push({ id: m.id, evseId: m.evseId });
    byUnit.set(m.unitId, list);
  }
  for (const u of units) {
    const list = out.get(u.stationId) ?? [];
    const evseRows = byUnit.get(u.id) ?? [];
    list.push({
      id: u.id,
      stationId: u.stationId,
      name: u.name,
      sortOrder: u.sortOrder,
      evseIds: evseRows.map((e) => e.id),
      evseNumbers: evseRows.map((e) => e.evseId),
    });
    out.set(u.stationId, list);
  }
  return out;
}

/** The units of one station with their EVSEs, in the station's order. */
export async function readStationUnits(stationUuid: string): Promise<StationUnitView[]> {
  return (await readUnitsOfStations([stationUuid])).get(stationUuid) ?? [];
}
