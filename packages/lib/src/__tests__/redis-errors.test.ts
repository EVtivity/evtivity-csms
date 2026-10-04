// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

const warn = vi.fn();
const debug = vi.fn();
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug }),
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

describe('logBullMQErrors', () => {
  it('logs a re-emitted connection error at debug and other errors at warn, with the queue', async () => {
    const { logBullMQErrors } = await import('../bullmq.js');
    const queue = new EventEmitter();
    warn.mockClear();

    expect(logBullMQErrors(queue, 'cronQueue')).toBe(queue);
    const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND redis'), { code: 'ENOTFOUND' });
    expect(() => queue.emit('error', lookup)).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      { err: 'getaddrinfo ENOTFOUND redis', queue: 'cronQueue' },
      'BullMQ connection error',
    );
    expect(warn).not.toHaveBeenCalled();

    queue.emit('error', new Error('Missing lock for job 1'));
    expect(warn).toHaveBeenCalledWith(
      { err: 'Missing lock for job 1', queue: 'cronQueue' },
      'BullMQ error',
    );
  });
});
