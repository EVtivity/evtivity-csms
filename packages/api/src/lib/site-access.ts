// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users, userSiteAssignments, chargingStations } from '@evtivity/database';

interface SiteAccessCache {
  siteIds: string[] | null;
  expiresAt: number;
}

const cache = new Map<string, SiteAccessCache>();
const CACHE_TTL_MS = 60_000;

/**
 * Returns the site IDs the user can access.
 * Returns null if the user has all-site access (no filtering needed).
 * Returns an empty array if the user has no site assignments.
 */
export async function getUserSiteIds(userId: string): Promise<string[] | null> {
  const cached = cache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.siteIds;
  }

  const [user] = await db
    .select({ hasAllSiteAccess: users.hasAllSiteAccess })
    .from(users)
    .where(eq(users.id, userId));

  if (user == null) {
    const result: string[] = [];
    cache.set(userId, { siteIds: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  if (user.hasAllSiteAccess) {
    cache.set(userId, { siteIds: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }

  const assignments = await db
    .select({ siteId: userSiteAssignments.siteId })
    .from(userSiteAssignments)
    .where(eq(userSiteAssignments.userId, userId));

  const siteIds = assignments.map((a) => a.siteId);
  cache.set(userId, { siteIds, expiresAt: Date.now() + CACHE_TTL_MS });
  return siteIds;
}

/**
 * Invalidate the cached site access for a user.
 * Call this when site assignments are modified.
 */
export function invalidateSiteAccessCache(userId: string): void {
  cache.delete(userId);
}

/**
 * Check if a user has access to a station based on its site assignment.
 * Returns true if the user has access, false if not (station not found or site not allowed).
 */
export async function checkStationSiteAccess(stationId: string, userId: string): Promise<boolean> {
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return true;
  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  if (station == null) return false;
  if (station.siteId == null) return true;
  return siteIds.includes(station.siteId);
}
