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
  return { db: chain, drivers: { id: 'id', isActive: 'isActive' } };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish }) }));
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn }) }));

// The API unit test setup replaces isDriverActive; this file tests the real one.
const { isDriverActive, announceDriverDeactivated } =
  await vi.importActual<typeof import('../lib/driver-active.js')>('../lib/driver-active.js');

describe('isDriverActive', () => {
  it('is true for an active driver', async () => {
    rows.value = [{ isActive: true }];
    expect(await isDriverActive('drv_1')).toBe(true);
  });

  it('is false for a deactivated or unknown driver', async () => {
    rows.value = [{ isActive: false }];
    expect(await isDriverActive('drv_1')).toBe(false);
    rows.value = [];
    expect(await isDriverActive('drv_1')).toBe(false);
  });
});

describe('announceDriverDeactivated', () => {
  beforeEach(() => {
    publish.mockReset();
    warn.mockReset();
  });

  it('publishes a driver_active invalidation', async () => {
    publish.mockResolvedValue(undefined);
    announceDriverDeactivated('drv_1');
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'driver_active', driverId: 'drv_1' }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failed publish at warn', async () => {
    publish.mockRejectedValue(new Error('redis down'));
    announceDriverDeactivated('drv_1');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
