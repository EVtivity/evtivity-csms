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
  STATION_RECENT_SUCCESS_MS,
  knownGoodKeyFrom,
  type KnownGoodStore,
  STATION_AUTH_LOCKOUT_MS,
  StationAuthBackoff,
  StationAuthCache,
  StationPasswordVerifier,
  IP_AUTH_FAILURE_LIMIT,
  SLOW_LANE_INTERVAL_MS,
  STATION_AUTH_FAILURE_WINDOW_MS,
  STATION_SLOW_CHECK_INTERVAL_MS,
  STATION_WIDE_FAILURE_LIMIT,
  type StationAttemptStore,
  type StationCheckTake,
  defaultArgon2Concurrency,
  libuvThreadpoolSize,
  stationAddressKey,
  stationAuthBackoffKey,
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

    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1')).toEqual({
      valid: true,
      cached: false,
    });
    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1')).toEqual({
      valid: true,
      cached: true,
    });
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure, so each wrong password costs argon2', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });

    await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '10.0.0.1');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '10.0.0.1');

    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(verifier.stats().cacheEntries).toBe(0);
  });

  it('checks again with argon2 after an invalidation', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });
    await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1');

    verifier.invalidate('sta_1');
    const check = await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1');

    expect(check).toEqual({ valid: true, cached: false });
    expect(verifyMock).toHaveBeenCalledTimes(2);
  });

  it('caches nothing without a cache', async () => {
    const verifier = new StationPasswordVerifier({ cache: null });
    await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1');
    await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1');

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
        await verifier.verify(`sta_${String(n)}`, storedHash, PASSWORD, '10.0.0.1');
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

    await expect(verifier.verify('sta_1', 'not-a-hash', PASSWORD, '10.0.0.1')).rejects.toThrow();
    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1')).toMatchObject({
      valid: true,
    });
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
    await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '10.0.0.1');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0002', '10.0.0.1');
    verifyMock.mockClear();

    const locked = await verifier.verify('sta_1', storedHash, 'wrong-password-0003', '10.0.0.1');
    expect(locked.valid).toBe(false);
    expect(locked.lockedForMs).toBeGreaterThan(0);
    expect(verifyMock).not.toHaveBeenCalled();

    // The station holding the right password reconnects from the cache.
    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1')).toEqual({
      valid: true,
      cached: true,
    });
    // Other stations are not affected.
    expect(await verifier.verify('sta_2', storedHash, PASSWORD, '10.0.0.1')).toMatchObject({
      valid: true,
    });
  });

  it('keys the lockout on station and client IP', async () => {
    const verifier = new StationPasswordVerifier({
      cache: null,
      backoff: new StationAuthBackoff({ limit: 2 }),
    });
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '203.0.113.9');
    await verifier.verify('sta_1', storedHash, 'wrong-password-0002', '203.0.113.9');
    verifyMock.mockClear();

    // The attacker's address is locked out, even with the right password.
    const attacker = await verifier.verify('sta_1', storedHash, PASSWORD, '203.0.113.9');
    expect(attacker.lockedForMs).toBeGreaterThan(0);
    expect(verifyMock).not.toHaveBeenCalled();

    // The station on another address runs argon2 and connects.
    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '198.51.100.20')).toEqual({
      valid: true,
      cached: false,
    });
    expect(verifyMock).toHaveBeenCalledTimes(1);

    // Its success clears only its own key: the attacker stays locked out.
    expect(
      (await verifier.verify('sta_1', storedHash, PASSWORD, '203.0.113.9')).lockedForMs,
    ).toBeGreaterThan(0);
  });

  it('shares one key per station for an unknown client address', async () => {
    const verifier = new StationPasswordVerifier({
      cache: null,
      backoff: new StationAuthBackoff({ limit: 2 }),
    });
    await verifier.verify('sta_1', storedHash, 'wrong-password-0001', null);
    await verifier.verify('sta_1', storedHash, 'wrong-password-0002', null);
    expect(
      (await verifier.verify('sta_1', storedHash, PASSWORD, null)).lockedForMs,
    ).toBeGreaterThan(0);
    expect(stationAuthBackoffKey('sta_1', null)).toBe('sta_1|unknown');
    expect(stationAuthBackoffKey('sta_1', '10.0.0.1')).toBe('sta_1|10.0.0.1');
  });

  it('keeps no backoff when constructed with backoff null', async () => {
    const verifier = new StationPasswordVerifier({ backoff: null });
    for (let i = 0; i < STATION_AUTH_FAILURE_LIMIT + 1; i++) {
      await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '10.0.0.1');
    }
    verifyMock.mockClear();
    const check = await verifier.verify('sta_1', storedHash, 'wrong-password-0001', '10.0.0.1');
    expect(check.lockedForMs).toBeUndefined();
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});

