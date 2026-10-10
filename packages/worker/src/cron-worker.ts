// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { db, cronjobs } from '@evtivity/database';
import { createLogger, withLock } from '@evtivity/lib';
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
import { reservationExpiryCheckHandler } from './handlers/reservation-expiry-check.js';
import { offlineCommandCleanupHandler } from './handlers/offline-command-cleanup.js';
import { certificateExpirationCheckHandler } from './handlers/certificate-expiration-check.js';
import { stationMessageChargingRefreshHandler } from './handlers/station-message-charging-refresh.js';
import { paymentCaptureRetryHandler } from './handlers/payment-capture-retry.js';
import { auditRetentionPruneHandler } from './handlers/audit-retention-prune.js';
import { logRetentionPruneHandler } from './handlers/log-retention-prune.js';
import { mfaChallengePruneHandler } from './handlers/mfa-challenge-prune.js';
import { refreshTokenPruneHandler } from './handlers/refresh-token-prune.js';
import { stationWatchPruneHandler } from './handlers/station-watch-prune.js';
import { maintenanceSchedulerHandler } from './handlers/maintenance-scheduler.js';
import { ocpiLocationSyncHandler } from './handlers/ocpi-location-sync.js';
import { payoutAccountSyncHandler } from './handlers/payout-account-sync.js';
import { processVersionWatchHandler } from './handlers/process-version-watch.js';
import { stationOfflineSweepHandler } from './handlers/station-offline-sweep.js';
import { fleetInvoiceRunHandler } from './handlers/fleet-invoice-run.js';
import { aiRetentionPruneHandler } from './handlers/ai-retention-prune.js';

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
  // Migrated from OCPP server event-projections setIntervals so they actually
  // run under Helm Deployment (where pod names don't end in '-0').
  ['reservation-expiry-check', reservationExpiryCheckHandler],
  ['offline-command-cleanup', offlineCommandCleanupHandler],
  ['certificate-expiration-check', certificateExpirationCheckHandler],
  ['station-message-charging-refresh', stationMessageChargingRefreshHandler],
  ['payment-capture-retry', paymentCaptureRetryHandler],
  ['audit-retention-prune', auditRetentionPruneHandler],
  ['log-retention-prune', logRetentionPruneHandler],
  ['mfa-challenge-prune', mfaChallengePruneHandler],
  ['refresh-token-prune', refreshTokenPruneHandler],
  ['station-watch-prune', stationWatchPruneHandler],
  ['maintenance-scheduler', maintenanceSchedulerHandler],
  ['ocpi-location-sync', ocpiLocationSyncHandler],
  ['payout-account-sync', payoutAccountSyncHandler],
  ['process-version-watch', processVersionWatchHandler],
  ['station-offline-sweep', stationOfflineSweepHandler],
  ['fleet-invoice-run', fleetInvoiceRunHandler],
  ['ai-retention-prune', aiRetentionPruneHandler],
]);

/** Redis key of the lock a cron job holds while it runs (ACL prefix `wkl:`). */
export function cronLockKey(jobName: string): string {
  return `wkl:cron:${jobName}`;
}

/**
 * Creates the cron-jobs Worker.
 *
 * Several worker replicas can run (Helm HPA, CDK autoscaling). A job scheduler
 * creates one job per tick and BullMQ hands each job to one worker, so a tick
 * never runs twice. `concurrency` is per worker instance, so two replicas can
 * run two cron jobs at the same time, and a run that outlasts its interval can
 * meet its next tick on another replica. Each run therefore holds a Redis lock
 * on its job name (try-once): a tick that finds the previous run still holding
 * it is skipped, and the next tick runs normally. Different cron jobs may run
 * at the same time: each is already safe next to the API, OCPP and webhook
 * paths that write the same rows (status guards, idempotency keys, P5 and P7).
 */
export function createCronWorker(connection: ConnectionOptions, lockRedis: Redis): Worker {
  const worker = new Worker(
    QUEUE_NAMES.CRON_JOBS,
    async (job) => {
      const handler = JOB_HANDLERS.get(job.name);
      if (handler == null) {
        throw new Error(`No handler registered for cron job: ${job.name}`);
      }

      const { acquired } = await withLock(
        lockRedis,
        cronLockKey(job.name),
        () => runCronJob(job.name, handler),
        { acquireTimeoutMs: 0 },
      );
      if (!acquired) {
        log.warn({ jobName: job.name }, 'Cron job skipped: its previous run is still in progress');
      }
    },
    {
      connection,
      // Per worker instance: one cron job at a time in this process. Across
      // replicas the per-job lock above prevents a job from overlapping itself.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ jobName: job.name, err }, 'Cron job failed');

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

async function runCronJob(jobName: string, handler: JobHandlerFn): Promise<void> {
  const logId = await logJobStarted(jobName, 'cron-jobs');
  const startTime = Date.now();
  log.info({ jobName }, 'Cron job started');

  await db
    .update(cronjobs)
    .set({ status: 'running', updatedAt: sql`now()` })
    .where(eq(cronjobs.name, jobName));

  try {
    await handler(log);

    const durationMs = Date.now() - startTime;
    log.info({ jobName, durationMs }, 'Cron job completed');

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
      .where(eq(cronjobs.name, jobName));
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await logJobFailed(logId, durationMs, errorMsg).catch(() => {});
    throw err;
  }
}
