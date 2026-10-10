// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('argon2', async (importActual) => {
  const actual = await importActual<typeof import('argon2')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

import { hash, verify } from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';
import {
  STATION_AUTH_CACHE_TTL_MS,
  STATION_AUTH_FAILURE_LIMIT,
  STATION_AUTH_LOCKOUT_MS,
  StationAuthBackoff,
  StationAuthCache,
  StationPasswordVerifier,
  defaultArgon2Concurrency,
  libuvThreadpoolSize,
} from '../server/middleware/station-password-verifier.js';

const verifyMock = vi.mocked(verify);
const PASSWORD = 'verifier-password-01';
let storedHash = '';

beforeAll(async () => {
  storedHash = await hash(PASSWORD, { ...STATION_PASSWORD_HASH_OPTIONS });
});

beforeEach(() => {
  verifyMock.mockClear();
});

describe('StationAuthCache', () => {
  it('matches only the same station, stored hash and password', () => {
    const cache = new StationAuthCache();
    cache.remember('sta_1', '$argon2id$h1', PASSWORD);

    expect(cache.matches('sta_1', '$argon2id$h1', PASSWORD)).toBe(true);
    expect(cache.matches('sta_1', '$argon2id$h1', 'other-password-0001')).toBe(false);
    expect(cache.matches('sta_1', '$argon2id$h2', PASSWORD)).toBe(false);
    expect(cache.matches('sta_2', '$argon2id$h1', PASSWORD)).toBe(false);
  });

  it('expires an entry after the TTL, which a hit does not extend', () => {
    let now = 1_000;
    const cache = new StationAuthCache({ now: () => now });
    cache.remember('sta_1', '$argon2id$h1', PASSWORD);

    now += STATION_AUTH_CACHE_TTL_MS - 1;
    expect(cache.matches('sta_1', '$argon2id$h1', PASSWORD)).toBe(true);
    now += 1;
    expect(cache.matches('sta_1', '$argon2id$h1', PASSWORD)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('invalidates one station and clears all', () => {
    const cache = new StationAuthCache();
    cache.remember('sta_1', '$argon2id$h1', PASSWORD);
    cache.remember('sta_2', '$argon2id$h2', PASSWORD);

    cache.invalidate('sta_1');
    expect(cache.matches('sta_1', '$argon2id$h1', PASSWORD)).toBe(false);
    expect(cache.matches('sta_2', '$argon2id$h2', PASSWORD)).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('drops the oldest entry over the size bound', () => {
    const cache = new StationAuthCache({ maxEntries: 2 });
    cache.remember('sta_1', '$argon2id$h1', PASSWORD);
    cache.remember('sta_2', '$argon2id$h2', PASSWORD);
    cache.remember('sta_3', '$argon2id$h3', PASSWORD);

    expect(cache.size).toBe(2);
    expect(cache.matches('sta_1', '$argon2id$h1', PASSWORD)).toBe(false);
    expect(cache.matches('sta_3', '$argon2id$h3', PASSWORD)).toBe(true);
  });

  it('keeps no plaintext password in its entries', () => {
    const cache = new StationAuthCache();
    cache.remember('sta_1', '$argon2id$h1', PASSWORD);
    const entries = (cache as unknown as { entries: Map<string, { digest: Buffer }> }).entries;
    const digest = entries.get('sta_1')?.digest;

    expect(digest?.length).toBe(32);
    expect(digest?.toString('utf8')).not.toContain(PASSWORD);
  });

  it('uses a different key per process, so digests do not carry over', () => {
    const a = new StationAuthCache();
    const b = new StationAuthCache();
    a.remember('sta_1', '$argon2id$h1', PASSWORD);
    b.remember('sta_1', '$argon2id$h1', PASSWORD);
    const digestOf = (c: StationAuthCache) =>
      (c as unknown as { entries: Map<string, { digest: Buffer }> }).entries.get('sta_1')?.digest;

    expect(digestOf(a)?.equals(digestOf(b) ?? Buffer.alloc(0))).toBe(false);
  });
});

describe('StationPasswordVerifier', () => {
  it('runs argon2 on a miss and serves the next check from the cache', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });

    expect(await verifier.verify('sta_1', storedHash, PASSWORD)).toEqual({
      valid: true,
      cached: false,
    });
    expect(await verifier.verify('sta_1', storedHash, PASSWORD)).toEqual({
      valid: true,
      cached: true,
    });
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure, so each wrong password costs argon2', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });

    await verifier.verify('sta_1', storedHash, 'wrong-password-0001');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001');

    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(verifier.stats().cacheEntries).toBe(0);
  });

  it('checks again with argon2 after an invalidation', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });
    await verifier.verify('sta_1', storedHash, PASSWORD);

    verifier.invalidate('sta_1');
    const check = await verifier.verify('sta_1', storedHash, PASSWORD);

    expect(check).toEqual({ valid: true, cached: false });
    expect(verifyMock).toHaveBeenCalledTimes(2);
  });

  it('caches nothing without a cache', async () => {
    const verifier = new StationPasswordVerifier({ cache: null });
    await verifier.verify('sta_1', storedHash, PASSWORD);
    await verifier.verify('sta_1', storedHash, PASSWORD);

    expect(verifyMock).toHaveBeenCalledTimes(2);
  });

  it('runs at most maxConcurrent argon2 computations at once, in order', async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    verifyMock.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return true;
    });
    const verifier = new StationPasswordVerifier({ cache: null, maxConcurrent: 2 });

    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        await verifier.verify(`sta_${String(n)}`, storedHash, PASSWORD);
        order.push(n);
      }),
    );
    const actual = await vi.importActual<typeof import('argon2')>('argon2');
    verifyMock.mockImplementation(actual.verify);

    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(verifier.stats()).toMatchObject({ argon2Running: 0, argon2Queued: 0 });
  });

  it('releases the slot when argon2 throws', async () => {
    verifyMock.mockRejectedValueOnce(new Error('pchstr must contain a $ as first char'));
    const verifier = new StationPasswordVerifier({ cache: null, maxConcurrent: 1 });

    await expect(verifier.verify('sta_1', 'not-a-hash', PASSWORD)).rejects.toThrow();
    expect(await verifier.verify('sta_1', storedHash, PASSWORD)).toMatchObject({ valid: true });
  });

  it('flags hashes with other parameters for a rehash', async () => {
    const verifier = new StationPasswordVerifier();
    const legacy = await hash(PASSWORD);

    expect(verifier.needsRehash(legacy)).toBe(true);
    expect(verifier.needsRehash(storedHash)).toBe(false);
    expect(verifier.needsRehash('not-a-hash')).toBe(false);
    const fresh = await verifier.rehash(PASSWORD);
    expect(fresh).toContain('$m=19456,t=2,p=1$');
  });

  it('defaults to one less than the CPUs and the libuv pool, at least 1', () => {
    expect(defaultArgon2Concurrency(1, 4)).toBe(1);
    expect(defaultArgon2Concurrency(2, 4)).toBe(1);
    expect(defaultArgon2Concurrency(3, 4)).toBe(2);
    // The default pool of 4 keeps one thread for DNS, zlib and other crypto.
    expect(defaultArgon2Concurrency(8, 4)).toBe(3);
    expect(defaultArgon2Concurrency(8, 16)).toBe(7);
    expect(defaultArgon2Concurrency(8, 1)).toBe(1);
  });

  it('reads the libuv pool size from UV_THREADPOOL_SIZE, else 4', () => {
    expect(libuvThreadpoolSize(undefined)).toBe(4);
    expect(libuvThreadpoolSize('')).toBe(4);
    expect(libuvThreadpoolSize('abc')).toBe(4);
    expect(libuvThreadpoolSize('0')).toBe(4);
    expect(libuvThreadpoolSize('16')).toBe(16);
    expect(libuvThreadpoolSize('5000')).toBe(1024);
  });
});

