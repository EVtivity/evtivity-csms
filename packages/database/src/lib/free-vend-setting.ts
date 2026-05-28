// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { chargingStations } from '../schema/assets.js';
import { sites } from '../schema/assets.js';

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/**
 * Returns true when the station's site has free vend enabled.
 * Sits on the OCPP Authorize / StartTransaction / TransactionEvent.Started
 * hot path, so reads are cached per stationOcppId with a 60s TTL.
 *
 * Fails open to the previous cached value (or false) on DB errors so a
 * transient outage does not break the authorize path.
 */
export async function isSiteFreeVendEnabledByStation(stationOcppId: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(stationOcppId);
  if (cached != null && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const [row] = await db
      .select({ freeVendEnabled: sites.freeVendEnabled })
      .from(chargingStations)
      .innerJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.stationId, stationOcppId));
    const value = row?.freeVendEnabled === true;
    cache.set(stationOcppId, { value, expiresAt: now + TTL_MS });
    return value;
  } catch {
    return cached?.value ?? false;
  }
}

/**
 * Drop every cached free-vend lookup. The toggle is per site but the cache
 * keys by stationOcppId, so a site flip would otherwise require knowing every
 * station's ocpp id at invalidation time. Dropping the whole map is simpler
 * and the cache repopulates on demand.
 */
export function clearFreeVendCache(): void {
  cache.clear();
}
