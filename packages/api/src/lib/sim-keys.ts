// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';
import { createRedisClient } from '@evtivity/lib';
import type { SimKeyStore } from '@evtivity/services/station-sim.service';
import { config } from './config.js';

// The SIM keys (sim:lock, sim:backoff, sim:refresh, sim:reset, sim:signalread)
// live in the shared Redis so every API pod sees them. The api Redis user
// holds `~sim:*`; without it every call fails with NOPERM.

const RENEW_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const DELETE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** A SimKeyStore on an ioredis client. */
export function redisSimKeyStore(redis: () => Redis): SimKeyStore {
  return {
    async acquire(key, token, ttlMs) {
      return (await redis().set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async renew(key, token, ttlMs) {
      return (await redis().eval(RENEW_IF_OWNER, 1, key, token, String(ttlMs))) === 1;
    },
    async release(key, token) {
      await redis().eval(DELETE_IF_OWNER, 1, key, token);
    },
    async ttlSeconds(key) {
      const left = await redis().ttl(key);
      return left > 0 ? left : null;
    },
    async setFor(key, seconds) {
      await redis().set(key, '1', 'EX', Math.max(1, Math.ceil(seconds)));
    },
    async increment(key, windowSeconds) {
      const result = await redis().multi().incr(key).expire(key, windowSeconds, 'NX').exec();
      const [err, count] = result?.[0] ?? [new Error('Redis transaction was discarded'), null];
      if (err != null) throw err;
      if (typeof count !== 'number') throw new Error('Redis INCR returned no count');
      return count;
    },
  };
}

let client: Redis | null = null;

function simRedis(): Redis {
  client ??= createRedisClient(config.REDIS_URL, 'sim', { maxRetriesPerRequest: 2 });
  return client;
}

let store: SimKeyStore = redisSimKeyStore(simRedis);

/** The SIM key store of this API process. */
export function simKeyStore(): SimKeyStore {
  return store;
}

/** Tests replace the store; null restores Redis. */
export function setSimKeyStoreForTests(next: SimKeyStore | null): void {
  store = next ?? redisSimKeyStore(simRedis);
}

/** Closes the Redis client at shutdown. */
export async function closeSimKeyStore(): Promise<void> {
  if (client == null) return;
  const closing = client;
  client = null;
  await closing.quit();
}
