// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Owner-checked so an expired-and-stolen lock is never released or renewed by a
// previous holder.
const RELEASE_IF_OWNER_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_IF_OWNER_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export interface WithLockOptions {
  /** Lock lease length in ms. Default 60000. */
  ttlMs?: number;
  /** Renew interval while fn runs, in ms. Default ttlMs / 3. */
  renewMs?: number;
  /**
   * Max time to wait for the lock before giving up, in ms. Default 15 minutes.
   * Set to 0 for try-once: if the lock is held, return immediately without
   * running fn (`{ acquired: false }`) instead of waiting.
   */
  acquireTimeoutMs?: number;
  /** Poll interval while waiting to acquire, in ms. Default 2000. */
  retryMs?: number;
}

export interface WithLockResult<T> {
  acquired: boolean;
  result?: T;
}

/**
 * Run `fn` while holding a distributed Redis lock on `lockKey`, renewing the
 * lease until `fn` settles and releasing it after. Serializes work across
 * processes and replicas that share the same Redis.
 *
 * Blocking mode (default): waits up to `acquireTimeoutMs` for the lock, throws
 * on timeout, and returns `{ acquired: true, result }`.
 *
 * Try-once mode (`acquireTimeoutMs: 0`): returns `{ acquired: false }` without
 * running `fn` when the lock is already held — use this to dedup overlapping
 * runs (e.g. a manual trigger racing a scheduled one).
 */
export async function withLock<T>(
  redis: Redis,
  lockKey: string,
  fn: () => Promise<T>,
  options: WithLockOptions = {},
): Promise<WithLockResult<T>> {
  const ttlMs = options.ttlMs ?? 60_000;
  const renewMs = options.renewMs ?? Math.floor(ttlMs / 3);
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 15 * 60_000;
  const retryMs = options.retryMs ?? 2_000;

  const token = randomUUID();
  const deadline = Date.now() + acquireTimeoutMs;
  while ((await redis.set(lockKey, token, 'PX', ttlMs, 'NX')) == null) {
    if (acquireTimeoutMs === 0) {
      return { acquired: false };
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring lock ${lockKey}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  const renew = setInterval(() => {
    void redis.eval(RENEW_IF_OWNER_LUA, 1, lockKey, token, String(ttlMs)).catch(() => {});
  }, renewMs);
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    clearInterval(renew);
    try {
      await redis.eval(RELEASE_IF_OWNER_LUA, 1, lockKey, token);
    } catch {
      // lock expires via TTL if the release is lost
    }
  }
}
