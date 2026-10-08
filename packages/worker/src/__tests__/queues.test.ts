// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as queuesModule from '../queues.js';
import * as libModule from '@evtivity/lib';

const queueCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: unknown, name: string, opts: Record<string, unknown>) {
    queueCalls.push({ name, opts });
    return { name, opts };
  }),
}));

const mockConnection = { host: 'mock-redis' };
const mockLogBullMQErrors = vi.fn((target: unknown, _name: string) => target);
vi.mock('@evtivity/lib', () => ({
  createBullMQConnection: vi.fn(() => mockConnection),
  logBullMQErrors: (target: unknown, name: string) => mockLogBullMQErrors(target, name),
}));

describe('createQueues', () => {
  beforeEach(() => {
    queueCalls.length = 0;
    vi.clearAllMocks();
  });

  it('logs the errors of every queue (no raw BullMQ stack traces on a Redis outage)', async () => {
    const { createQueues } = queuesModule;
    const queues = createQueues('redis://localhost:6379');

    const entries = Object.entries(queues);
    expect(mockLogBullMQErrors).toHaveBeenCalledTimes(entries.length);
    for (const [name, queue] of entries) {
      expect(mockLogBullMQErrors).toHaveBeenCalledWith(queue, name);
    }
  });

  it('creates all thirteen queues with the expected names', async () => {
    const { createQueues, QUEUE_NAMES } = queuesModule;
    const queues = createQueues('redis://localhost:6379');

    expect(queues.cronQueue).toBeDefined();
    expect(queues.loadQueue).toBeDefined();
    expect(queues.guestSessionQueue).toBeDefined();
    expect(queues.reservationQueue).toBeDefined();
    expect(queues.octtQueue).toBeDefined();
    expect(queues.maintenanceFanoutQueue).toBeDefined();
    expect(queues.fleetBillingFanoutQueue).toBeDefined();
    expect(queues.fleetInvoiceQueue).toBeDefined();
    expect(queues.stationWatchQueue).toBeDefined();
    expect(queues.paymentWebhookQueue).toBeDefined();
    expect(queues.remoteStartTimeoutQueue).toBeDefined();
    expect(queues.stationMessageQueue).toBeDefined();
    expect(queues.reportQueue).toBeDefined();

    const names = queueCalls.map((c) => c.name);
    expect(names).toEqual([
      QUEUE_NAMES.CRON_JOBS,
      QUEUE_NAMES.LOAD_MANAGEMENT,
      QUEUE_NAMES.GUEST_SESSION_EVENTS,
      QUEUE_NAMES.RESERVATIONS,
      QUEUE_NAMES.OCTT,
      QUEUE_NAMES.MAINTENANCE_FANOUT,
      QUEUE_NAMES.FLEET_BILLING_FANOUT,
      QUEUE_NAMES.FLEET_INVOICES,
      QUEUE_NAMES.STATION_WATCH,
      QUEUE_NAMES.PAYMENT_WEBHOOKS,
      QUEUE_NAMES.REMOTE_START_TIMEOUTS,
      QUEUE_NAMES.STATION_MESSAGES,
      QUEUE_NAMES.REPORTS,
    ]);
    expect(names).toEqual([
      'cron-jobs',
      'load-management',
      'guest-session-events',
      'reservations',
      'octt',
      'maintenance-fanout',
      'fleet-billing-fanout',
      'fleet-invoices',
      'station-watch',
      'payment-webhooks',
      'remote-start-timeouts',
      'station-messages',
      'reports',
    ]);
  });

  it('gives each queue its own dedicated Redis connection', async () => {
    const { createBullMQConnection } = libModule;
    const { createQueues } = queuesModule;
    createQueues('redis://localhost:6379');

    expect(createBullMQConnection).toHaveBeenCalledTimes(13);
    expect(createBullMQConnection).toHaveBeenCalledWith('redis://localhost:6379');
    for (const call of queueCalls) {
      expect(call.opts.connection).toBe(mockConnection);
    }
  });

  it('configures retention defaults per queue', async () => {
    const { createQueues } = queuesModule;
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
    expect(byName['maintenance-fanout']?.['defaultJobOptions']).toEqual({
      removeOnComplete: 100,
      removeOnFail: { count: 500 },
      attempts: 1,
    });
    // Finished fleet invoice jobs keep their id longer than a month (P7 dedup of the hourly re-add);
    // 6 attempts from 5 minutes outlast a database failover or a deploy.
    expect(byName['fleet-invoices']?.['defaultJobOptions']).toEqual({
      removeOnComplete: { age: 40 * 24 * 60 * 60 },
      removeOnFail: { age: 40 * 24 * 60 * 60 },
      attempts: 6,
      backoff: { type: 'exponential', delay: 300_000 },
    });
  });

  it('configures retry attempts and exponential backoff on guest-session and reservation queues', async () => {
    const { createQueues } = queuesModule;
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
    expect(byName['remote-start-timeouts']?.['defaultJobOptions']).toEqual(expected);
  });

  it('retries payment webhook deliveries five times with exponential backoff', async () => {
    const { createQueues } = queuesModule;
    createQueues('redis://localhost:6379');

    const byName = Object.fromEntries(queueCalls.map((c) => [c.name, c.opts]));

    expect(byName['payment-webhooks']?.['defaultJobOptions']).toEqual({
      removeOnComplete: 200,
      removeOnFail: { count: 500 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });
});
