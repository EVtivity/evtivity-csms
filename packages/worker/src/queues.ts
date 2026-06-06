// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Queue } from 'bullmq';
import { createBullMQConnection } from '@evtivity/lib';

export const QUEUE_NAMES = {
  CRON_JOBS: 'cron-jobs',
  LOAD_MANAGEMENT: 'load-management',
  GUEST_SESSION_EVENTS: 'guest-session-events',
  RESERVATIONS: 'reservations',
  OCTT: 'octt',
  MAINTENANCE_FANOUT: 'maintenance-fanout',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Creates all BullMQ queues, each with its own Redis connection.
 * BullMQ blocking commands require dedicated connections per queue.
 * Call once at startup.
 */
export function createQueues(redisUrl: string): {
  cronQueue: Queue;
  loadQueue: Queue;
  guestSessionQueue: Queue;
  reservationQueue: Queue;
  octtQueue: Queue;
  maintenanceFanoutQueue: Queue;
} {
  // Each queue needs its own connection for BullMQ blocking commands
  return {
    cronQueue: new Queue(QUEUE_NAMES.CRON_JOBS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: { count: 500 },
      },
    }),
    loadQueue: new Queue(QUEUE_NAMES.LOAD_MANAGEMENT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: { count: 200 },
      },
    }),
    guestSessionQueue: new Queue(QUEUE_NAMES.GUEST_SESSION_EVENTS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    reservationQueue: new Queue(QUEUE_NAMES.RESERVATIONS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    octtQueue: new Queue(QUEUE_NAMES.OCTT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: { count: 100 },
      },
    }),
    // attempts: 1 — the fan-out increments reservations_cancelled_count /
    // sessions_stopped_count via non-idempotent SQL increments, so a retry after
    // a partial failure would double-count. A failed job is logged and left for
    // the maintenance-scheduler cron or an operator re-save to re-trigger.
    maintenanceFanoutQueue: new Queue(QUEUE_NAMES.MAINTENANCE_FANOUT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: { count: 500 },
        attempts: 1,
      },
    }),
  };
}
