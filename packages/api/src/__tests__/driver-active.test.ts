// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rows, publish, warn } = vi.hoisted(() => ({
  rows: { value: [] as unknown[] },
  publish: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(rows.value).then(resolve);
  return {
    db: chain,
    drivers: { id: 'id', isActive: 'isActive', sessionVersion: 'sessionVersion' },
  };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish }) }));
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn }) }));

// The API unit test setup replaces getDriverSessionState; this file tests the real one.
const { getDriverSessionState, announceDriverSessionChange } =
  await vi.importActual<typeof import('../lib/driver-active.js')>('../lib/driver-active.js');

describe('getDriverSessionState', () => {
  it('returns the status and session version of an active driver', async () => {
    rows.value = [{ isActive: true, sessionVersion: 4 }];
    expect(await getDriverSessionState('drv_1')).toEqual({ active: true, sessionVersion: 4 });
  });

  it('is inactive at version 0 for a deactivated or unknown driver', async () => {
    rows.value = [{ isActive: false, sessionVersion: 2 }];
    expect(await getDriverSessionState('drv_1')).toEqual({ active: false, sessionVersion: 2 });
    rows.value = [];
    expect(await getDriverSessionState('drv_1')).toEqual({ active: false, sessionVersion: 0 });
  });
});

describe('announceDriverSessionChange', () => {
  beforeEach(() => {
    publish.mockReset();
    warn.mockReset();
  });

  it('publishes a driver_active invalidation', async () => {
    publish.mockResolvedValue(undefined);
    announceDriverSessionChange('drv_1');
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'driver_active', driverId: 'drv_1' }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failed publish at warn', async () => {
    publish.mockRejectedValue(new Error('redis down'));
    announceDriverSessionChange('drv_1');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
