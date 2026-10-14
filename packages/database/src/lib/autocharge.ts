// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { vehicleIdColumn, type VehicleIdType } from '@evtivity/lib/vehicle-id';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { chargingStations, sites } from '../schema/assets.js';
import { drivers, vehicles } from '../schema/drivers.js';

const logger = createLogger('autocharge');

/** The company-wide switch; a site's `autocharge_enabled` overrides it when set. */
export const AUTOCHARGE_ENABLED_KEY = 'autocharge.enabled';

const TTL_MS = 60_000;

let companyValue: boolean | undefined;
let companyAt = 0;
const stationCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Drop every cached value so the next read sees a just-saved setting or site. */
export function clearAutochargeCache(): void {
  companyValue = undefined;
  companyAt = 0;
  stationCache.clear();
}

/** The `autocharge.enabled` setting, cached 60 s. Off when unset or on error. */
export async function isAutochargeEnabled(): Promise<boolean> {
  const now = Date.now();
  if (companyValue !== undefined && now - companyAt < TTL_MS) return companyValue;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, AUTOCHARGE_ENABLED_KEY));
    companyValue = row?.value === true;
    companyAt = now;
    return companyValue;
  } catch (err) {
    logger.warn(
      { err, key: AUTOCHARGE_ENABLED_KEY },
      'isAutochargeEnabled failed, using the cached value or off',
    );
    return companyValue ?? false;
  }
}

/**
 * Whether Autocharge is on at the station's site: the site's own value, else
 * the company setting. A station without a site follows the setting. Cached
 * per station 60 s (the authorize hot path). A failed read keeps the cached
 * value, else off: a vehicle never charges on an unknown setting.
 */
export async function isAutochargeEnabledForStation(stationOcppId: string): Promise<boolean> {
  const now = Date.now();
  const cached = stationCache.get(stationOcppId);
  if (cached != null && cached.expiresAt > now) return cached.value;
  try {
    const [row] = await db
      .select({ siteValue: sites.autochargeEnabled })
      .from(chargingStations)
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.stationId, stationOcppId))
      .limit(1);
    const value = row?.siteValue ?? (await isAutochargeEnabled());
    stationCache.set(stationOcppId, { value, expiresAt: now + TTL_MS });
    return value;
  } catch (err) {
    logger.warn(
      { err, stationId: stationOcppId },
      'isAutochargeEnabledForStation failed, using the cached value or off',
    );
    return cached?.value ?? false;
  }
}

/**
 * Whether drivers can use Autocharge anywhere: the setting is on or a site
 * turns it on. The portal offers the vehicle switch only then.
 */
export async function isAutochargeOffered(): Promise<boolean> {
  if (await isAutochargeEnabled()) return true;
  const [row] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.autochargeEnabled, true))
    .limit(1);
  return row != null;
}

export interface AutochargeVehicleMatch {
  vehicleId: string;
  driverId: string;
  driverIsActive: boolean;
  blocked: boolean;
}

/**
 * The Autocharge vehicle a captured id belongs to: the one vehicle with
 * Autocharge on whose VIN (a VIN) or EVCCID (an EVCCID or MAC address) is the
 * normalized value (unique while Autocharge is on), or null.
 */
export async function findAutochargeVehicle(capture: {
  value: string;
  type: VehicleIdType;
}): Promise<AutochargeVehicleMatch | null> {
  const column = vehicleIdColumn(capture.type) === 'vin' ? vehicles.vin : vehicles.evccid;
  const [row] = await db
    .select({
      vehicleId: vehicles.id,
      driverId: vehicles.driverId,
      driverIsActive: drivers.isActive,
      blockedAt: vehicles.autochargeBlockedAt,
    })
    .from(vehicles)
    .innerJoin(drivers, eq(vehicles.driverId, drivers.id))
    .where(and(eq(column, capture.value), eq(vehicles.autochargeEnabled, true), isNotNull(column)))
    .limit(1);
  if (row == null) return null;
  return {
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    driverIsActive: row.driverIsActive,
    blocked: row.blockedAt != null,
  };
}

/**
 * A blocked vehicle with this id (Autocharge on or off): an operator block
 * refuses the id even while the driver has Autocharge off, like a blocked
 * token. Null when no vehicle with the id is blocked.
 */
export async function findBlockedVehicle(capture: {
  value: string;
  type: VehicleIdType;
}): Promise<{ vehicleId: string; driverId: string } | null> {
  const column = vehicleIdColumn(capture.type) === 'vin' ? vehicles.vin : vehicles.evccid;
  const [row] = await db
    .select({ vehicleId: vehicles.id, driverId: vehicles.driverId })
    .from(vehicles)
    .where(and(eq(column, capture.value), sql`${vehicles.autochargeBlockedAt} IS NOT NULL`))
    .limit(1);
  return row ?? null;
}
