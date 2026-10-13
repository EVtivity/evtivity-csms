// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Job, type Queue, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { MEMBER_INVOICE_JOB_NAME } from '@evtivity/services/account-invoice-jobs';
import {
  memberInvoiceJobId,
  recordMemberInvoiceRunFailure,
  runMemberInvoiceJob,
  type MemberInvoiceJob,
} from '@evtivity/services/fleet-invoice-run';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { isFinalFailure } from './fleet-invoice-worker.js';

const log = createLogger('member-invoice-worker');

let memberInvoiceQueue: Queue | null = null;

/**
 * Binds the queue the cron adds jobs to (worker start). The API adds the
 * "Invoice All Members" jobs to the same queue itself (enqueueMemberInvoiceBatch).
 */
export function setMemberInvoiceQueue(queue: Queue | null): void {
  memberInvoiceQueue = queue;
}

/**
 * Adds one member invoice job under its deterministic id (P7): a job that
 * exists, or finished within the queue's retention, is not added again.
 */
export async function enqueueMemberInvoice(data: MemberInvoiceJob): Promise<void> {
  if (memberInvoiceQueue == null) throw new Error('Member invoice queue is not set');
  await memberInvoiceQueue.add(MEMBER_INVOICE_JOB_NAME, data, {
    jobId: memberInvoiceJobId(data.fleetId, data.driverId, data.period, data.batchId),
  });
}

/** Runs one job: issues and emails one driver's member invoice for the month. */
export async function processMemberInvoiceJob(
  data: MemberInvoiceJob,
  logger: ServiceLogger,
): Promise<void> {
  const result = await runMemberInvoiceJob(data, { templatesDirs: ALL_TEMPLATES_DIRS }, logger);
  logger.info(
    { fleetId: data.fleetId, driverId: data.driverId, period: data.period, ...result },
    'Member invoice done',
  );
}

/**
 * Handles a failed attempt: once the job failed for good, the failure is
 * recorded for the hourly digest (fleet.InvoiceRunFailed lists the fleet and
 * the driver). The run skips a recorded month; the operator generates or
 * sends the invoice on the fleet's Billing tab.
 */
export async function handleMemberInvoiceJobFailed(
  job: Pick<Job<MemberInvoiceJob>, 'data' | 'attemptsMade' | 'opts' | 'finishedOn'>,
  err: Error,
  logger: ServiceLogger,
): Promise<void> {
  const { fleetId, driverId, period } = job.data;
  if (!isFinalFailure(job)) {
    logger.warn(
      { fleetId, driverId, period, err, attempt: job.attemptsMade },
      'Member invoice attempt failed',
    );
    return;
  }
  logger.error({ fleetId, driverId, period, err }, 'Member invoice failed');
  await recordMemberInvoiceRunFailure(fleetId, driverId, period, err.message, logger);
}

/**
 * One job at a time per replica, like the fleet invoices: invoice numbers
 * follow the job order on one replica; the invoice counter keeps them gapless.
 */
export function createMemberInvoiceWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker<MemberInvoiceJob>(
    QUEUE_NAMES.MEMBER_INVOICES,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.MEMBER_INVOICES);
      const startTime = Date.now();
      try {
        await processMemberInvoiceJob(job.data, log);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr }, 'Could not record the failed member invoice job');
        });
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    void handleMemberInvoiceJobFailed(job, err, log);
  });

  return worker;
}
