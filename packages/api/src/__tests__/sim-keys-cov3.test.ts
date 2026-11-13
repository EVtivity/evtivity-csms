// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

const { createRedisClient, sharedRedis } = vi.hoisted(() => {
  const sharedRedis = { set: vi.fn(), quit: vi.fn().mockResolvedValue('OK') };
  return { createRedisClient: vi.fn(() => sharedRedis), sharedRedis };
});

vi.mock('@evtivity/lib', () => ({ createRedisClient }));
vi.mock('../lib/config.js', () => ({ config: { REDIS_URL: 'redis://test:6379' } }));

import {
  closeSimKeyStore,
  redisSimKeyStore,
  setSimKeyStoreForTests,
  simKeyStore,
} from '../lib/sim-keys.js';

function fakeRedis(overrides: Record<string, unknown>): Redis {
  return overrides as unknown as Redis;
}

describe('redisSimKeyStore', () => {
  it('acquires with SET NX PX and reports whether it won', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = redisSimKeyStore(() => fakeRedis({ set }));
    expect(await store.acquire('sim:lock:x', 'tok', 5000)).toBe(true);
    expect(await store.acquire('sim:lock:x', 'tok', 5000)).toBe(false);
    expect(set).toHaveBeenCalledWith('sim:lock:x', 'tok', 'PX', 5000, 'NX');
  });

  it('renews and releases only as the owner through a script', async () => {
    const evalFn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValue(1);
    const store = redisSimKeyStore(() => fakeRedis({ eval: evalFn }));
    expect(await store.renew('k', 't', 3000)).toBe(true);
    expect(await store.renew('k', 't', 3000)).toBe(false);
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('pexpire'), 1, 'k', 't', '3000');
    await store.release('k', 't');
    expect(evalFn).toHaveBeenLastCalledWith(expect.stringContaining("'del'"), 1, 'k', 't');
  });

  it('returns the remaining seconds, null when none', async () => {
    const ttl = vi
      .fn()
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(-2)
      .mockResolvedValueOnce(0);
    const store = redisSimKeyStore(() => fakeRedis({ ttl }));
    expect(await store.ttlSeconds('k')).toBe(42);
    expect(await store.ttlSeconds('k')).toBeNull();
    expect(await store.ttlSeconds('k')).toBeNull();
  });

  it('sets a key for whole seconds, at least one', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const store = redisSimKeyStore(() => fakeRedis({ set }));
    await store.setFor('k', 2.2);
    await store.setFor('k', 0);
    expect(set).toHaveBeenNthCalledWith(1, 'k', '1', 'EX', 3);
    expect(set).toHaveBeenNthCalledWith(2, 'k', '1', 'EX', 1);
  });

  it('increments in a transaction and fails on an error, a discard or no count', async () => {
    const execResults: unknown[] = [
      [[null, 3]],
      [[new Error('NOPERM'), null]],
      null,
      [[null, 'x']],
    ];
    const multi = vi.fn(() => {
      const tx = {
        incr: vi.fn(() => tx),
        expire: vi.fn(() => tx),
        exec: vi.fn(async () => execResults.shift()),
      };
      return tx;
    });
    const store = redisSimKeyStore(() => fakeRedis({ multi }));
    expect(await store.increment('k', 60)).toBe(3);
    await expect(store.increment('k', 60)).rejects.toThrow('NOPERM');
    await expect(store.increment('k', 60)).rejects.toThrow('Redis transaction was discarded');
    await expect(store.increment('k', 60)).rejects.toThrow('Redis INCR returned no count');
  });
});

describe('the process SIM key store', () => {
  it('lets tests replace it, restores Redis, connects lazily and closes once', async () => {
    const replacement = redisSimKeyStore(() => fakeRedis({}));
    setSimKeyStoreForTests(replacement);
    expect(simKeyStore()).toBe(replacement);

    // Closing before any Redis use does nothing.
    await closeSimKeyStore();
    expect(sharedRedis.quit).not.toHaveBeenCalled();

    setSimKeyStoreForTests(null);
    expect(simKeyStore()).not.toBe(replacement);
    sharedRedis.set.mockResolvedValueOnce('OK');
    expect(await simKeyStore().acquire('sim:lock:a', 't', 100)).toBe(true);
    expect(createRedisClient).toHaveBeenCalledWith('redis://test:6379', 'sim', {
      maxRetriesPerRequest: 2,
    });

    await closeSimKeyStore();
    expect(sharedRedis.quit).toHaveBeenCalledTimes(1);
    await closeSimKeyStore();
    expect(sharedRedis.quit).toHaveBeenCalledTimes(1);
  });
});
