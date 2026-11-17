// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The system-wide Enable Station Units switch (`stationUnits.enabled`). While
// it is off no station can use units: the station switch cannot be turned on,
// no unit can be created and no EVSE put in one. Turning it off is refused
// while any station uses units, so off always means no station has units.
// A setting write takes an exclusive transaction lock and a station switch-on
// a shared one, so the two never pass each other's check.

import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { chargingStations } from '../schema/assets.js';

const logger = createLogger('station-units-setting');

export const STATION_UNITS_SETTING_KEY = 'stationUnits.enabled';

const LOCK_NAME = 'evtivity:station-units-feature';
const TTL_MS = 60_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SettingRow = typeof settings.$inferSelect;

let cachedValue: boolean | undefined;
let cachedAt = 0;

/** Drop the cached value so the next read sees a just-saved setting. */
export function clearStationUnitsFeatureCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

/**
 * True only when `stationUnits.enabled` is stored as true (a missing row is
 * off). Fails closed: a read error returns the cached value, else false, so
 * unit writes are refused until the setting can be read.
 */
export async function isStationUnitsFeatureEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, STATION_UNITS_SETTING_KEY));
    cachedValue = row?.value === true;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: STATION_UNITS_SETTING_KEY },
      'isStationUnitsFeatureEnabled failed, using the cached value or refusing unit writes',
    );
    return cachedValue ?? false;
  }
}

/**
 * Inside `tx`: waits for a setting write in progress (shared lock held to
 * the commit) and reads the stored value fresh. A station that turns on Uses
 * Station Units checks this, so a setting turned off at the same moment
 * either sees the station's switch or the station sees the setting off.
 */
export async function stationUnitsFeatureOnInTx(tx: Tx): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${LOCK_NAME}))`);
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, STATION_UNITS_SETTING_KEY));
  return row?.value === true;
}

/** Stations that use units now (the count that blocks turning the setting off). */
export async function countStationsUsingUnits(tx: Tx | typeof db = db): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(chargingStations)
    .where(eq(chargingStations.usesUnits, true));
  return row?.n ?? 0;
}

export type StationUnitsSettingWrite =
  | { ok: true; before: SettingRow | undefined; row: SettingRow }
  | { ok: false; reason: 'in_use'; stationCount: number }
  | { ok: false; reason: 'not_found' };

/**
 * Stores `stationUnits.enabled` (the generic settings PUT upserts, PATCH
 * updates an existing row). Off is refused while any station uses units,
 * checked under the exclusive lock in the same transaction as the write.
 */
export async function writeStationUnitsSetting(
  value: boolean,
  mode: 'upsert' | 'update',
): Promise<StationUnitsSettingWrite> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`);
    if (!value) {
      const stationCount = await countStationsUsingUnits(tx);
      if (stationCount > 0) return { ok: false, reason: 'in_use', stationCount };
    }
    const [before] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, STATION_UNITS_SETTING_KEY));
    if (mode === 'update') {
      if (before == null) return { ok: false, reason: 'not_found' };
      const [row] = await tx
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, STATION_UNITS_SETTING_KEY))
        .returning();
      if (row == null) return { ok: false, reason: 'not_found' };
      return { ok: true, before, row };
    }
    const [row] = await tx
      .insert(settings)
      .values({ key: STATION_UNITS_SETTING_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .returning();
    if (row == null) throw new Error('Insert with onConflictDoUpdate returned no rows');
    return { ok: true, before, row };
  });
}
