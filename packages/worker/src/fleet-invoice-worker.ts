// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Job, type Queue, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import {
  fleetInvoiceJobId,
  recordFleetInvoiceRunFailure,
  runScheduledFleetInvoice,
} from '@evtivity/services/fleet-invoice-run';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('fleet-invoice-worker');

/** One fleet's scheduled invoice for a month. */
export interface FleetInvoiceJobData {
  fleetId: string;
  period: string;
}

let fleetInvoiceQueue: Queue | null = null;

/** Binds the queue the fleet-invoice-run cron adds jobs to (worker start). */
export function setFleetInvoiceQueue(queue: Queue | null): void {
  fleetInvoiceQueue = queue;
}

/**
 * Adds the scheduled invoice job of one fleet and month under its
 * deterministic id (P7): a job that exists, or finished within the queue's
 * retention, is not added again.
 */
export async function enqueueFleetInvoice(data: FleetInvoiceJobData): Promise<void> {
  if (fleetInvoiceQueue == null) throw new Error('Fleet invoice queue is not set');
  await fleetInvoiceQueue.add('fleet-invoice', data, {
    jobId: fleetInvoiceJobId(data.fleetId, data.period),
  });
}

/**
 * Runs one job: issues and emails the fleet's invoice for the month
 * (runScheduledFleetInvoice). Nothing to bill completes the job.
 */
export async function processFleetInvoiceJob(
  data: FleetInvoiceJobData,
  logger: ServiceLogger,
): Promise<void> {
  const result = await runScheduledFleetInvoice(
    data.fleetId,
    data.period,
    { templatesDirs: ALL_TEMPLATES_DIRS },
    logger,
  );
  logger.info({ ...data, ...result }, 'Scheduled fleet invoice done');
}

/**
 * True when the failed job landed in the failed state and will not run again.
 * BullMQ (`Job.moveToFailed`) sets `finishedOn` only when it moves the job to
 * failed instead of retrying it: after the last attempt, and for an
 * UnrecoverableError, which is how a job that stalled more than
 * `maxStalledCount` times fails (`failedReason` "job stalled more than
 * allowable limit", with attempts left). Used attempts are checked too.
 */
export function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Handles a failed attempt: once the job failed for good (attempts used up,
 * or stalled past the limit), the failure is recorded for the hourly digest
 * (fleet.InvoiceRunFailed, one notice per month listing the fleets). The
 * failed job keeps its id for the queue's retention and the run skips a
 * recorded month, so the fleet and month are not run again; the operator
 * sends or generates the invoice on the Billing tab.
 */
export async function handleFleetInvoiceJobFailed(
  job: Pick<Job<FleetInvoiceJobData>, 'data' | 'attemptsMade' | 'opts' | 'finishedOn'>,
  err: Error,
  logger: ServiceLogger,
): Promise<void> {
  if (!isFinalFailure(job)) {
    logger.warn({ ...job.data, err, attempt: job.attemptsMade }, 'Fleet invoice attempt failed');
    return;
  }
  logger.error({ ...job.data, err }, 'Scheduled fleet invoice failed');
  await recordFleetInvoiceRunFailure(job.data.fleetId, job.data.period, err.message, logger);
}

/**
 * One job at a time per replica. Invoice numbers follow the fleet order on
 * one replica only (replicas run jobs side by side); the invoice counter
 * keeps the numbers gapless either way.
 */
export function createFleetInvoiceWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker<FleetInvoiceJobData>(
    QUEUE_NAMES.FLEET_INVOICES,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.FLEET_INVOICES);
      const startTime = Date.now();
      try {
        await processFleetInvoiceJob(job.data, log);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr }, 'Could not record the failed fleet invoice job');
        });
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    void handleFleetInvoiceJobFailed(job, err, log);
  });

  return worker;
}
