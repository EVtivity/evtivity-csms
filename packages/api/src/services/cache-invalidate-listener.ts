// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { clearNotificationSettingsCache, clearStationMessageCache } from '@evtivity/lib';
import {
  clearSecuritySettingsCache,
  clearStationMessageSettingsCache,
  clearSystemSettingsCache,
} from '@evtivity/database';
import { clearPermissionCacheLocal } from '../middleware/rbac.js';
import { clearSiteAccessCacheLocal } from '../lib/site-access.js';
import { clearUserActiveCacheLocal } from '../lib/user-active.js';
import { closeUserEventStreams } from '../routes/events.js';
import { closeDriverEventStreams } from '../routes/portal/events.js';
import { clearMaintenanceCheckCacheLocal } from '@evtivity/services/maintenance-check';

interface CacheInvalidateMessage {
  kind:
    | 'permission'
    | 'site'
    | 'active'
    | 'notification_settings'
    | 'security_settings'
    | 'maintenance'
    | 'station_message'
    | 'driver_active';
  userId?: string;
  driverId?: string;
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
 * to avoid a re-publish loop. Every pod, the publishing one included, also
 * ends the user's open SSE streams (`closeUserEventStreams`).
 *
 * Global settings kinds (`notification_settings`, `security_settings`) come
 * from settings.ts and security-settings.ts when an operator rotates SMTP,
 * Twilio, MFA, or reCAPTCHA credentials. The settings clear functions are
 * inherently local-only (no re-publish), so the listener calls them directly.
 *
 * `driver_active` comes from announceDriverDeactivated (driver PATCH
 * `isActive: false` and DELETE): every pod ends the driver's portal streams.
 *
 * `station_message` comes from requestStationMessageRepush after a station
 * message setting, company setting, or state template changes: the listeners
 * here render station screens, so they drop the template and settings caches.
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
      case 'station_message':
        clearStationMessageCache();
        clearStationMessageSettingsCache();
        clearSystemSettingsCache();
        return;
      case 'driver_active':
        // A deactivated driver's open portal streams end on every pod; the
        // reconnect is refused (`driverTokenRejection`).
        if (typeof msg.driverId !== 'string' || msg.driverId === '') return;
        closeDriverEventStreams(msg.driverId);
        return;
      case 'permission':
      case 'site':
      case 'active':
        if (typeof msg.userId !== 'string' || msg.userId === '') return;
        if (msg.kind === 'permission') clearPermissionCacheLocal(msg.userId);
        else if (msg.kind === 'site') clearSiteAccessCacheLocal(msg.userId);
        else clearUserActiveCacheLocal(msg.userId);
        // The user's open event streams captured the old site scope: end them
        // so the browser reconnects under the new scope (or is refused).
        closeUserEventStreams(msg.userId);
        return;
      default:
        // Quietly ignore other kinds (e.g. legacy `{ cache: 'ocppEventSettings' }`
        // payloads aimed at the OCPP server's subscriber).
        return;
    }
  });
}
