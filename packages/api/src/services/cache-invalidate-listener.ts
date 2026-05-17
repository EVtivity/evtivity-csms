// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { getPubSub } from '../lib/pubsub.js';
import { clearPermissionCacheLocal } from '../middleware/rbac.js';
import { clearSiteAccessCacheLocal } from '../lib/site-access.js';
import { clearUserActiveCacheLocal } from '../plugins/auth.js';

interface CacheInvalidateMessage {
  kind: 'permission' | 'site' | 'active';
  userId: string;
}

/**
 * Subscribe to the cache_invalidate channel. Multi-pod Helm deployments need
 * this: when one API pod handles a permission/site-access/deactivation
 * mutation, every other pod's in-process cache for that user must be cleared
 * too. Without this listener the other pods serve stale RBAC decisions for
 * up to the cache TTL (60s permissions/site access, 30s isUserActive).
 *
 * The publish side lives in invalidatePermissionCache, invalidateSiteAccessCache,
 * and invalidateUserActiveCache. They each clear their own local entry and
 * publish to this channel so peers do the same. The listener calls the
 * *_Local variants explicitly to avoid a re-publish loop.
 */
export async function startCacheInvalidateListener(
  logger: FastifyBaseLogger,
): Promise<{ unsubscribe: () => Promise<void> }> {
  return getPubSub().subscribe('cache_invalidate', (raw: string) => {
    let msg: CacheInvalidateMessage;
    try {
      msg = JSON.parse(raw) as CacheInvalidateMessage;
    } catch (err) {
      logger.warn({ err, raw }, 'cache_invalidate: invalid JSON payload');
      return;
    }
    if (typeof msg.userId !== 'string' || msg.userId === '') return;
    switch (msg.kind) {
      case 'permission':
        clearPermissionCacheLocal(msg.userId);
        return;
      case 'site':
        clearSiteAccessCacheLocal(msg.userId);
        return;
      case 'active':
        clearUserActiveCacheLocal(msg.userId);
        return;
      default:
        logger.warn({ kind: (msg as { kind?: unknown }).kind }, 'cache_invalidate: unknown kind');
    }
  });
}
