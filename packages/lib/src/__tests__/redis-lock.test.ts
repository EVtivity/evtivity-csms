// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { withLock } from '../redis-lock.js';

// Minimal fake Redis: SET NX succeeds only when the key is free; the
// owner-checked EVAL release frees it again.
function makeRedis(initiallyHeld = false): Redis & { isHeld: () => boolean } {
  let held = initiallyHeld;
  const fake = {
    set: vi.fn((..._args: unknown[]) => {
      if (held) return Promise.resolve(null);
      held = true;
      return Promise.resolve('OK');
    }),
    eval: vi.fn((..._args: unknown[]) => {
      held = false;
      return Promise.resolve(1);
    }),
    isHeld: () => held,
  };
  return fake as unknown as Redis & { isHeld: () => boolean };
}

describe('withLock', () => {
  it('acquires, runs fn, and releases', async () => {
    const redis = makeRedis();
    const fn = vi.fn(() => Promise.resolve('value'));

    const res = await withLock(redis, 'k', fn);

    expect(res).toEqual({ acquired: true, result: 'value' });
    expect(fn).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledOnce(); // released
    expect(redis.isHeld()).toBe(false);
  });

  it('returns the result when the release fails (the lock expires through its TTL)', async () => {
    const redis = makeRedis();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error('redis down'));

    const res = await withLock(redis, 'k', () => Promise.resolve('value'));

    expect(res).toEqual({ acquired: true, result: 'value' });
  });

  it('try-once skips without running fn when the lock is held', async () => {
    const redis = makeRedis(true);
    const fn = vi.fn(() => Promise.resolve('value'));

    const res = await withLock(redis, 'k', fn, { acquireTimeoutMs: 0 });

    expect(res).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled(); // nothing to release
  });

  it('releases the lock even when fn throws', async () => {
    const redis = makeRedis();
    const boom = new Error('boom');

    await expect(withLock(redis, 'k', () => Promise.reject(boom))).rejects.toThrow('boom');

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.isHeld()).toBe(false);
  });

  it('blocking mode retries until the lock frees, then runs', async () => {
    let held = true;
    const redis = {
      set: vi.fn(() => {
        if (held) return Promise.resolve(null);
        held = true;
        return Promise.resolve('OK');
      }),
      eval: vi.fn(() => {
        held = false;
        return Promise.resolve(1);
      }),
    } as unknown as Redis;
    // free the lock shortly after the first failed acquire
    setTimeout(() => {
      held = false;
    }, 10);

    const res = await withLock(redis, 'k', () => Promise.resolve('ok'), { retryMs: 5 });

    expect(res.acquired).toBe(true);
    expect(res.result).toBe('ok');
    expect((redis.set as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it('throws when the acquire deadline passes', async () => {
    const redis = makeRedis(true); // permanently held
    await expect(
      withLock(redis, 'k', () => Promise.resolve(), { acquireTimeoutMs: 1, retryMs: 5 }),
    ).rejects.toThrow(/Timed out acquiring lock/);
  });
  describe('lease signal', () => {
    function renewingRedis(renew: () => Promise<unknown>): Redis {
      return {
        set: vi.fn(() => Promise.resolve('OK')),
        eval: vi.fn((script: string) =>
          script.includes('pexpire') ? renew() : Promise.resolve(1),
        ),
      } as unknown as Redis;
    }

    async function signalAfter(redis: Redis, waitMs: number): Promise<AbortSignal> {
      let seen: AbortSignal | undefined;
      await withLock(
        redis,
        'k',
        async (signal) => {
          seen = signal;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        },
        { ttlMs: 30, renewMs: 10 },
      );
      if (seen == null) throw new Error('fn did not run');
      return seen;
    }

    it('stays live while every renewal succeeds', async () => {
      const signal = await signalAfter(
        renewingRedis(() => Promise.resolve(1)),
        60,
      );
      expect(signal.aborted).toBe(false);
    });

    it('aborts when a renewal finds the lock held by another token or gone', async () => {
      const signal = await signalAfter(
        renewingRedis(() => Promise.resolve(0)),
        40,
      );
      expect(signal.aborted).toBe(true);
    });

    it('aborts once no renewal succeeded for a whole lease', async () => {
      const signal = await signalAfter(
        renewingRedis(() => Promise.reject(new Error('redis down'))),
        80,
      );
      expect(signal.aborted).toBe(true);
    });

    it('keeps the signal live through a renewal error shorter than a lease', async () => {
      let calls = 0;
      const signal = await signalAfter(
        renewingRedis(() => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('blip')) : Promise.resolve(1);
        }),
        60,
      );
      expect(signal.aborted).toBe(false);
    });
  });
});
