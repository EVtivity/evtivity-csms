// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';

const KEY_PREFIX = 'ocpp:conn:';
const TTL_SECONDS = 120;

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
