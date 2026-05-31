// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';

const KEY_PREFIX = 'ocpp:conn:';
// TTL must exceed the maximum expected heartbeat interval so the registry
// does not expire between heartbeats. OCPP default heartbeat is 300s; we use
// 600s (2x) to absorb jitter and operator-configured intervals up to 600s.
// Connection-manager.add and ocpp.Heartbeat handler both refresh this TTL.
const TTL_SECONDS = 600;

export interface ConnectionRegistry {
  register(stationId: string, instanceId: string): Promise<void>;
  unregister(stationId: string): Promise<void>;
  getInstanceId(stationId: string): Promise<string | null>;
}

export class RedisConnectionRegistry implements ConnectionRegistry {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async register(stationId: string, instanceId: string): Promise<void> {
    await this.redis.set(KEY_PREFIX + stationId, instanceId, 'EX', TTL_SECONDS);
  }

  async unregister(stationId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + stationId);
  }

  async getInstanceId(stationId: string): Promise<string | null> {
    return this.redis.get(KEY_PREFIX + stationId);
  }
}
