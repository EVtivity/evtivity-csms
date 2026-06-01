// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { getPubSub } from '../lib/pubsub.js';
import { clearNotificationSettingsCache } from '@evtivity/lib';
import { clearSecuritySettingsCache } from '@evtivity/database';
import { clearPermissionCacheLocal } from '../middleware/rbac.js';
import { clearSiteAccessCacheLocal } from '../lib/site-access.js';
import { clearUserActiveCacheLocal } from '../plugins/auth.js';
import { clearMaintenanceCheckCacheLocal } from '../lib/maintenance-check.js';

interface CacheInvalidateMessage {
  kind:
    | 'permission'
    | 'site'
    | 'active'
    | 'notification_settings'
    | 'security_settings'
    | 'maintenance';
  userId?: string;
}

/**
 * Subscribe to the cache_invalidate channel so peer API pods, the OCPP server,
 * and the worker drop their in-process caches the instant another pod handles
 * a mutation. Without this listener peers serve stale state for up to the
 * cache TTL (60s permissions / site access / notification settings / security
 * settings, 30s isUserActive).
 *
 * Per-user kinds (`permission`, `site`, `active`) come from invalidatePermissionCache,
 * invalidateSiteAccessCache, invalidateUserActiveCache. Each helper clears its
 * own local entry AND publishes; the listener uses the *_Local variants here
 * to avoid a re-publish loop.
 *
 * Global settings kinds (`notification_settings`, `security_settings`) come
 * from settings.ts and security-settings.ts when an operator rotates SMTP,
 * Twilio, MFA, or reCAPTCHA credentials. The settings clear functions are
 * inherently local-only (no re-publish), so the listener calls them directly.
 */
export async function startCacheInvalidateListener(
  logger: FastifyBaseLogger,
): Promise<{ unsubscribe: () => Promise<void> }> {
  return getPubSub().subscribe('cache_invalidate', (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, raw }, 'cache_invalidate: invalid JSON payload');
      return;
    }
    if (typeof parsed !== 'object' || parsed == null) return;
    const msg = parsed as CacheInvalidateMessage;
    if (typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'notification_settings':
        clearNotificationSettingsCache();
        return;
      case 'security_settings':
        clearSecuritySettingsCache();
        return;
      case 'maintenance':
        clearMaintenanceCheckCacheLocal();
        return;
      case 'permission':
      case 'site':
      case 'active':
        if (typeof msg.userId !== 'string' || msg.userId === '') return;
        if (msg.kind === 'permission') clearPermissionCacheLocal(msg.userId);
        else if (msg.kind === 'site') clearSiteAccessCacheLocal(msg.userId);
        else clearUserActiveCacheLocal(msg.userId);
        return;
      default:
        // Quietly ignore other kinds (e.g. legacy `{ cache: 'ocppEventSettings' }`
        // payloads aimed at the OCPP server's subscriber).
        return;
    }
  });
}
