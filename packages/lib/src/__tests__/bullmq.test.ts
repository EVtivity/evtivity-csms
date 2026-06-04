// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn(),
}));

const { ctorCalls } = vi.hoisted(() => ({ ctorCalls: [] as unknown[][] }));

vi.mock('ioredis', () => {
  class MockRedis {
    on = vi.fn();
    status = 'ready';
    constructor(...args: unknown[]) {
      ctorCalls.push(args);
    }
  }
  return { Redis: MockRedis, default: MockRedis };
});

describe('createBullMQConnection', () => {
  beforeEach(() => {
    ctorCalls.length = 0;
  });

  it('creates a connection with the provided redis url', async () => {
    const { createBullMQConnection } = await import('../bullmq.js');
    const conn = createBullMQConnection('redis://provided-host:6380');
    expect(conn).toBeDefined();
    expect(ctorCalls[0]?.[0]).toBe('redis://provided-host:6380');
    expect(ctorCalls[0]?.[1]).toEqual({ maxRetriesPerRequest: null, enableReadyCheck: false });
  });

  it('falls back to REDIS_URL env var', async () => {
    process.env['REDIS_URL'] = 'redis://env-host:6379';
    const { createBullMQConnection } = await import('../bullmq.js');
    const conn = createBullMQConnection();
    expect(conn).toBeDefined();
    expect(ctorCalls[0]?.[0]).toBe('redis://env-host:6379');
    delete process.env['REDIS_URL'];
  });

  it('falls back to localhost default when no url and no REDIS_URL env var', async () => {
    const saved = process.env['REDIS_URL'];
    delete process.env['REDIS_URL'];
    const { createBullMQConnection } = await import('../bullmq.js');
    const conn = createBullMQConnection();
    expect(conn).toBeDefined();
    expect(ctorCalls[0]?.[0]).toBe('redis://localhost:6379');
    if (saved != null) process.env['REDIS_URL'] = saved;
  });
});
