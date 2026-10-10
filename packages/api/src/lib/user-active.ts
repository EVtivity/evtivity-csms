// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

// Cache user isActive status to avoid a DB query on every request.
// Short TTL (30s) balances latency vs deactivation propagation speed.
const userActiveCache = new Map<string, { isActive: boolean; expiresAt: number }>();
const USER_ACTIVE_CACHE_TTL_MS = 30_000;

/**
 * Whether the operator exists and is active. Read on every operator request
 * (`operatorTokenRejection`), in every environment, cached 30 seconds per
 * user; a deactivation drops the entry on every pod (`invalidateUserActiveCache`).
 */
export async function isUserActive(userId: string): Promise<boolean> {
  const cached = userActiveCache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.isActive;
  }
  const [row] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  const isActive = row?.isActive === true;
  userActiveCache.set(userId, { isActive, expiresAt: Date.now() + USER_ACTIVE_CACHE_TTL_MS });
  return isActive;
}

/** Clear the in-process cache only. Used by the cache-invalidate pub/sub
 *  listener so a broadcast invalidation does not re-publish. */
export function clearUserActiveCacheLocal(userId: string): void {
  userActiveCache.delete(userId);
}

/**
 * Clear the cached isActive status of a user and publish `cache_invalidate`
 * `{ kind: 'active', userId }`: every API pod, the publishing one included,
 * drops its entry and ends the user's open event streams. Call after an
 * activation change.
 */
export function invalidateUserActiveCache(userId: string): void {
  clearUserActiveCacheLocal(userId);
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'active', userId }))
    .catch((err: unknown) => {
      // fail-open: other pods fall back to the TTL (P9).
      createLogger('auth').warn({ err, userId }, 'cache_invalidate publish for user status failed');
    });
}
