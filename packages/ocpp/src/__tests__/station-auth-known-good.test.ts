// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  createRedisStationAttemptStore,
  STATION_CHECKS_KEY_PREFIX,
} from '../server/middleware/station-auth-known-good.js';

/** A Redis double that runs the take and refund scripts' rules per key, recording each key. */
function fakeRedis(): { redis: Redis; counts: Map<string, number>; keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const evalFn = (
    script: string,
    _numKeys: number,
    key: string,
    ...args: string[]
  ): Promise<unknown> => {
    keys.push(key);
    const count = counts.get(key) ?? 0;
    if (script.includes("'INCR'")) {
      // args: the slow check key, then ARGV (limit, expiry, interval, token, window).
      if (count < Number(args[1])) {
        counts.set(key, count + 1);
        return Promise.resolve([1, Number(args[args.length - 1])]);
      }
      return Promise.resolve([2, 0]);
    }
    if (count > 0) counts.set(key, count - 1);
    return Promise.resolve(0);
  };
  return { redis: { eval: evalFn } as unknown as Redis, counts, keys };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRedisStationAttemptStore', () => {
  it('keys the failure budget on the fixed window and returns it', async () => {
    const { redis, keys } = fakeRedis();
    vi.spyOn(Date, 'now').mockReturnValue(125_000);
    const store = createRedisStationAttemptStore(redis);
    expect(await store.take('sta_w', 'a', 4, 60_000, 60_000, 't1')).toEqual({
      kind: 'counted',
      window: 2,
    });
    expect(keys[0]).toBe(`${STATION_CHECKS_KEY_PREFIX}sta_w:2`);
  });

  it('refunds a reservation whose window rolled over in its own window only', async () => {
    const { redis, counts } = fakeRedis();
    const now = vi.spyOn(Date, 'now').mockReturnValue(59_900);
    const store = createRedisStationAttemptStore(redis);
    const taken = await store.take('sta_r', 'a', 4, 60_000, 60_000, 't1');
    expect(taken).toEqual({ kind: 'counted', window: 0 });
    // The window rolls over while the check runs; the next window fills.
    now.mockReturnValue(60_100);
    for (let i = 0; i < 4; i++) await store.take('sta_r', 'b', 4, 60_000, 60_000, `n${String(i)}`);
    if (taken.kind !== 'counted') throw new Error('expected a counted take');
    await store.refund('sta_r', taken.window);
    // The new window keeps its full count: no extra guess.
    expect(counts.get(`${STATION_CHECKS_KEY_PREFIX}sta_r:1`)).toBe(4);
    expect(counts.get(`${STATION_CHECKS_KEY_PREFIX}sta_r:0`)).toBe(0);
    expect((await store.take('sta_r', 'b', 4, 60_000, 60_000, 'n-after')).kind).not.toBe('counted');
  });
});
