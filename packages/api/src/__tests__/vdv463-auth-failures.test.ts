// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  VDV463_FAILURE_READ_TIMEOUT_MS,
  VDV463_FAILURE_WINDOW_MS,
  VDV463_MAX_WAIT_MS,
  addressWaiting,
  failureKey,
  memoryFailureStore,
  redisFailureStore,
  waitAfterFailures,
} from '../vdv463/auth-failures.js';

describe('bus depot sign-in failures per address', () => {
  it('waits only after the free failures, doubling up to the cap', () => {
    expect([0, 1, 2].map(waitAfterFailures)).toEqual([0, 0, 0]);
    expect([3, 4, 5].map(waitAfterFailures)).toEqual([1000, 2000, 4000]);
    expect(waitAfterFailures(40)).toBe(VDV463_MAX_WAIT_MS);
  });

  it('keys an IPv6 address by its /64 and an IPv4 address as is', () => {
    expect(failureKey('dps_1', '2001:db8:1:2::1')).toBe(failureKey('dps_1', '2001:db8:1:2::9'));
    expect(failureKey('dps_1', '203.0.113.9')).not.toBe(failureKey('dps_1', '203.0.113.10'));
    expect(failureKey('dps_1', '203.0.113.9')).not.toBe(failureKey('dps_2', '203.0.113.9'));
  });

  it('forgets failures after the window and on a clear', async () => {
    const store = memoryFailureStore();
    await store.fail('k', 0);
    await store.fail('k', 0);
    expect((await store.read('k', 1)).count).toBe(2);
    expect((await store.read('k', VDV463_FAILURE_WINDOW_MS)).count).toBe(0);
    await store.fail('k', 0);
    await store.clear('k');
    expect((await store.read('k', 1)).count).toBe(0);
  });

  it('reports a wait only inside the wait after the last failure', () => {
    expect(addressWaiting({ count: 3, lastFailMs: 0 }, 999)).toBe(true);
    expect(addressWaiting({ count: 3, lastFailMs: 0 }, 1000)).toBe(false);
    expect(addressWaiting({ count: 2, lastFailMs: 0 }, 1)).toBe(false);
  });

  it('falls back to the process counters when Redis fails', async () => {
    const down = () => Promise.reject(new Error('redis down'));
    const redis = { hmget: down, eval: down, del: down } as unknown as Redis;
    const log = { warn: vi.fn() };
    const store = redisFailureStore(redis, log);
    expect(await store.fail('k', 0)).toBe(1);
    expect(await store.fail('k', 0)).toBe(2);
    expect((await store.read('k', 1)).count).toBe(2);
    await store.clear('k');
    expect((await store.read('k', 1)).count).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('falls back to local counters when the Redis read hangs (OCPP-I1)', async () => {
    const down = () => Promise.reject(new Error('redis down'));
    const hang = () => new Promise<never>(() => undefined);
    const redis = { hmget: hang, eval: down, del: down } as unknown as Redis;
    const log = { warn: vi.fn() };
    const store = redisFailureStore(redis, log);
    await store.fail('k', 0);
    const started = Date.now();
    expect((await store.read('k', 1)).count).toBe(1);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(VDV463_FAILURE_READ_TIMEOUT_MS - 20);
    expect(waited).toBeLessThan(VDV463_FAILURE_READ_TIMEOUT_MS + 1000);
  });

  it('counts in Redis with one script per failure', async () => {
    const evalFn = vi.fn(() => Promise.resolve(4));
    const redis = { eval: evalFn } as unknown as Redis;
    const store = redisFailureStore(redis, { warn: vi.fn() });
    expect(await store.fail('rl:vdv463:auth:dps_1:203.0.113.9', 5)).toBe(4);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'rl:vdv463:auth:dps_1:203.0.113.9',
      '5',
      String(VDV463_FAILURE_WINDOW_MS),
    );
  });
});
