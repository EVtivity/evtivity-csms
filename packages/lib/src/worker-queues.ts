// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The worker queues that other processes add jobs to (`@evtivity/lib/job-queues`):
// their names and default job options, shared by the worker (which creates the
// queues) and every producer. BullMQ applies the options of the Queue instance
// that adds a job, so all of them must use the same. No imports, so the worker
// queue module stays light.

/** Member notices of a fleet account billing change (API). */
export const FLEET_BILLING_FANOUT_QUEUE = 'fleet-billing-fanout';

/**
 * attempts: 1, each member is fail-open, so a job fails only when the member
 * list cannot be read, and a retry after a partial run would notify members
 * twice.
 */
export const FLEET_BILLING_FANOUT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: { count: 500 },
  attempts: 1,
};

/** Per-station OCPP fan-out of a maintenance window (API, worker cron, OCPP re-assert). */
export const MAINTENANCE_FANOUT_QUEUE = 'maintenance-fanout';

/**
 * attempts: 1, the fan-out increments reservations_cancelled_count and
 * sessions_stopped_count with non-idempotent SQL, so a retry after a partial
 * failure would double-count. A failed job is logged; an operator re-save
 * triggers the fan-out again.
 */
export const MAINTENANCE_FANOUT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: { count: 500 },
  attempts: 1,
};

/** Delayed simulated payment provider events (every process with the simulated provider). */
export const PAYMENT_WEBHOOK_QUEUE = 'payment-webhooks';

/** Retrying is safe: the pipeline dedupes each event on its id (webhook_events, P7). */
export const PAYMENT_WEBHOOK_JOB_OPTIONS = {
  removeOnComplete: 200,
  removeOnFail: { count: 500 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
};

/** Station screen renders: station and session events, config repushes (OCPP, API, worker cron). */
export const STATION_MESSAGE_QUEUE = 'station-messages';

/** Retrying is safe: the content hash skips screens already sent. */
export const STATION_MESSAGE_JOB_OPTIONS = {
  removeOnComplete: 50,
  removeOnFail: { count: 100 },
  attempts: 2,
  backoff: { type: 'exponential', delay: 5000 },
};

/** Station-watch alert dispatches (API, OCPP and worker paths that free a station). */
export const STATION_WATCH_QUEUE = 'station-watch';

/**
 * attempts: 1, the dispatch claims watches with DELETE ... RETURNING, so a
 * retry after a partial failure would find the rows already gone.
 */
export const STATION_WATCH_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: { count: 500 },
  attempts: 1,
};
