// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisConnectionRegistry } from '../connection-registry.js';

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

describe('RedisConnectionRegistry', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let registry: RedisConnectionRegistry;

  beforeEach(() => {
    redis = createMockRedis();
    registry = new RedisConnectionRegistry(redis);
  });

  describe('register', () => {
    it('calls redis.set with correct key prefix, value, EX, and TTL', async () => {
      await registry.register('STATION-001', 'instance-abc');
      expect(redis.set).toHaveBeenCalledWith('ocpp:conn:STATION-001', 'instance-abc', 'EX', 600);
    });
  });

  describe('unregister', () => {
    it('deletes the key only when it still names this instance', async () => {
      await registry.unregister('STATION-001', 'instance-abc');
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
        1,
        'ocpp:conn:STATION-001',
        'instance-abc',
      );
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('getInstanceId', () => {
    it('calls redis.get and returns the value', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('instance-xyz');
      const result = await registry.getInstanceId('STATION-002');
      expect(redis.get).toHaveBeenCalledWith('ocpp:conn:STATION-002');
      expect(result).toBe('instance-xyz');
    });

    it('returns null when not found', async () => {
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await registry.getInstanceId('STATION-UNKNOWN');
      expect(redis.get).toHaveBeenCalledWith('ocpp:conn:STATION-UNKNOWN');
      expect(result).toBeNull();
    });
  });
});
