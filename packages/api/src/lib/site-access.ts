// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users, userSiteAssignments, chargingStations } from '@evtivity/database';
import { getPubSub } from './pubsub.js';

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

/** Clear the in-process cache only. Used by the cache-invalidate pub/sub
 *  listener so a broadcast invalidation does not re-publish. */
export function clearSiteAccessCacheLocal(userId: string): void {
  cache.delete(userId);
}

/**
 * Invalidate the cached site access for a user.
 * Call this when site assignments are modified.
 * Also broadcasts to other API pods so they drop their local entry too.
 */
export function invalidateSiteAccessCache(userId: string): void {
  clearSiteAccessCacheLocal(userId);
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'site', userId }))
    .catch(() => {
      // Best-effort; falls back to TTL on other pods.
    });
}

/**
 * Check whether a user can access a specific site. Returns true when:
 * - the user has all-site access (getUserSiteIds returned null)
 * - the siteId is null (unsited stations are visible to everyone)
 * - the siteId is in the user's allowed list.
 *
 * Use this when the caller already knows the target siteId (e.g., the
 * POST /v1/stations body or the before-state siteId on PATCH/DELETE);
 * checkStationSiteAccess below is the right helper when the caller has
 * a stationId instead.
 */
export async function userCanAccessSite(
  userId: string,
  siteId: string | null | undefined,
): Promise<boolean> {
  if (siteId == null) return true;
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return true;
  return siteIds.includes(siteId);
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