describe('StationAuthBackoff', () => {
  it('locks a station out after the failure limit within the window, then forgets it', () => {
    let now = 1_000_000;
    const backoff = new StationAuthBackoff({ now: () => now });
    for (let i = 0; i < STATION_AUTH_FAILURE_LIMIT - 1; i++) backoff.recordFailure('sta_1');
    expect(backoff.lockedForMs('sta_1')).toBe(0);

    backoff.recordFailure('sta_1');
    expect(backoff.lockedForMs('sta_1')).toBe(STATION_AUTH_LOCKOUT_MS);
    expect(backoff.lockedForMs('sta_2')).toBe(0);

    now += STATION_AUTH_LOCKOUT_MS;
    expect(backoff.lockedForMs('sta_1')).toBe(0);
    expect(backoff.size).toBe(0);
  });

  it('starts a new window once the old one passed', () => {
    let now = 0;
    const backoff = new StationAuthBackoff({ limit: 3, windowMs: 1_000, now: () => now });
    backoff.recordFailure('sta_1');
    backoff.recordFailure('sta_1');
    now = 1_000;
    backoff.recordFailure('sta_1');
    expect(backoff.lockedForMs('sta_1')).toBe(0);
  });

  it('clears the count on success and keeps at most maxEntries stations', () => {
    const backoff = new StationAuthBackoff({ limit: 2, maxEntries: 2 });
    backoff.recordFailure('sta_1');
    backoff.recordSuccess('sta_1');
    backoff.recordFailure('sta_1');
    expect(backoff.lockedForMs('sta_1')).toBe(0);

    backoff.recordFailure('sta_2');
    backoff.recordFailure('sta_3');
    expect(backoff.size).toBe(2);
  });
});

