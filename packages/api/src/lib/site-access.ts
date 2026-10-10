// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, users, userSiteAssignments, chargingStations } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import type { ErrorCode } from './error-codes.generated.js';
import { siteInScope } from './site-scope.js';

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
    .catch((err: unknown) => {
      // fail-open: other pods fall back to the 60-second TTL (P9).
      createLogger('site-access').warn(
        { err, userId },
        'cache_invalidate publish for site access failed',
      );
    });
}

/**
 * Check whether a user can access a specific site, or assign a row to it.
 * Returns true when the user has all-site access, or the siteId is in the
 * user's allowed list. A null or undefined siteId (no site: create or move a
 * station without a site) is allowed for all-site users only.
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
  return siteInScope(await getUserSiteIds(userId), siteId);
}

/**
 * Check if a user has access to a station based on its site assignment.
 * Returns false when the station does not exist, has no site and the user is
 * site-restricted, or its site is not in the user's list.
 */
export async function checkStationSiteAccess(stationId: string, userId: string): Promise<boolean> {
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return true;
  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  if (station == null) return false;
  return siteInScope(siteIds, station.siteId);
}

/** True when the user has access to every site (getUserSiteIds is null). */
export async function isAllSiteUser(userId: string): Promise<boolean> {
  return (await getUserSiteIds(userId)) === null;
}

/** The 404 body a route answers for a resource the user may not see. */
export interface SiteScopeNotFound {
  error: string;
  code: ErrorCode;
}

/**
 * Guard for company-wide features (money and configuration that span every
 * site). Returns true when the caller may proceed, that is the user has access
 * to every site. A site-restricted user gets 404 with the route's own
 * not-found body (`notFound`), not 403, so the resource's existence does not
 * leak (design principle P11, multi-tenant isolation). Returns false after the
 * reply was sent.
 */
export async function requireAllSiteAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  notFound: SiteScopeNotFound,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (await isAllSiteUser(userId)) return true;
  await reply.status(404).send(notFound);
  return false;
}

/**
 * Check site ids supplied in a request body (assignments, filters, targets).
 * Returns true when every id is within the user's sites, or the user has
 * access to every site. Duplicates and an empty list are allowed. The caller
 * answers 404 with its site not-found body when this returns false.
 */
export async function assertSitesWithinScope(
  userId: string,
  siteIds: readonly string[],
): Promise<boolean> {
  const allowed = await getUserSiteIds(userId);
  if (allowed == null) return true;
  const allowedSet = new Set(allowed);
  return siteIds.every((id) => allowedSet.has(id));
}
