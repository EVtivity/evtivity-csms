// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rows, reads, publish, warn } = vi.hoisted(() => ({
  rows: { value: [] as unknown[] },
  reads: { count: 0 },
  publish: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => {
    reads.count++;
    return Promise.resolve(rows.value).then(resolve);
  };
  return {
    db: chain,
    users: { id: 'id', isActive: 'isActive', sessionVersion: 'sessionVersion' },
  };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish }) }));
vi.mock('@evtivity/lib', () => ({ createLogger: () => ({ warn }) }));

// The API unit test setup replaces getUserSessionState; this file tests the real one.
const { getUserSessionState, clearUserActiveCacheLocal, invalidateUserActiveCache } =
  await vi.importActual<typeof import('../lib/user-active.js')>('../lib/user-active.js');

describe('getUserSessionState', () => {
  beforeEach(() => {
    reads.count = 0;
    publish.mockReset();
    publish.mockResolvedValue(undefined);
  });

  it('is active with the stored session version for an active operator', async () => {
    rows.value = [{ isActive: true, sessionVersion: 3 }];
    expect(await getUserSessionState('usr_active')).toEqual({ active: true, sessionVersion: 3 });
  });

  it('is false for a deactivated or unknown operator', async () => {
    rows.value = [{ isActive: false }];
    expect((await getUserSessionState('usr_inactive')).active).toBe(false);
    rows.value = [];
    expect((await getUserSessionState('usr_unknown')).active).toBe(false);
  });

  it('caches the status until the entry is cleared', async () => {
    rows.value = [{ isActive: true }];
    expect((await getUserSessionState('usr_cached')).active).toBe(true);
    rows.value = [{ isActive: false }];
    expect((await getUserSessionState('usr_cached')).active).toBe(true);
    expect(reads.count).toBe(1);
    clearUserActiveCacheLocal('usr_cached');
    expect((await getUserSessionState('usr_cached')).active).toBe(false);
    expect(reads.count).toBe(2);
  });

  it('reads the status again after an invalidation', async () => {
    rows.value = [{ isActive: true }];
    expect((await getUserSessionState('usr_inval')).active).toBe(true);
    rows.value = [{ isActive: false }];
    invalidateUserActiveCache('usr_inval');
    expect((await getUserSessionState('usr_inval')).active).toBe(false);
  });
});

describe('invalidateUserActiveCache', () => {
  beforeEach(() => {
    publish.mockReset();
    warn.mockReset();
  });

  it('publishes an active invalidation', async () => {
    publish.mockResolvedValue(undefined);
    invalidateUserActiveCache('usr_1');
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'active', userId: 'usr_1' }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failed publish at warn', async () => {
    publish.mockRejectedValue(new Error('redis down'));
    invalidateUserActiveCache('usr_1');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
