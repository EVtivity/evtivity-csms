// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn(),
}));

vi.mock('ioredis', () => {
  class MockRedis {
    on = vi.fn();
    status = 'ready';
  }
  return { Redis: MockRedis, default: MockRedis };
});

describe('createBullMQConnection', () => {
  it('creates a connection with the provided redis url', async () => {
    const { createBullMQConnection } = await import('../bullmq.js');
    const conn = createBullMQConnection('redis://localhost:6379');
    expect(conn).toBeDefined();
  });

  it('falls back to REDIS_URL env var', async () => {
    process.env['REDIS_URL'] = 'redis://env-host:6379';
    const { createBullMQConnection } = await import('../bullmq.js');
    const conn = createBullMQConnection();
    expect(conn).toBeDefined();
    delete process.env['REDIS_URL'];
  });
});
