// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';

const KEY_PREFIX = 'ocpp:conn:';
// An entry lives this long without a refresh. The owning OCPP process
// refreshes every entry it holds on each ping monitor cycle (30 s,
// `refreshOwned`), so the TTL no longer depends on the heartbeat interval. It
// only bounds how long the entry of a crashed process survives. Connect
// (`register`) and the Heartbeat projection also refresh it.
const TTL_SECONDS = 600;

// Stations per pipeline in `refreshOwned`.
const REFRESH_BATCH_SIZE = 500;

// A station that reconnected to another instance is registered to that
// instance; the instance that lost the connection must not delete its entry.
const DELETE_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

// Refresh an entry this instance owns, or recreate one that expired. An entry
// naming another instance (the station reconnected there) is left alone.
const REFRESH_IF_OWNER = `local v = redis.call('GET', KEYS[1]) if v == false or v == ARGV[1] then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 end return 0`;

export interface ConnectionRegistry {
  register(stationId: string, instanceId: string): Promise<void>;
  /** Removes the entry only while it still names this instance. */
  unregister(stationId: string, instanceId: string): Promise<void>;
  getInstanceId(stationId: string): Promise<string | null>;
  /**
   * Refreshes the TTL of every listed station this instance holds, and
   * recreates an expired entry. Never takes over an entry that names another
   * instance. Optional: a registry without it relies on register alone.
   */
  refreshOwned?(stationIds: readonly string[], instanceId: string): Promise<void>;
}

export class RedisConnectionRegistry implements ConnectionRegistry {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async register(stationId: string, instanceId: string): Promise<void> {
    await this.redis.set(KEY_PREFIX + stationId, instanceId, 'EX', TTL_SECONDS);
  }

  async unregister(stationId: string, instanceId: string): Promise<void> {
    await this.redis.eval(DELETE_IF_OWNER, 1, KEY_PREFIX + stationId, instanceId);
  }

  async refreshOwned(stationIds: readonly string[], instanceId: string): Promise<void> {
    for (let start = 0; start < stationIds.length; start += REFRESH_BATCH_SIZE) {
      const pipeline = this.redis.pipeline();
      for (const stationId of stationIds.slice(start, start + REFRESH_BATCH_SIZE)) {
        pipeline.eval(REFRESH_IF_OWNER, 1, KEY_PREFIX + stationId, instanceId, TTL_SECONDS);
      }
      const results = await pipeline.exec();
      const failed = results?.find(([err]) => err != null);
      if (failed?.[0] != null) throw failed[0];
    }
  }

  async getInstanceId(stationId: string): Promise<string | null> {
    return this.redis.get(KEY_PREFIX + stationId);
  }
}
