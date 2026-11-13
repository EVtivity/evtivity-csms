// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from '@evtivity/lib';
import {
  createRedisKnownGoodStore,
  createRedisStationAttemptStore,
  KNOWN_GOOD_KEY_PREFIX,
  STATION_SLOW_KEY_PREFIX,
} from '../server/middleware/station-auth-known-good.js';

function logger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('createRedisKnownGoodStore', () => {
  it('reads, writes with a TTL and deletes under the known-good prefix', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: vi.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      del: vi.fn((k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      }),
    } as unknown as Redis;
    const known = createRedisKnownGoodStore(redis, logger());
    expect(await known.get('sta_1')).toBeNull();
    await known.set('sta_1', 'digest', 1000);
    expect(redis.set).toHaveBeenCalledWith(`${KNOWN_GOOD_KEY_PREFIX}sta_1`, 'digest', 'PX', 1000);
    expect(await known.get('sta_1')).toBe('digest');
    await known.delete('sta_1');
    expect(await known.get('sta_1')).toBeNull();
  });

  it('treats every Redis failure as a miss and logs it', async () => {
    const fail = () => Promise.reject(new Error('redis down'));
    const pipeline = { pexpire: vi.fn(), exec: fail };
    const redis = {
      get: fail,
      set: fail,
      del: fail,
      pipeline: () => pipeline,
    } as unknown as Redis;
    const log = logger();
    const known = createRedisKnownGoodStore(redis, log);
    expect(await known.get('sta_1')).toBeNull();
    await expect(known.set('sta_1', 'd', 1)).resolves.toBeUndefined();
    await expect(known.delete('sta_1')).resolves.toBeUndefined();
    await expect(known.touch(['sta_1'], 1)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('refreshes only existing records, one PEXPIRE per station, and nothing for none', async () => {
    const pexpire = vi.fn();
    const exec = vi.fn(() => Promise.resolve([]));
    const pipelineFn = vi.fn(() => ({ pexpire, exec }));
    const known = createRedisKnownGoodStore({ pipeline: pipelineFn } as unknown as Redis, logger());
    await known.touch([], 1000);
    expect(pipelineFn).not.toHaveBeenCalled();
    await known.touch(['a', 'b'], 1000);
    expect(pexpire.mock.calls).toEqual([
      [`${KNOWN_GOOD_KEY_PREFIX}a`, 1000],
      [`${KNOWN_GOOD_KEY_PREFIX}b`, 1000],
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('createRedisStationAttemptStore', () => {
  it('answers slow, wait with the remaining time, or wait for the whole interval', async () => {
    const replies: Array<[number, number]> = [
      [2, 0],
      [3, 1500],
      [3, -1],
    ];
    const evalFn = vi.fn(() => Promise.resolve(replies.shift()));
    const store = createRedisStationAttemptStore({ eval: evalFn } as unknown as Redis);
    expect(await store.take('sta_1', '10.0.0.1', 20, 60_000, 60_000, 'tok')).toEqual({
      kind: 'slow',
      token: 'tok',
    });
    expect(await store.take('sta_1', '10.0.0.1', 20, 60_000, 60_000, 'tok')).toEqual({
      kind: 'wait',
      retryMs: 1500,
    });
    expect(await store.take('sta_1', '10.0.0.1', 20, 60_000, 60_000, 'tok')).toEqual({
      kind: 'wait',
      retryMs: 60_000,
    });
  });

  it('gives back the slow check by compare and delete on its token', async () => {
    const evalFn = vi.fn(() => Promise.resolve(1));
    const store = createRedisStationAttemptStore({ eval: evalFn } as unknown as Redis);
    await store.giveBack('sta_1', '10.0.0.1', 'tok');
    const [script, numKeys, key, token] = evalFn.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
    ];
    expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(numKeys).toBe(1);
    expect(key).toBe(`${STATION_SLOW_KEY_PREFIX}sta_1:10.0.0.1`);
    expect(token).toBe('tok');
  });
});
