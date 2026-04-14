// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db, cronjobs } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import type { Logger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { reportSchedulerHandler } from './handlers/report-scheduler.js';
import { tariffBoundaryCheckHandler } from './handlers/tariff-boundary-check.js';
import { paymentReconciliationHandler } from './handlers/payment-reconciliation.js';
import { guestSessionCleanupHandler } from './handlers/guest-session-cleanup.js';
import { chargingProfileReconciliationHandler } from './handlers/charging-profile-reconciliation.js';
import { configDriftDetectionHandler } from './handlers/config-drift-detection.js';
import { staleSessionCleanupHandler } from './handlers/stale-session-cleanup.js';
import { dashboardSnapshotHandler } from './handlers/dashboard-snapshot.js';

const log = createLogger('cron-worker');

type JobHandlerFn = (log: Logger) => Promise<void>;

const JOB_HANDLERS = new Map<string, JobHandlerFn>([
  ['report-scheduler', reportSchedulerHandler],
  ['tariff-boundary-check', tariffBoundaryCheckHandler],
  ['payment-reconciliation', paymentReconciliationHandler],
  ['guest-session-cleanup', guestSessionCleanupHandler],
  ['charging-profile-reconciliation', chargingProfileReconciliationHandler],
  ['config-drift-detection', configDriftDetectionHandler],
  ['stale-session-cleanup', staleSessionCleanupHandler],
  ['dashboard-snapshot', dashboardSnapshotHandler],
]);

export function createCronWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.CRON_JOBS,
    async (job) => {
      const handler = JOB_HANDLERS.get(job.name);
      if (handler == null) {
        throw new Error(`No handler registered for cron job: ${job.name}`);
      }

      const logId = await logJobStarted(job.name, 'cron-jobs');
      const startTime = Date.now();
      log.info({ jobName: job.name }, 'Cron job started');

      await db
        .update(cronjobs)
        .set({ status: 'running', updatedAt: sql`now()` })
        .where(eq(cronjobs.name, job.name));

      try {
        await handler(log);

        const durationMs = Date.now() - startTime;
        log.info({ jobName: job.name, durationMs }, 'Cron job completed');

        await logJobCompleted(logId, durationMs);

        await db
          .update(cronjobs)
          .set({
            status: 'completed',
            lastRunAt: new Date(),
            durationMs,
            result: { success: true },
            error: null,
            updatedAt: sql`now()`,
          })
          .where(eq(cronjobs.name, job.name));
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, durationMs, errorMsg).catch(() => {});
        throw err;
      }
    },
    {
      connection,
      // concurrency: 1 means only one cron job runs at a time across all worker replicas.
      // This prevents e.g. payment-reconciliation from running twice simultaneously.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ jobName: job.name, error: err }, 'Cron job failed');

    db.update(cronjobs)
      .set({
        status: 'failed',
        lastRunAt: new Date(),
        error: errorMsg.slice(0, 1000),
        updatedAt: sql`now()`,
      })
      .where(eq(cronjobs.name, job.name))
      .catch(() => {});
  });

  return worker;
}
