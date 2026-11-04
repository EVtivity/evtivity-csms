// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Failed sign-ins of the bus depot interface, counted per depot system and
// client address (an IPv4 address, an IPv6 /64), so guesses from one address
// never lock the real depot system out from another (the station password
// pattern, security case 222). Each failure of an address doubles its wait
// before the next check; a correct password clears it. Shared through Redis
// across API processes (`rl:vdv463:auth:*`, the api user's rate limit keys);
// a Redis failure falls back to counters in this process.

import type { Redis } from 'ioredis';
import { clientAddressKey } from '@evtivity/lib/ip-address';

/** Failures of one address before it waits; then 1 s, 2 s, 4 s ... up to the cap. */
export const VDV463_FREE_FAILURES = 3;
export const VDV463_MAX_WAIT_MS = 15 * 60_000;
/** How long an address's failures are remembered. */
export const VDV463_FAILURE_WINDOW_MS = 60 * 60_000;
/** Failures of one address that lock it (audited once per lock). */
export const VDV463_ADDRESS_LOCK_FAILURES = 10;
/** Longest wait for the shared failure counters (Redis) before this process's own count is used. */
export const VDV463_FAILURE_READ_TIMEOUT_MS = 200;

export interface AddressFailures {
  count: number;
  lastFailMs: number;
}

export interface AuthFailureStore {
  read: (key: string, nowMs: number) => Promise<AddressFailures>;
  /** Records one failure and returns the new count. */
  fail: (key: string, nowMs: number) => Promise<number>;
  clear: (key: string) => Promise<void>;
}

export function failureKey(systemId: string, ip: string): string {
  return `rl:vdv463:auth:${systemId}:${clientAddressKey(ip)}`;
}

/** The wait after `count` failures: none for the first few, then doubling, capped. */
export function waitAfterFailures(count: number): number {
  if (count < VDV463_FREE_FAILURES) return 0;
  return Math.min(VDV463_MAX_WAIT_MS, 1000 * 2 ** (count - VDV463_FREE_FAILURES));
}

/** An address must wait before its next check. */
export function addressWaiting(failures: AddressFailures, nowMs: number): boolean {
  return failures.count > 0 && nowMs < failures.lastFailMs + waitAfterFailures(failures.count);
}

export function memoryFailureStore(): AuthFailureStore {
  const map = new Map<string, AddressFailures & { expiresMs: number }>();
  const live = (key: string, nowMs: number): AddressFailures | undefined => {
    const e = map.get(key);
    if (e == null) return undefined;
    if (nowMs >= e.expiresMs) {
      map.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    read: (key, nowMs) => Promise.resolve(live(key, nowMs) ?? { count: 0, lastFailMs: 0 }),
    fail: (key, nowMs) => {
      const e = live(key, nowMs);
      const count = (e?.count ?? 0) + 1;
      map.set(key, { count, lastFailMs: nowMs, expiresMs: nowMs + VDV463_FAILURE_WINDOW_MS });
      if (map.size > 50_000) {
        for (const [k, v] of map) if (nowMs >= v.expiresMs) map.delete(k);
      }
      return Promise.resolve(count);
    },
    clear: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const FAIL_SCRIPT = `
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HSET', KEYS[1], 'last', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return count`;

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/** Redis counters with the process counters as the fallback when Redis fails. */
export function redisFailureStore(redis: Redis, log: Logger): AuthFailureStore {
  const local = memoryFailureStore();
  const fallback = <T>(err: unknown, run: () => Promise<T>): Promise<T> => {
    log.warn({ err }, 'Depot system sign-in counters fell back to this process');
    return run();
  };
  return {
    read: async (key, nowMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A Redis stall must not hold a sign-in slot: past the wait the read
        // falls back to this process (the station case 169 rule, OCPP-I1).
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Redis read timed out'));
          }, VDV463_FAILURE_READ_TIMEOUT_MS);
          timer.unref();
        });
        const [count, last] = await Promise.race([redis.hmget(key, 'count', 'last'), timeout]);
        return { count: Number(count ?? 0), lastFailMs: Number(last ?? 0) };
      } catch (err: unknown) {
        return await fallback(err, () => local.read(key, nowMs));
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    },
    fail: async (key, nowMs) => {
      try {
        const count = await redis.eval(
          FAIL_SCRIPT,
          1,
          key,
          String(nowMs),
          String(VDV463_FAILURE_WINDOW_MS),
        );
        return Number(count);
      } catch (err: unknown) {
        return fallback(err, () => local.fail(key, nowMs));
      }
    },
    clear: async (key) => {
      try {
        await redis.del(key);
      } catch (err: unknown) {
        await fallback(err, () => local.clear(key));
      }
    },
  };
}
