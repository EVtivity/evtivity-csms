// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createLogger } from './logger.js';

const logger = createLogger('redis-lock');

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
 *
 * `fn` gets a signal that aborts when the lease is lost: a renewal finds the
 * lock held by another token or gone, or no renewal succeeded for a whole
 * lease. `fn` checks it before work another holder may now be doing.
 */
export async function withLock<T>(
  redis: Redis,
  lockKey: string,
  fn: (signal: AbortSignal) => Promise<T>,
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

  const lease = new AbortController();
  let renewedAt = Date.now();
  const renew = setInterval(() => {
    redis
      .eval(RENEW_IF_OWNER_LUA, 1, lockKey, token, String(ttlMs))
      .then((renewed) => {
        if (Number(renewed) === 1) {
          renewedAt = Date.now();
        } else if (!lease.signal.aborted) {
          logger.warn({ lockKey }, 'Lock lease lost, the holder stops its work');
          lease.abort(new Error(`Lock ${lockKey} lost`));
        }
      })
      .catch((err: unknown) => {
        if (lease.signal.aborted || Date.now() - renewedAt < ttlMs) return;
        logger.warn({ err, lockKey }, 'Lock lease not renewed for a whole lease, the holder stops');
        lease.abort(new Error(`Lock ${lockKey} not renewed`));
      });
  }, renewMs);
  try {
    const result = await fn(lease.signal);
    return { acquired: true, result };
  } finally {
    clearInterval(renew);
    try {
      await redis.eval(RELEASE_IF_OWNER_LUA, 1, lockKey, token);
    } catch (err) {
      logger.warn({ err, lockKey }, 'Lock release failed, the lock expires through its TTL');
    }
  }
}