describe('StationPasswordVerifier per-station and per-IP limits', () => {
  async function restoreVerify(): Promise<void> {
    const actual = await vi.importActual<typeof import('argon2')>('argon2');
    verifyMock.mockImplementation(actual.verify);
  }

  it('runs one argon2 at a time per station, stations in parallel', async () => {
    const running = new Map<string, number>();
    const peak = new Map<string, number>();
    let current = '';
    verifyMock.mockImplementation(async (hashValue: string) => {
      const station = hashValue === storedHash ? current : 'other';
      running.set(station, (running.get(station) ?? 0) + 1);
      peak.set(station, Math.max(peak.get(station) ?? 0, running.get(station) ?? 0));
      await new Promise((r) => setTimeout(r, 5));
      running.set(station, (running.get(station) ?? 1) - 1);
      return false;
    });
    current = 'sta_1';
    const verifier = new StationPasswordVerifier({ cache: null, backoff: null, maxConcurrent: 4 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        verifier.verify(
          'sta_1',
          storedHash,
          `wrong-password-000${String(n)}`,
          `10.0.0.${String(n)}`,
        ),
      ),
    );
    expect(results.every((r) => !r.valid)).toBe(true);
    expect(peak.get('sta_1')).toBe(1);
    expect(verifyMock).toHaveBeenCalledTimes(5);

    // Two stations still check at once.
    let both = 0;
    let bothPeak = 0;
    verifyMock.mockImplementation(async () => {
      both++;
      bothPeak = Math.max(bothPeak, both);
      await new Promise((r) => setTimeout(r, 5));
      both--;
      return false;
    });
    await Promise.all([
      verifier.verify('sta_1', storedHash, 'wrong-password-0006', '10.0.0.6'),
      verifier.verify('sta_2', storedHash, 'wrong-password-0007', '10.0.0.7'),
    ]);
    expect(bothPeak).toBe(2);
    await restoreVerify();
  });

  it('throttles one IP across station ids after the per-IP failure limit', async () => {
    verifyMock.mockResolvedValue(false);
    const verifier = new StationPasswordVerifier({ cache: null });
    const checks = [];
    for (let i = 0; i < 30; i++) {
      checks.push(
        await verifier.verify(`sta_${String(i)}`, storedHash, 'wrong-password-0001', '203.0.113.9'),
      );
    }
    // 20 failures, then one slow-lane verify, then refusals until the interval passes.
    expect(verifyMock).toHaveBeenCalledTimes(IP_AUTH_FAILURE_LIMIT + 1);
    expect(checks[IP_AUTH_FAILURE_LIMIT]).toEqual({ valid: false, cached: false });
    expect(checks[IP_AUTH_FAILURE_LIMIT + 1]?.lockedForMs).toBeGreaterThan(0);
    // Another address still runs argon2.
    verifyMock.mockClear();
    await verifier.verify('sta_99', storedHash, 'wrong-password-0001', '198.51.100.20');
    expect(verifyMock).toHaveBeenCalledTimes(1);
    await restoreVerify();
  });

  it('counts IPv6 addresses of one /64 as one IP', async () => {
    verifyMock.mockResolvedValue(false);
    const verifier = new StationPasswordVerifier({ cache: null });
    for (let i = 1; i <= IP_AUTH_FAILURE_LIMIT + 1; i++) {
      await verifier.verify(
        `sta_${String(i)}`,
        storedHash,
        'wrong-password-0001',
        `2001:db8:5:6::${i.toString(16)}`,
      );
    }
    verifyMock.mockClear();
    const rotated = await verifier.verify(
      'sta_x',
      storedHash,
      'wrong-password-0001',
      '2001:db8:5:6:abcd::1',
    );
    expect(rotated.lockedForMs).toBeGreaterThan(0);
    expect(verifyMock).not.toHaveBeenCalled();
    await restoreVerify();
  });

  // A known-good credential passes every limit without
  // argon2; a locked address gets a bounded slow lane; an address or a header
  // never earns trust.
  async function lockAddress(verifier: StationPasswordVerifier, ip: string): Promise<void> {
    verifyMock.mockResolvedValue(false);
    for (let i = 0; i < IP_AUTH_FAILURE_LIMIT; i++) {
      await verifier.verify(`noise_${String(i)}`, storedHash, 'wrong-password-0001', ip);
    }
    await restoreVerify();
  }

  /** An in-memory stand-in for the shared Redis store, with key expiry on Date.now. */
  function memoryStore(): KnownGoodStore & { data: Map<string, string>; touches: string[][] } {
    const data = new Map<string, string>();
    const expiresAt = new Map<string, number>();
    const touches: string[][] = [];
    const live = (id: string): boolean => {
      if ((expiresAt.get(id) ?? Infinity) > Date.now()) return data.has(id);
      data.delete(id);
      expiresAt.delete(id);
      return false;
    };
    return {
      data,
      touches,
      get: (id) => Promise.resolve(live(id) ? (data.get(id) ?? null) : null),
      set: (id, digest, ttlMs) => {
        data.set(id, digest);
        expiresAt.set(id, Date.now() + ttlMs);
        return Promise.resolve();
      },
      delete: (id) => {
        data.delete(id);
        expiresAt.delete(id);
        return Promise.resolve();
      },
      touch: (ids, ttlMs) => {
        touches.push([...ids]);
        // PEXPIRE: an existing key only.
        for (const id of ids) if (live(id)) expiresAt.set(id, Date.now() + ttlMs);
        return Promise.resolve();
      },
    };
  }

  /** The Redis attempt store's rules (one atomic step each), in memory, on Date.now. */
  function memoryAttemptStore(): StationAttemptStore & { takes: StationCheckTake['kind'][] } {
    // Keyed by station and fixed window, as the Redis keys.
    const failures = new Map<string, { count: number; until: number }>();
    const slow = new Map<string, { token: string; until: number }>();
    const takes: StationCheckTake['kind'][] = [];
    const answer = (taken: StationCheckTake): Promise<StationCheckTake> => {
      takes.push(taken.kind);
      return Promise.resolve(taken);
    };
    return {
      takes,
      take(id, addressKey, limit, windowMs, slowIntervalMs, token): Promise<StationCheckTake> {
        const now = Date.now();
        const window = Math.floor(now / windowMs);
        const failureKey = `${id}:${String(window)}`;
        const entry = failures.get(failureKey);
        const live = entry != null && entry.until > now ? entry : null;
        if ((live?.count ?? 0) < limit) {
          // Reserved in the same step that read the count.
          if (live == null) failures.set(failureKey, { count: 1, until: now + windowMs * 2 });
          else live.count++;
          return answer({ kind: 'counted', window });
        }
        const key = `${id}:${addressKey}`;
        const held = slow.get(key);
        if (held == null || held.until <= now) {
          slow.set(key, { token, until: now + slowIntervalMs });
          return answer({ kind: 'slow', token });
        }
        return answer({ kind: 'wait', retryMs: held.until - now });
      },
      refund(id, window) {
        const entry = failures.get(`${id}:${String(window)}`);
        if (entry != null && entry.count > 0) entry.count--;
        return Promise.resolve();
      },
      giveBack(id, addressKey, token) {
        // Compare and delete, as the Redis script.
        const key = `${id}:${addressKey}`;
        if (slow.get(key)?.token === token) slow.delete(key);
        return Promise.resolve();
      },
    };
  }

  it('lets a valid station behind a locked shared IP through the slow lane after a restart', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });
    await lockAddress(verifier, '203.0.113.50');
    expect(await verifier.verify('sta_new', storedHash, PASSWORD, '203.0.113.50')).toEqual({
      valid: true,
      cached: false,
    });
  });

  it('throttles and counts wrong guesses from a locked address', async () => {
    const verifier = new StationPasswordVerifier({
      cache: new StationAuthCache(),
      slowLaneIntervalMs: 30_000,
    });
    await lockAddress(verifier, '203.0.113.52');
    verifyMock.mockClear();
    // The slow lane runs one full verify, refused and counted.
    expect(
      await verifier.verify('sta_x', storedHash, 'wrong-password-0002', '203.0.113.52'),
    ).toEqual({
      valid: false,
      cached: false,
    });
    // The next one within the interval is refused without argon2.
    const throttled = await verifier.verify(
      'sta_x',
      storedHash,
      'wrong-password-0003',
      '203.0.113.52',
    );
    expect(throttled.lockedForMs).toBeGreaterThan(0);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    // After the interval it may try again (the clock moves, no real wait).
    const later = Date.now() + 31_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await verifier.verify('sta_x', storedHash, 'wrong-password-0004', '203.0.113.52');
    } finally {
      clock.mockRestore();
    }
    expect(verifyMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a known-good credential at once behind a locked IP, also after a restart', async () => {
    const store = memoryStore();
    const key = knownGoodKeyFrom('settings-key-for-test');
    const before = new StationPasswordVerifier({ cache: new StationAuthCache() });
    before.useKnownGoodStore(store, key);
    await before.verify('sta_nat', storedHash, PASSWORD, '203.0.113.51');
    expect(store.data.get('sta_nat')).toMatch(/^[0-9a-f]{64}$/);
    expect(store.data.get('sta_nat')).not.toContain(PASSWORD);

    // A new process (restart or another pod) with an empty local cache.
    const after = new StationPasswordVerifier({ cache: new StationAuthCache() });
    after.useKnownGoodStore(store, key);
    await lockAddress(after, '203.0.113.51');
    verifyMock.mockClear();
    expect(await after.verify('sta_nat', storedHash, PASSWORD, '203.0.113.51')).toEqual({
      valid: true,
      cached: true,
    });
    expect(verifyMock).not.toHaveBeenCalled();
    // Another password, or the same one for a new stored hash, is not known good.
    expect(
      (await after.verify('sta_nat', storedHash, 'wrong-password-0009', '198.51.100.1')).cached,
    ).toBe(false);
    expect((await after.verify('sta_nat', `${storedHash}x`, PASSWORD, '198.51.100.2')).cached).toBe(
      false,
    );
    // An invalidation drops the shared entry.
    after.invalidate('sta_nat');
    await Promise.resolve();
    expect(store.data.has('sta_nat')).toBe(false);
  });

  it('accepts a known-good credential from the local recent-success digest', async () => {
    let now = 1_000_000;
    const cache = new StationAuthCache({ now: () => now });
    const verifier = new StationPasswordVerifier({ cache, slowLaneMaxActive: 1 });
    await verifier.verify('sta_nat', storedHash, PASSWORD, '203.0.113.53');
    await lockAddress(verifier, '203.0.113.53');
    now += STATION_AUTH_CACHE_TTL_MS + 1;
    verifyMock.mockClear();
    expect(await verifier.verify('sta_nat', storedHash, PASSWORD, '203.0.113.53')).toEqual({
      valid: true,
      cached: true,
    });
    expect(verifyMock).not.toHaveBeenCalled();
    now += STATION_RECENT_SUCCESS_MS;
    expect((await verifier.verify('sta_nat', storedHash, PASSWORD, '203.0.113.53')).cached).toBe(
      false,
    );
  });

  it('serializes and counts parallel wrong guesses on a station with a recent success', async () => {
    const verifier = new StationPasswordVerifier({
      cache: new StationAuthCache(),
      backoff: new StationAuthBackoff({ limit: 3 }),
      maxConcurrent: 4,
    });
    await verifier.verify('sta_1', storedHash, PASSWORD, '203.0.113.60');
    verifyMock.mockClear();
    let running = 0;
    let peak = 0;
    verifyMock.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return false;
    });
    const checks = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        verifier.verify('sta_1', storedHash, `wrong-password-000${String(n)}`, '203.0.113.60'),
      ),
    );
    expect(peak).toBe(1);
    // Three failures counted one by one, then the pair is locked out.
    expect(verifyMock).toHaveBeenCalledTimes(3);
    expect(checks.filter((c) => (c.lockedForMs ?? 0) > 0)).toHaveLength(3);
    await restoreVerify();
  });

  it('caps the waiters per address, so other addresses cannot fill a station pool', async () => {
    let release: () => void = () => {};
    const held = new Promise<boolean>((resolve) => {
      release = () => {
        resolve(false);
      };
    });
    const actual = await vi.importActual<typeof import('argon2')>('argon2');
    const verifier = new StationPasswordVerifier({
      cache: new StationAuthCache(),
      backoff: null,
      maxWaiters: 1,
      maxWaitMs: 200,
    });
    await verifier.verify('sta_1', storedHash, PASSWORD, '198.51.100.20');
    verifyMock.mockImplementation((h: string, pw: string | Buffer) =>
      pw === 'attacker-password-01' ? held : actual.verify(h, pw),
    );
    const first = verifier.verify('sta_1', storedHash, 'attacker-password-01', '203.0.113.9');
    // The attacker's address fills its one waiter place; its next check is refused.
    const queued = verifier.verify('sta_1', storedHash, 'attacker-password-01', '203.0.113.9');
    const extra = await verifier.verify('sta_1', storedHash, 'attacker-password-01', '203.0.113.9');
    expect(extra.lockedForMs).toBeGreaterThan(0);
    // The valid station is accepted at once, whatever waits.
    expect(await verifier.verify('sta_1', storedHash, PASSWORD, '198.51.100.20')).toEqual({
      valid: true,
      cached: true,
    });
    // Another address still gets its own waiter place (it waits, then gives up).
    let settled = false;
    const other = verifier
      .verify('sta_1', storedHash, 'other-password-0001', '192.0.2.10')
      .then((c) => {
        settled = true;
        return c;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect((await other).lockedForMs).toBeGreaterThan(0);
    release();
    await Promise.all([first, queued]);
    await restoreVerify();
  });

  // The slow lane must never raise a locked address's guess rate.
  it('gives a locked address fewer verifies a window than the limit that locked it', () => {
    expect(STATION_AUTH_FAILURE_WINDOW_MS / SLOW_LANE_INTERVAL_MS).toBeLessThan(
      IP_AUTH_FAILURE_LIMIT,
    );
  });

  /** Wrong passwords for one station from many addresses, one each (no address lock). */
  async function floodStation(
    verifier: StationPasswordVerifier,
    stationDbId: string,
    times = STATION_WIDE_FAILURE_LIMIT,
  ): Promise<void> {
    verifyMock.mockImplementation(() => Promise.resolve(false));
    for (let i = 0; i < times; i++) {
      await verifier.verify(
        stationDbId,
        storedHash,
        'wrong-password-0001',
        `203.0.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
      );
    }
    await restoreVerify();
  }

  /** Runs `run` with Date.now at `clock.now`, which the test moves. */
  async function withClock<T>(clock: { now: number }, run: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  }

  const HOUR = 60 * 60_000;

  it('keeps the record of a station that stays connected past 24 hours, so it connects at once during a flood', async () => {
    const clock = { now: 1_000_000_000 };
    const store = memoryStore();
    const key = knownGoodKeyFrom('settings-key-for-test');
    await withClock(clock, async () => {
      const holder = new StationPasswordVerifier({ cache: new StationAuthCache() });
      holder.useKnownGoodStore(store, key);
      expect((await holder.verify('sta_t', storedHash, PASSWORD, '198.51.100.7')).valid).toBe(true);
      // The process holds the station: each ping cycle refreshes, at most once an hour.
      clock.now += 23 * HOUR;
      await holder.refreshKnownGood(['sta_t', 'sta_never']);
      clock.now += 30 * 60_000;
      await holder.refreshKnownGood(['sta_t', 'sta_never']);
      expect(store.touches).toEqual([['sta_t', 'sta_never']]);
      // A refresh never creates a record.
      expect(store.data.has('sta_never')).toBe(false);

      // 30 hours after the last connect: another process, no local memory, a flood.
      clock.now = 1_000_000_000 + 30 * HOUR;
      const other = new StationPasswordVerifier({ cache: new StationAuthCache() });
      other.useKnownGoodStore(store, key);
      other.useStationAttemptStore(memoryAttemptStore());
      await floodStation(other, 'sta_t', 40);
      verifyMock.mockClear();
      expect(await other.verify('sta_t', storedHash, PASSWORD, '192.0.2.44')).toEqual({
        valid: true,
        cached: true,
      });
      expect(verifyMock).not.toHaveBeenCalled();
    });
  });

  it('lets no attacker take the slot from a station with a record', async () => {
    const clock = { now: 2_000_000_000 };
    const store = memoryStore();
    const attempts = memoryAttemptStore();
    const key = knownGoodKeyFrom('settings-key-for-test');
    await withClock(clock, async () => {
      const first = new StationPasswordVerifier({ cache: null });
      first.useKnownGoodStore(store, key);
      expect((await first.verify('sta_t', storedHash, PASSWORD, '198.51.100.7')).valid).toBe(true);
      const verifier = new StationPasswordVerifier({ cache: null });
      verifier.useKnownGoodStore(store, key);
      verifier.useStationAttemptStore(attempts);
      await floodStation(verifier, 'sta_t');
      // The attacker holds the station's slow check now.
      verifyMock.mockImplementation(() => Promise.resolve(false));
      expect(
        await verifier.verify('sta_t', storedHash, 'wrong-password-0002', '192.0.2.1'),
      ).toEqual({ valid: false, cached: false });
      await restoreVerify();
      verifyMock.mockClear();
      expect(await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.70')).toEqual({
        valid: true,
        cached: true,
      });
      expect(verifyMock).not.toHaveBeenCalled();
    });
  });

  it('shares the station failure count and the slow check of an address across two processes', async () => {
    const clock = { now: 3_000_000_000 };
    const attempts = memoryAttemptStore();
    await withClock(clock, async () => {
      const a = new StationPasswordVerifier({ cache: null });
      const b = new StationPasswordVerifier({ cache: null });
      a.useStationAttemptStore(attempts);
      b.useStationAttemptStore(attempts);
      verifyMock.mockClear();
      verifyMock.mockImplementation(() => Promise.resolve(false));
      // The budget, spread over two processes and as many addresses.
      for (let i = 0; i < STATION_WIDE_FAILURE_LIMIT; i++) {
        await (i % 2 === 0 ? a : b).verify(
          'sta_t',
          storedHash,
          'wrong-password-0003',
          `192.0.2.${String(i + 1)}`,
        );
      }
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT);
      expect(attempts.takes.every((kind) => kind === 'counted')).toBe(true);
      // Past it, one address gets one check a minute, whichever process it reaches.
      expect(
        (await a.verify('sta_t', storedHash, 'wrong-password-0003', '198.51.100.30')).lockedForMs,
      ).toBeUndefined();
      const refused = await b.verify('sta_t', storedHash, 'wrong-password-0003', '198.51.100.30');
      expect(refused.lockedForMs).toBeGreaterThan(0);
      expect(refused.lockedForMs).toBeLessThanOrEqual(STATION_SLOW_CHECK_INTERVAL_MS);
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT + 1);
      // Another address has its own slow check.
      await b.verify('sta_t', storedHash, 'wrong-password-0003', '198.51.100.31');
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT + 2);
      await restoreVerify();
    });
  });

  it('gives one address at most one check per slow check interval for one station', async () => {
    const clock = { now: 3_499_980_000 };
    const attempts = memoryAttemptStore();
    await withClock(clock, async () => {
      const verifier = new StationPasswordVerifier({ cache: null });
      verifier.useStationAttemptStore(attempts);
      verifyMock.mockClear();
      // Two minutes of guesses from one address, one a second, while other
      // addresses keep the station past its budget.
      for (let minute = 0; minute < 2; minute++) {
        await floodStation(verifier, 'sta_t');
        verifyMock.mockImplementation(() => Promise.resolve(false));
        for (let i = 0; i < STATION_SLOW_CHECK_INTERVAL_MS / 1_000; i++) {
          await verifier.verify('sta_t', storedHash, 'wrong-password-0005', '198.51.100.40');
          clock.now += 1_000;
        }
        await restoreVerify();
      }
      const ownChecks = verifyMock.mock.calls.filter(([, pw]) => pw === 'wrong-password-0005');
      expect(ownChecks).toHaveLength(2);
    });
  });

  it('checks a station without a record within one slow check interval while other addresses flood it', async () => {
    const clock = { now: 4_000_000_000 };
    const attempts = memoryAttemptStore();
    await withClock(clock, async () => {
      const verifier = new StationPasswordVerifier({ cache: null });
      verifier.useStationAttemptStore(attempts);
      await floodStation(verifier, 'sta_t');
      /** Wrong passwords from 200 other addresses, one every 250 ms, for `ms`. */
      const flood = async (ms: number, offset: number): Promise<void> => {
        verifyMock.mockImplementation(() => Promise.resolve(false));
        for (let i = 0; i < ms / 250; i++) {
          await verifier.verify(
            'sta_t',
            storedHash,
            'wrong-password-0004',
            `192.0.2.${String(((i + offset) % 200) + 1)}`,
          );
          clock.now += 250;
        }
        await restoreVerify();
      };
      await flood(30_000, 0);
      // The real station at its own address is checked at once.
      expect(await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.71')).toEqual({
        valid: true,
        cached: false,
      });
      // Behind a NAT shared with an attacker that took the address's slow check
      // first, the station waits at most one interval.
      verifyMock.mockImplementation(() => Promise.resolve(false));
      await verifier.verify('sta_t', storedHash, 'wrong-password-0004', '198.51.100.72');
      await restoreVerify();
      const waiting = await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.72');
      expect(waiting.valid).toBe(false);
      expect(waiting.lockedForMs).toBeGreaterThan(0);
      expect(waiting.lockedForMs).toBeLessThanOrEqual(STATION_SLOW_CHECK_INTERVAL_MS);
      await flood(STATION_SLOW_CHECK_INTERVAL_MS, 120);
      expect(await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.72')).toEqual({
        valid: true,
        cached: false,
      });
    });
  });

  it('keeps a parallel burst of wrong passwords from one address within the budget across processes', async () => {
    const clock = { now: 4_500_000_000 };
    const attempts = memoryAttemptStore();
    let release: () => void = () => {};
    const held = new Promise<boolean>((resolve) => {
      release = () => {
        resolve(false);
      };
    });
    await withClock(clock, async () => {
      verifyMock.mockClear();
      verifyMock.mockImplementation(() => held);
      // 30 processes, each with one check of the same address, all at once.
      const checks = Array.from({ length: 30 }, () => {
        const process = new StationPasswordVerifier({ cache: null });
        process.useStationAttemptStore(attempts);
        return process.verify('sta_t', storedHash, 'wrong-password-0008', '198.51.100.80');
      });
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await Promise.all(checks);
      // The budget plus the one slow check of the address, never one per check.
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT + 1);
      expect(attempts.takes.filter((kind) => kind === 'counted')).toHaveLength(
        STATION_WIDE_FAILURE_LIMIT,
      );
      await restoreVerify();
    });
  });

  it('gives every /64 of one IPv6 /48 one shared slow check, and other addresses their own', async () => {
    const clock = { now: 4_699_980_000 };
    const attempts = memoryAttemptStore();
    await withClock(clock, async () => {
      const verifier = new StationPasswordVerifier({ cache: null });
      verifier.useStationAttemptStore(attempts);
      await floodStation(verifier, 'sta_t');
      verifyMock.mockClear();
      verifyMock.mockImplementation(() => Promise.resolve(false));
      // 1000 different /64s inside 2001:db8:1::/48 over 50 seconds.
      for (let i = 0; i < 1000; i++) {
        await verifier.verify(
          'sta_t',
          storedHash,
          'wrong-password-0009',
          `2001:db8:1:${i.toString(16)}::1`,
        );
        clock.now += 50;
      }
      expect(verifyMock).toHaveBeenCalledTimes(1);
      await restoreVerify();
      // A real station on an IPv4 address or in another /48 is checked at once.
      expect(await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.81')).toEqual({
        valid: true,
        cached: false,
      });
      expect(await verifier.verify('sta_t', storedHash, PASSWORD, '2001:db8:2::5')).toEqual({
        valid: true,
        cached: false,
      });
    });
  });

  it('refunds the place of a right password, so only wrong ones use the budget', async () => {
    const clock = { now: 4_999_980_000 };
    const attempts = memoryAttemptStore();
    await withClock(clock, async () => {
      const verifier = new StationPasswordVerifier({ cache: null });
      verifier.useStationAttemptStore(attempts);
      for (let i = 0; i < 30; i++) {
        expect((await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.9')).valid).toBe(
          true,
        );
      }
      // Thirty right passwords used none of the budget: wrong ones still get 20.
      verifyMock.mockClear();
      await floodStation(verifier, 'sta_t');
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT);
      expect(attempts.takes).toHaveLength(30 + STATION_WIDE_FAILURE_LIMIT);
      expect(attempts.takes.every((kind) => kind === 'counted')).toBe(true);
      verifyMock.mockImplementation(() => Promise.resolve(false));
      await verifier.verify('sta_t', storedHash, 'wrong-password-0006', '198.51.100.50');
      await restoreVerify();
      expect(attempts.takes.at(-1)).toBe('slow');
    });
  });

  it('gives back the place or the slow check of a take that answers after the timeout', async () => {
    // A fixed clock at a window start: every take of the test shares one budget window.
    await withClock({ now: 5_999_940_000 }, async () => {
      const attempts = memoryAttemptStore();
      const limit = STATION_WIDE_FAILURE_LIMIT;
      const take = (id: string, addressKey: string, token: string): Promise<StationCheckTake> =>
        attempts.take(id, addressKey, limit, 60_000, 60_000, token);
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      // Redis runs the take at once; its reply arrives after the timeout.
      const late: StationAttemptStore = {
        take: async (...args) => {
          const taken = await attempts.take(...args);
          await answered;
          return taken;
        },
        refund: (...args) => attempts.refund(...args),
        giveBack: (...args) => attempts.giveBack(...args),
      };
      const verifier = new StationPasswordVerifier({ cache: null, knownGoodStoreTimeoutMs: 20 });
      verifier.useStationAttemptStore(late);
      // A station past its budget: the late take held its address's slow check.
      for (let i = 0; i < limit; i++) await take('sta_l', 'other', `fill-${String(i)}`);
      const addressKey = stationAddressKey('198.51.100.60');
      expect((await verifier.verify('sta_l', storedHash, PASSWORD, '198.51.100.60')).valid).toBe(
        true,
      );
      expect((await take('sta_l', addressKey, 'probe-1')).kind).toBe('wait');
      // A station within its budget: the late take reserved a place.
      for (let i = 0; i < limit - 1; i++) await take('sta_m', 'other', `fill-${String(i)}`);
      expect((await verifier.verify('sta_m', storedHash, PASSWORD, '198.51.100.61')).valid).toBe(
        true,
      );
      answer();
      await new Promise((resolve) => setImmediate(resolve));
      expect((await take('sta_l', addressKey, 'probe-2')).kind).toBe('slow');
      // The refunded place is free again: one more check is counted.
      expect((await take('sta_m', 'other', 'probe-3')).kind).toBe('counted');
      expect((await take('sta_m', 'other', 'probe-4')).kind).toBe('slow');
    });
  });

  it('falls back to local counters when the shared store fails or times out, and logs it once a minute', async () => {
    const warn = vi.fn();
    const failing: StationAttemptStore = {
      take: () => Promise.reject(new Error('redis down')),
      refund: () => Promise.reject(new Error('redis down')),
      giveBack: () => Promise.reject(new Error('redis down')),
    };
    const clock = { now: 6_000_000_000 };
    await withClock(clock, async () => {
      const verifier = new StationPasswordVerifier({ cache: null, logger: { warn } });
      verifier.useStationAttemptStore(failing);
      verifyMock.mockClear();
      await floodStation(verifier, 'sta_t');
      // The local budget, then one local slow check a minute per address.
      verifyMock.mockImplementation(() => Promise.resolve(false));
      await verifier.verify('sta_t', storedHash, 'wrong-password-0007', '198.51.100.70');
      const refused = await verifier.verify(
        'sta_t',
        storedHash,
        'wrong-password-0007',
        '198.51.100.70',
      );
      await restoreVerify();
      expect(refused.lockedForMs).toBeGreaterThan(0);
      expect(verifyMock).toHaveBeenCalledTimes(STATION_WIDE_FAILURE_LIMIT + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      clock.now += STATION_SLOW_CHECK_INTERVAL_MS;
      expect((await verifier.verify('sta_t', storedHash, PASSWORD, '198.51.100.72')).valid).toBe(
        true,
      );
      expect(warn).toHaveBeenCalledTimes(2);
    });

    const never: StationAttemptStore = {
      take: () => new Promise<never>(() => {}),
      refund: () => Promise.resolve(),
      giveBack: () => Promise.resolve(),
    };
    const slowStore = new StationPasswordVerifier({
      cache: null,
      knownGoodStoreTimeoutMs: 20,
      logger: { warn },
    });
    slowStore.useStationAttemptStore(never);
    expect((await slowStore.verify('sta_r', storedHash, PASSWORD, '198.51.100.73')).valid).toBe(
      true,
    );
  });

  it('answers retry later when the slow checks of the process are full', async () => {
    let release: () => void = () => {};
    const held = new Promise<boolean>((resolve) => {
      release = () => {
        resolve(false);
      };
    });
    const verifier = new StationPasswordVerifier({ cache: null, slowLaneMaxActive: 1 });
    verifier.useStationAttemptStore(memoryAttemptStore());
    await floodStation(verifier, 'sta_a');
    await floodStation(verifier, 'sta_b');
    verifyMock.mockImplementation(() => held);
    const running = verifier.verify('sta_a', storedHash, 'wrong-password-0004', '192.0.2.4');
    const busy = await verifier.verify('sta_b', storedHash, PASSWORD, '192.0.2.5');
    expect(busy.lockedForMs).toBe(SLOW_LANE_INTERVAL_MS);
    release();
    await running;
    await restoreVerify();
    // The refused check gave its slow check back: sta_b verifies at once.
    expect((await verifier.verify('sta_b', storedHash, PASSWORD, '192.0.2.5')).valid).toBe(true);
  });

  // A Redis outage must never hold a connection slot for the client's retry period.
  it('reads the shared store with a timeout and never waits for its write', async () => {
    const never = new Promise<never>(() => {});
    const store: KnownGoodStore = {
      get: () => never,
      set: () => never,
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
    };
    const verifier = new StationPasswordVerifier({ cache: null, knownGoodStoreTimeoutMs: 50 });
    verifier.useKnownGoodStore(store, knownGoodKeyFrom('settings-key-for-test'));
    const started = Date.now();
    expect(await verifier.verify('sta_r', storedHash, PASSWORD, '198.51.100.8')).toEqual({
      valid: true,
      cached: false,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    const failing: KnownGoodStore = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
      delete: () => Promise.resolve(),
      touch: () => Promise.reject(new Error('down')),
    };
    const other = new StationPasswordVerifier({ cache: null });
    other.useKnownGoodStore(failing, knownGoodKeyFrom('settings-key-for-test'));
    expect((await other.verify('sta_r', storedHash, PASSWORD, '198.51.100.8')).valid).toBe(true);
  });

  it('knows a cached success by station identity before any lookup', async () => {
    const verifier = new StationPasswordVerifier({ cache: new StationAuthCache() });
    expect(verifier.hasCachedSuccess('CS-1', PASSWORD)).toBe(false);
    await verifier.verify('sta_1', storedHash, PASSWORD, '10.0.0.1', 'CS-1');
    expect(verifier.hasCachedSuccess('CS-1', PASSWORD)).toBe(true);
    expect(verifier.hasCachedSuccess('CS-1', 'other-password-0001')).toBe(false);
    expect(verifier.hasCachedSuccess('CS-2', PASSWORD)).toBe(false);
    verifier.invalidate('sta_1');
    expect(verifier.hasCachedSuccess('CS-1', PASSWORD)).toBe(false);
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
