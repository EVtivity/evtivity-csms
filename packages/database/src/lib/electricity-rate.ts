// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import type { ElectricityRatePeriod, ElectricityRatePeriodRestrictions } from '@evtivity/lib';
import { db } from '../config.js';
import { siteElectricityRatePeriods } from '../schema/assets.js';

const logger = createLogger('electricity-rate');

interface CacheEntry {
  periods: ElectricityRatePeriod[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/**
 * Reads a site's electricity rate periods without the cache. For the paths
 * that must see the operator's latest edit (the site recalculation, the seed);
 * throws on a DB error.
 */
export async function loadElectricityRatePeriodsForSite(
  siteId: string,
  database: Pick<typeof db, 'select'> = db,
): Promise<ElectricityRatePeriod[]> {
  const rows = await database
    .select()
    .from(siteElectricityRatePeriods)
    .where(eq(siteElectricityRatePeriods.siteId, siteId));
  return rows.map((row) => ({
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    ratePerKwh: row.ratePerKwh,
    restrictions: row.restrictions as ElectricityRatePeriodRestrictions | null,
    priority: row.priority,
    isDefault: row.isDefault,
  }));
}

/**
 * Returns the electricity rate periods configured for a site. Sits on the
 * TransactionEvent.Ended projection path, so reads are cached per siteId with a
 * 60s TTL. Fails open to the previous cached value (or empty) on DB errors so a
 * transient outage never blocks session completion.
 */
export async function getElectricityRatePeriodsForSite(
  siteId: string,
): Promise<ElectricityRatePeriod[]> {
  const now = Date.now();
  const cached = cache.get(siteId);
  if (cached != null && cached.expiresAt > now) {
    return cached.periods;
  }

  try {
    const periods = await loadElectricityRatePeriodsForSite(siteId);
    cache.set(siteId, { periods, expiresAt: now + TTL_MS });
    return periods;
  } catch (err) {
    logger.warn(
      { err, siteId },
      'getElectricityRatePeriodsForSite failed, using the cached value or no periods',
    );
    return cached?.periods ?? [];
  }
}

export function clearElectricityRateCache(siteId: string): void {
  cache.delete(siteId);
}
