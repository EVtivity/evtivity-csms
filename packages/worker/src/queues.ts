// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Queue } from 'bullmq';
import { createBullMQConnection, logBullMQErrors } from '@evtivity/lib';

export const QUEUE_NAMES = {
  CRON_JOBS: 'cron-jobs',
  LOAD_MANAGEMENT: 'load-management',
  GUEST_SESSION_EVENTS: 'guest-session-events',
  RESERVATIONS: 'reservations',
  OCTT: 'octt',
  MAINTENANCE_FANOUT: 'maintenance-fanout',
  FLEET_BILLING_FANOUT: 'fleet-billing-fanout',
  FLEET_INVOICES: 'fleet-invoices',
  STATION_WATCH: 'station-watch',
  PAYMENT_WEBHOOKS: 'payment-webhooks',
  REMOTE_START_TIMEOUTS: 'remote-start-timeouts',
  STATION_MESSAGES: 'station-messages',
  REPORTS: 'reports',
} as const;

/** How long finished fleet invoice jobs keep their job id (40 days). */
export const FLEET_INVOICE_JOB_RETENTION_SECONDS = 40 * 24 * 60 * 60;

/** Attempts of one fleet invoice job; with the backoff they span about 2.5 hours. */
export const FLEET_INVOICE_JOB_ATTEMPTS = 6;

/** First retry delay of a fleet invoice job (exponential: 5, 10, 20, 40, 80 minutes). */
export const FLEET_INVOICE_JOB_BACKOFF_MS = 5 * 60_000;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface WorkerQueues {
  cronQueue: Queue;
  loadQueue: Queue;
  guestSessionQueue: Queue;
  reservationQueue: Queue;
  octtQueue: Queue;
  maintenanceFanoutQueue: Queue;
  fleetBillingFanoutQueue: Queue;
  fleetInvoiceQueue: Queue;
  stationWatchQueue: Queue;
  paymentWebhookQueue: Queue;
  remoteStartTimeoutQueue: Queue;
  stationMessageQueue: Queue;
  reportQueue: Queue;
}

/**
 * Creates all BullMQ queues, each with its own Redis connection.
 * BullMQ blocking commands require dedicated connections per queue.
 * Every queue logs its errors: BullMQ re-emits Redis errors on each Queue and,
 * unheard, prints every one as a raw stack trace. Call once at startup.
 */
export function createQueues(redisUrl: string): WorkerQueues {
  // Each queue needs its own connection for BullMQ blocking commands
  const queues: WorkerQueues = {
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
    // Fleet account billing switch: the member notices of one change (job id
    // per fleet and change, P7). attempts: 1 — each member is fail-open, so the
    // job fails only when the member list cannot be read, and a retry after a
    // partial run would notify members twice.
    fleetBillingFanoutQueue: new Queue(QUEUE_NAMES.FLEET_BILLING_FANOUT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: { count: 500 },
        attempts: 1,
      },
    }),
    // Scheduled fleet invoices: one job per fleet and month (job id
    // fleet-invoice.<fleetId>.<yyyy-mm>, P7). Retrying is safe: the period key
    // refuses a second invoice and the email is sent once. 6 attempts with
    // exponential backoff from 5 minutes (5, 10, 20, 40, 80) span about 2.5
    // hours, so the retries outlast a database failover or a deploy. Finished
    // jobs are kept 40 days, longer than a month, so the hourly cron re-adding
    // a fleet the run already handled (nothing to bill, or failed and
    // recorded) adds nothing.
    fleetInvoiceQueue: new Queue(QUEUE_NAMES.FLEET_INVOICES, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: { age: FLEET_INVOICE_JOB_RETENTION_SECONDS },
        removeOnFail: { age: FLEET_INVOICE_JOB_RETENTION_SECONDS },
        attempts: FLEET_INVOICE_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: FLEET_INVOICE_JOB_BACKOFF_MS },
      },
    }),
    // attempts: 1 — the dispatch claims watches via DELETE ... RETURNING, so a
    // retry after a partial failure would find the rows already gone (no resend)
    // but could re-claim watches added in between. One attempt keeps it simple
    // and one-shot.
    stationWatchQueue: new Queue(QUEUE_NAMES.STATION_WATCH, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: { count: 500 },
        attempts: 1,
      },
    }),
    // Delayed simulated provider events into the webhook pipeline. Retrying is
    // safe: the pipeline dedupes each event on its id (webhook_events, P7).
    paymentWebhookQueue: new Queue(QUEUE_NAMES.PAYMENT_WEBHOOKS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: { count: 500 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    // Delayed close-out of accepted remote starts that never became a
    // transaction. Retrying is safe: the session update is status-guarded and
    // the hold cancel carries its cancel key.
    remoteStartTimeoutQueue: new Queue(QUEUE_NAMES.REMOTE_START_TIMEOUTS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    // Station screen renders: station events, session events, and debounced
    // repushes after a config change. Retrying is safe: the content hash skips
    // screens already sent.
    stationMessageQueue: new Queue(QUEUE_NAMES.STATION_MESSAGES, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: { count: 100 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    // Report generation. attempts: 1 because generateReport records a failure on
    // the report itself; a job that stalls is left to the report sweep.
    reportQueue: new Queue(QUEUE_NAMES.REPORTS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: { count: 200 },
        attempts: 1,
      },
    }),
  };
  for (const [name, queue] of Object.entries(queues)) {
    logBullMQErrors(queue, name);
  }
  return queues;
}
