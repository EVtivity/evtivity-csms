// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, users } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/** What every operator request checks about its user. */
export interface UserSessionState {
  /** False for a deactivated or unknown user. */
  active: boolean;
  /** `users.session_version`: access tokens of another version are refused. */
  sessionVersion: number;
}

// Cached to avoid a database read on every request. Short TTL (30s) bounds
// the delay on another pod when its invalidation message is lost.
const userActiveCache = new Map<string, { state: UserSessionState; expiresAt: number }>();
const USER_ACTIVE_CACHE_TTL_MS = 30_000;

/**
 * Whether the operator exists and is active, and the session version its
 * access tokens must carry. Read on every operator request
 * (`operatorTokenRejection`), in every environment, cached 30 seconds per
 * user; a status or session version change drops the entry on every pod
 * (`invalidateUserActiveCache`).
 */
export async function getUserSessionState(userId: string): Promise<UserSessionState> {
  const cached = userActiveCache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.state;
  }
  const [row] = await db
    .select({ isActive: users.isActive, sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, userId));
  const state: UserSessionState = {
    active: row?.isActive === true,
    sessionVersion: row?.sessionVersion ?? 0,
  };
  userActiveCache.set(userId, { state, expiresAt: Date.now() + USER_ACTIVE_CACHE_TTL_MS });
  return state;
}

/** Clear the in-process cache only. Used by the cache-invalidate pub/sub
 *  listener so a broadcast invalidation does not re-publish. */
export function clearUserActiveCacheLocal(userId: string): void {
  userActiveCache.delete(userId);
}

/**
 * Clear the cached status and session version of a user and publish
 * `cache_invalidate` `{ kind: 'active', userId }`: every API pod, the
 * publishing one included, drops its entry and ends the user's open event
 * streams. Call after an activation or session version change.
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
