// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, mocks } = vi.hoisted(() => ({
  handlers: new Map<string, (raw: string) => void>(),
  mocks: {
    clearNotificationSettingsCache: vi.fn(),
    clearStationMessageCache: vi.fn(),
    clearSecuritySettingsCache: vi.fn(),
    clearStationMessageSettingsCache: vi.fn(),
    clearSystemSettingsCache: vi.fn(),
    clearPermissionCacheLocal: vi.fn(),
    clearSiteAccessCacheLocal: vi.fn(),
    clearUserActiveCacheLocal: vi.fn(),
    clearMaintenanceCheckCacheLocal: vi.fn(),
    closeUserEventStreams: vi.fn(),
    closeDriverEventStreams: vi.fn(),
  },
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    subscribe: (channel: string, handler: (raw: string) => void) => {
      handlers.set(channel, handler);
      return Promise.resolve({ unsubscribe: vi.fn() });
    },
  }),
}));
vi.mock('@evtivity/lib', () => ({
  clearNotificationSettingsCache: mocks.clearNotificationSettingsCache,
  clearStationMessageCache: mocks.clearStationMessageCache,
}));
vi.mock('@evtivity/database', () => ({
  clearSecuritySettingsCache: mocks.clearSecuritySettingsCache,
  clearStationMessageSettingsCache: mocks.clearStationMessageSettingsCache,
  clearSystemSettingsCache: mocks.clearSystemSettingsCache,
}));
vi.mock('../middleware/rbac.js', () => ({
  clearPermissionCacheLocal: mocks.clearPermissionCacheLocal,
}));
vi.mock('../lib/site-access.js', () => ({
  clearSiteAccessCacheLocal: mocks.clearSiteAccessCacheLocal,
}));
vi.mock('../lib/user-active.js', () => ({
  clearUserActiveCacheLocal: mocks.clearUserActiveCacheLocal,
}));
vi.mock('../routes/events.js', () => ({
  closeUserEventStreams: mocks.closeUserEventStreams,
}));
vi.mock('../routes/portal/events.js', () => ({
  closeDriverEventStreams: mocks.closeDriverEventStreams,
}));
vi.mock('@evtivity/services/maintenance-check', () => ({
  clearMaintenanceCheckCacheLocal: mocks.clearMaintenanceCheckCacheLocal,
}));

import { startCacheInvalidateListener } from '../services/cache-invalidate-listener.js';

const logger = { warn: vi.fn() };

async function deliver(message: unknown): Promise<void> {
  await startCacheInvalidateListener(logger as never);
  handlers.get('cache_invalidate')?.(JSON.stringify(message));
}

describe('startCacheInvalidateListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it('drops the station message template and settings caches on station_message', async () => {
    await deliver({ kind: 'station_message' });

    expect(mocks.clearStationMessageCache).toHaveBeenCalledTimes(1);
    expect(mocks.clearStationMessageSettingsCache).toHaveBeenCalledTimes(1);
    expect(mocks.clearSystemSettingsCache).toHaveBeenCalledTimes(1);
    expect(mocks.clearNotificationSettingsCache).not.toHaveBeenCalled();
  });

  it('clears one user entry for a per-user kind', async () => {
    await deliver({ kind: 'permission', userId: 'usr_1' });

    expect(mocks.clearPermissionCacheLocal).toHaveBeenCalledWith('usr_1');
    expect(mocks.clearStationMessageCache).not.toHaveBeenCalled();
  });

  it.each(['permission', 'site', 'active'])(
    'ends the user event streams on a %s change',
    async (kind) => {
      await deliver({ kind, userId: 'usr_2' });

      expect(mocks.closeUserEventStreams).toHaveBeenCalledWith('usr_2');
    },
  );

  it('ends the driver portal streams on a driver deactivation', async () => {
    await deliver({ kind: 'driver_active', driverId: 'drv_1' });

    expect(mocks.closeDriverEventStreams).toHaveBeenCalledWith('drv_1');
    expect(mocks.closeUserEventStreams).not.toHaveBeenCalled();
  });

  it('ignores a driver deactivation without a driver id', async () => {
    await deliver({ kind: 'driver_active' });

    expect(mocks.closeDriverEventStreams).not.toHaveBeenCalled();
  });

  it('ends no streams for a global kind', async () => {
    await deliver({ kind: 'security_settings' });

    expect(mocks.closeUserEventStreams).not.toHaveBeenCalled();
  });

  it('logs a warning for an invalid payload', async () => {
    await startCacheInvalidateListener(logger as never);
    handlers.get('cache_invalidate')?.('not json');

    expect(logger.warn).toHaveBeenCalled();
  });
});
