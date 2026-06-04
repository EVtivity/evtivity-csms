// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: unknown, name: string, opts: Record<string, unknown>) {
    queueCalls.push({ name, opts });
    return { name, opts };
  }),
}));

const mockConnection = { host: 'mock-redis' };
vi.mock('@evtivity/lib', () => ({
  createBullMQConnection: vi.fn(() => mockConnection),
}));

describe('createQueues', () => {
  beforeEach(() => {
    queueCalls.length = 0;
    vi.clearAllMocks();
  });

  it('creates all five queues with the expected names', async () => {
    const { createQueues, QUEUE_NAMES } = await import('../queues.js');
    const queues = createQueues('redis://localhost:6379');

    expect(queues.cronQueue).toBeDefined();
    expect(queues.loadQueue).toBeDefined();
    expect(queues.guestSessionQueue).toBeDefined();
    expect(queues.reservationQueue).toBeDefined();
    expect(queues.octtQueue).toBeDefined();

    const names = queueCalls.map((c) => c.name);
    expect(names).toEqual([
      QUEUE_NAMES.CRON_JOBS,
      QUEUE_NAMES.LOAD_MANAGEMENT,
      QUEUE_NAMES.GUEST_SESSION_EVENTS,
      QUEUE_NAMES.RESERVATIONS,
      QUEUE_NAMES.OCTT,
    ]);
    expect(names).toEqual([
      'cron-jobs',
      'load-management',
      'guest-session-events',
      'reservations',
      'octt',
    ]);
  });

  it('gives each queue its own dedicated Redis connection', async () => {
    const { createBullMQConnection } = await import('@evtivity/lib');
    const { createQueues } = await import('../queues.js');
    createQueues('redis://localhost:6379');

    expect(createBullMQConnection).toHaveBeenCalledTimes(5);
    expect(createBullMQConnection).toHaveBeenCalledWith('redis://localhost:6379');
    for (const call of queueCalls) {
      expect(call.opts.connection).toBe(mockConnection);
    }
  });

  it('configures retention defaults per queue', async () => {
    const { createQueues } = await import('../queues.js');
    createQueues('redis://localhost:6379');

    const byName = Object.fromEntries(queueCalls.map((c) => [c.name, c.opts]));

    expect(byName['cron-jobs']?.['defaultJobOptions']).toEqual({
      removeOnComplete: 100,
      removeOnFail: { count: 500 },
    });
    expect(byName['load-management']?.['defaultJobOptions']).toEqual({
      removeOnComplete: 50,
      removeOnFail: { count: 200 },
    });
    expect(byName['octt']?.['defaultJobOptions']).toEqual({
      removeOnComplete: 50,
      removeOnFail: { count: 100 },
    });
  });

  it('configures retry attempts and exponential backoff on guest-session and reservation queues', async () => {
    const { createQueues } = await import('../queues.js');
    createQueues('redis://localhost:6379');

    const byName = Object.fromEntries(queueCalls.map((c) => [c.name, c.opts]));

    const expected = {
      removeOnComplete: 200,
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    };
    expect(byName['guest-session-events']?.['defaultJobOptions']).toEqual(expected);
    expect(byName['reservations']?.['defaultJobOptions']).toEqual(expected);
  });
});
