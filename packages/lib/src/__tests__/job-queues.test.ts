// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; opts: Record<string, unknown>; close: () => Promise<void> }>,
  redis: { quit: vi.fn(async () => 'OK') },
  createRedisClient: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: unknown, name: string, opts: Record<string, unknown>) {
    const queue = { name, opts, on: vi.fn(), close: vi.fn(async () => {}) };
    h.queues.push(queue);
    return queue;
  }),
}));

vi.mock('../redis-client.js', () => ({
  createRedisClient: (...args: unknown[]) => {
    h.createRedisClient(...args);
    return h.redis;
  },
}));

const { closeJobQueues, initJobQueues, jobQueue, setJobQueueResolver } =
  await import('../job-queues.js');

const OPTIONS = { attempts: 1 };

beforeEach(() => {
  h.queues.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  setJobQueueResolver(null);
  await closeJobQueues();
});

describe('job queues', () => {
  it('refuses to add jobs before the process initialized them', () => {
    expect(() => jobQueue('station-watch', OPTIONS)).toThrow(
      'Job queues are not initialized in this process',
    );
  });

  it('creates one queue per name on first use, all on one connection that fails fast', () => {
    initJobQueues('redis://example:6379');
    const a = jobQueue('station-watch', OPTIONS);
    const b = jobQueue('station-watch', OPTIONS);
    const c = jobQueue('maintenance-fanout', { attempts: 2 });

    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(h.queues.map((q) => q.name)).toEqual(['station-watch', 'maintenance-fanout']);
    // The worker's job options of each queue apply to the jobs this process adds.
    expect(h.queues[0]?.opts).toEqual({ connection: h.redis, defaultJobOptions: OPTIONS });
    expect(h.queues[1]?.opts['defaultJobOptions']).toEqual({ attempts: 2 });
    expect(h.createRedisClient).toHaveBeenCalledTimes(1);
    expect(h.createRedisClient).toHaveBeenCalledWith('redis://example:6379', 'job-queues', {
      maxRetriesPerRequest: 2,
    });
  });

  it('closes the queues and their connection, and creates new ones after', async () => {
    initJobQueues('redis://example:6379');
    jobQueue('station-watch', OPTIONS);
    const created = h.queues[0];

    await closeJobQueues();

    expect(created?.close).toHaveBeenCalledTimes(1);
    expect(h.redis.quit).toHaveBeenCalledTimes(1);
    jobQueue('station-watch', OPTIONS);
    expect(h.queues).toHaveLength(2);
  });

  it('resolves through the resolver instead (worker queues, test fakes)', () => {
    const fake = { add: vi.fn(), addBulk: vi.fn() };
    setJobQueueResolver((name) => (name === 'station-watch' ? fake : undefined));

    expect(jobQueue('station-watch', OPTIONS)).toBe(fake);
    expect(() => jobQueue('reports', OPTIONS)).toThrow(
      'Job queue reports is not available in this process',
    );
    expect(h.queues).toHaveLength(0);
  });
});
