// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

const warn = vi.fn();
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('logRedisErrors', () => {
  it('logs connection errors at warn with the client name instead of leaving them unhandled', async () => {
    const { logRedisErrors } = await import('../redis-errors.js');
    const client = new EventEmitter() as unknown as Redis;

    expect(logRedisErrors(client, 'bullmq')).toBe(client);
    // An EventEmitter throws on an 'error' event without a listener.
    expect(() => client.emit('error', new Error('connect ETIMEDOUT'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      { err: 'connect ETIMEDOUT', client: 'bullmq' },
      'Redis connection error',
    );
  });
});
