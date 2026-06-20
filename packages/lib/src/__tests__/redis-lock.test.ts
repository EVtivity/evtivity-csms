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
});
