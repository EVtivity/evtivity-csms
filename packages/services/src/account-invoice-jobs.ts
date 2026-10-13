// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The BullMQ names and job options of the fleet and member invoice queues,
// shared by the worker (queues, cron) and the API ("Invoice All Members"
// adds its jobs itself). No imports, so the worker queue module stays light.

/** The worker's BullMQ queue of member invoices (one job per fleet, driver and month). */
export const MEMBER_INVOICE_QUEUE = 'member-invoices';

/** The BullMQ job name of one member invoice. */
export const MEMBER_INVOICE_JOB_NAME = 'member-invoice';

/** How long finished fleet and member invoice jobs keep their job id (40 days). */
export const FLEET_INVOICE_JOB_RETENTION_SECONDS = 40 * 24 * 60 * 60;

/** Attempts of one fleet or member invoice job; with the backoff they span about 2.5 hours. */
export const FLEET_INVOICE_JOB_ATTEMPTS = 6;

/** First retry delay of an invoice job (exponential: 5, 10, 20, 40, 80 minutes). */
export const FLEET_INVOICE_JOB_BACKOFF_MS = 5 * 60_000;

/**
 * The default job options of the fleet and member invoice queues. Every
 * process that adds member invoice jobs (the worker cron, the API "Invoice
 * All Members" route) creates its queue with them: BullMQ applies the
 * options of the Queue instance that adds the job.
 */
export const ACCOUNT_INVOICE_JOB_OPTIONS = {
  removeOnComplete: { age: FLEET_INVOICE_JOB_RETENTION_SECONDS },
  removeOnFail: { age: FLEET_INVOICE_JOB_RETENTION_SECONDS },
  attempts: FLEET_INVOICE_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: FLEET_INVOICE_JOB_BACKOFF_MS },
};
