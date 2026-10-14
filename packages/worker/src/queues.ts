// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Queue } from 'bullmq';
import { createBullMQConnection, logBullMQErrors } from '@evtivity/lib';
import { DRIVER_AI_QUEUE } from '@evtivity/lib/driver-ai';
import {
  FLEET_BILLING_FANOUT_JOB_OPTIONS,
  FLEET_BILLING_FANOUT_QUEUE,
  MAINTENANCE_FANOUT_JOB_OPTIONS,
  MAINTENANCE_FANOUT_QUEUE,
  PAYMENT_WEBHOOK_JOB_OPTIONS,
  PAYMENT_WEBHOOK_QUEUE,
  STATION_MESSAGE_JOB_OPTIONS,
  STATION_MESSAGE_QUEUE,
  STATION_WATCH_JOB_OPTIONS,
  STATION_WATCH_QUEUE,
} from '@evtivity/lib/worker-queues';
import {
  ACCOUNT_INVOICE_JOB_OPTIONS,
  MEMBER_INVOICE_QUEUE,
} from '@evtivity/services/account-invoice-jobs';

export const QUEUE_NAMES = {
  CRON_JOBS: 'cron-jobs',
  LOAD_MANAGEMENT: 'load-management',
  GUEST_SESSION_EVENTS: 'guest-session-events',
  RESERVATIONS: 'reservations',
  OCTT: 'octt',
  MAINTENANCE_FANOUT: MAINTENANCE_FANOUT_QUEUE,
  FLEET_BILLING_FANOUT: FLEET_BILLING_FANOUT_QUEUE,
  FLEET_INVOICES: 'fleet-invoices',
  MEMBER_INVOICES: MEMBER_INVOICE_QUEUE,
  STATION_WATCH: STATION_WATCH_QUEUE,
  PAYMENT_WEBHOOKS: PAYMENT_WEBHOOK_QUEUE,
  REMOTE_START_TIMEOUTS: 'remote-start-timeouts',
  STATION_MESSAGES: STATION_MESSAGE_QUEUE,
  REPORTS: 'reports',
  AI_WORKERS: 'ai-workers',
  AI_INSIGHTS: 'ai-insights',
  DRIVER_AI: DRIVER_AI_QUEUE,
} as const;

/** Attempts of one automatic insight job (exponential from 30 s: 30 s, 60 s). */
export const AI_INSIGHT_JOB_ATTEMPTS = 3;
export const AI_INSIGHT_JOB_BACKOFF_MS = 30_000;

/** Attempts of one driver AI analysis (exponential from 30 s: 30 s, 60 s). */
export const DRIVER_AI_JOB_ATTEMPTS = 3;
export const DRIVER_AI_JOB_BACKOFF_MS = 30_000;

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
  memberInvoiceQueue: Queue;
  stationWatchQueue: Queue;
  paymentWebhookQueue: Queue;
  remoteStartTimeoutQueue: Queue;
  stationMessageQueue: Queue;
  reportQueue: Queue;
  aiWorkerQueue: Queue;
  aiInsightQueue: Queue;
  driverAiQueue: Queue;
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
    // The queues below that other processes add jobs to take their job
    // options from @evtivity/lib/worker-queues (BullMQ applies the options of
    // the Queue instance that adds a job), with the reason there.
    // Maintenance station fan-outs (API, worker cron, OCPP re-assert).
    maintenanceFanoutQueue: new Queue(QUEUE_NAMES.MAINTENANCE_FANOUT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: MAINTENANCE_FANOUT_JOB_OPTIONS,
    }),
    // Fleet account billing switch: the member notices of one change (job id
    // per fleet and change, P7), added by the API.
    fleetBillingFanoutQueue: new Queue(QUEUE_NAMES.FLEET_BILLING_FANOUT, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: FLEET_BILLING_FANOUT_JOB_OPTIONS,
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
      defaultJobOptions: ACCOUNT_INVOICE_JOB_OPTIONS,
    }),
    // Member invoices: one job per fleet, driver and month (job id
    // member-invoice.<fleetId>.<driverId>.<yyyy-mm>, plus .<batchId> for
    // "Invoice All Members", P7). Its own queue: a worker of v0.1.45 runs every
    // fleet-invoices job as a fleet invoice. Same options as the fleet invoices.
    // The API adds the "Invoice All Members" jobs with the same options.
    memberInvoiceQueue: new Queue(QUEUE_NAMES.MEMBER_INVOICES, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: ACCOUNT_INVOICE_JOB_OPTIONS,
    }),
    // Station-watch dispatches (API, OCPP and worker paths that free a station).
    stationWatchQueue: new Queue(QUEUE_NAMES.STATION_WATCH, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: STATION_WATCH_JOB_OPTIONS,
    }),
    // Delayed simulated provider events into the webhook pipeline (every
    // process with the simulated provider).
    paymentWebhookQueue: new Queue(QUEUE_NAMES.PAYMENT_WEBHOOKS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: PAYMENT_WEBHOOK_JOB_OPTIONS,
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
    // repushes after a config change (OCPP, API and worker cron).
    stationMessageQueue: new Queue(QUEUE_NAMES.STATION_MESSAGES, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: STATION_MESSAGE_JOB_OPTIONS,
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
    // Background AI worker runs: one job per job, scope and period (job id
    // aiw.<job>.<scope>.<period>, P7). A retry finds its ai_worker_runs claim
    // and does nothing, so a failed run is not repeated: attempts 1.
    aiWorkerQueue: new Queue(QUEUE_NAMES.AI_WORKERS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: { count: 500 },
        attempts: 1,
      },
    }),
    // Automatic insight generations and translations (one job per insight, and
    // per insight and language, P7). Retrying is safe: a job re-reads the
    // insight and acts only on a pending one; the last failure marks it failed.
    aiInsightQueue: new Queue(QUEUE_NAMES.AI_INSIGHTS, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: { count: 500 },
        attempts: AI_INSIGHT_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: AI_INSIGHT_JOB_BACKOFF_MS },
      },
    }),
    driverAiQueue: new Queue(QUEUE_NAMES.DRIVER_AI, {
      connection: createBullMQConnection(redisUrl),
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: { count: 500 },
        attempts: DRIVER_AI_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: DRIVER_AI_JOB_BACKOFF_MS },
      },
    }),
  };
  for (const [name, queue] of Object.entries(queues)) {
    logBullMQErrors(queue, name);
  }
  return queues;
}