describe('StationPasswordVerifier failed-attempt backoff', () => {
  it('runs no argon2 for a locked-out station, but a cached success still passes', async () => {
    const verifier = new StationPasswordVerifier({
      cache: new StationAuthCache(),
      backoff: new StationAuthBackoff({ limit: 2 }),
    });
    await verifier.verify('sta_1', storedHash, PASSWORD);
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0002');
    verifyMock.mockClear();

    const locked = await verifier.verify('sta_1', storedHash, 'wrong-password-0003');
    expect(locked.valid).toBe(false);
    expect(locked.lockedForMs).toBeGreaterThan(0);
    expect(verifyMock).not.toHaveBeenCalled();

    // The station holding the right password reconnects from the cache.
    expect(await verifier.verify('sta_1', storedHash, PASSWORD)).toEqual({
      valid: true,
      cached: true,
    });
    // Other stations are not affected.
    expect(await verifier.verify('sta_2', storedHash, PASSWORD)).toMatchObject({ valid: true });
  });

  it('keeps no backoff when constructed with backoff null', async () => {
    const verifier = new StationPasswordVerifier({ backoff: null });
    for (let i = 0; i < STATION_AUTH_FAILURE_LIMIT + 1; i++) {
      await verifier.verify('sta_1', storedHash, 'wrong-password-0001');
    }
    verifyMock.mockClear();
    const check = await verifier.verify('sta_1', storedHash, 'wrong-password-0001');
    expect(check.lockedForMs).toBeUndefined();
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});

describe('StationPasswordVerifier background rehash', () => {
  it('runs scheduled tasks after the caller returns, one at a time, once per station', async () => {
    const verifier = new StationPasswordVerifier();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(name);
      running--;
    };

    expect(verifier.scheduleRehash('sta_1', task('a'))).toBe(true);
    expect(verifier.scheduleRehash('sta_1', task('dup'))).toBe(false);
    expect(verifier.scheduleRehash('sta_2', task('b'))).toBe(true);
    expect(order).toEqual([]);
    expect(verifier.stats().rehashPending).toBe(2);

    await verifier.whenRehashIdle();
    expect(order).toEqual(['a', 'b']);
    expect(maxRunning).toBe(1);
    expect(verifier.stats().rehashPending).toBe(0);
  });

  it('drops tasks beyond the pending limit and keeps going after a failed task', async () => {
    const verifier = new StationPasswordVerifier({ maxPendingRehashes: 1 });
    const ran: string[] = [];
    expect(
      verifier.scheduleRehash('sta_1', () => {
        ran.push('fail');
        return Promise.reject(new Error('boom'));
      }),
    ).toBe(true);
    expect(verifier.scheduleRehash('sta_2', () => Promise.resolve())).toBe(false);

    await verifier.whenRehashIdle();
    expect(verifier.scheduleRehash('sta_2', async () => void ran.push('ok'))).toBe(true);
    await verifier.whenRehashIdle();
    expect(ran).toEqual(['fail', 'ok']);
  });
});
