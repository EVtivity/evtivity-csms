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

  describe('refreshOwned', () => {
    function pipelineMock(results: [Error | null, unknown][] = []) {
      const pipeline = {
        eval: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(results),
      };
      (redis as unknown as { pipeline: ReturnType<typeof vi.fn> }).pipeline = vi
        .fn()
        .mockReturnValue(pipeline);
      return pipeline;
    }

    it('refreshes each station with a compare-and-set script in one pipeline', async () => {
      const pipeline = pipelineMock([
        [null, 1],
        [null, 0],
      ]);
      await registry.refreshOwned(['CS-1', 'CS-2'], 'instance-abc');
      expect(pipeline.eval).toHaveBeenCalledTimes(2);
      expect(pipeline.eval).toHaveBeenCalledWith(
        expect.stringContaining('v == false or v == ARGV[1]'),
        1,
        'ocpp:conn:CS-1',
        'instance-abc',
        600,
      );
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('splits a large station list into batches of 500', async () => {
      const pipeline = pipelineMock();
      const ids = Array.from({ length: 1200 }, (_, i) => `CS-${String(i)}`);
      await registry.refreshOwned(ids, 'instance-abc');
      expect(pipeline.exec).toHaveBeenCalledTimes(3);
      expect(pipeline.eval).toHaveBeenCalledTimes(1200);
    });

    it('rejects when a command in the pipeline failed', async () => {
      pipelineMock([[new Error('NOPERM'), null]]);
      await expect(registry.refreshOwned(['CS-1'], 'instance-abc')).rejects.toThrow('NOPERM');
    });

    it('sends nothing for an empty list', async () => {
      const pipeline = pipelineMock();
      await registry.refreshOwned([], 'instance-abc');
      expect(pipeline.exec).not.toHaveBeenCalled();
    });
  });
});
