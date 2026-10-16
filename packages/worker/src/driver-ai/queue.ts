// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `driver-ai` queue (plan v0.1.45, decision E2): one `analyze` job per
 * case, job id `dai.<caseId>` (P7: a duplicate request or a sweeper re-queue
 * of a job that still exists is a no-op). The API publishes `{ caseId }` on
 * `driver_ai_requests` (its Redis user has no BullMQ grant) and the bridge
 * below adds the job; the `driver-ai-sweep` cron adds it again for a case
 * whose request was lost.
 *
 * Concurrency 2 per replica; 3 attempts with exponential backoff from 30 s.
 * After the last attempt the case goes to operators as failed/provider_error.
 */

import { Worker, type ConnectionOptions, type Job, type Queue } from 'bullmq';
import { createLogger, type Logger, type PubSubClient } from '@evtivity/lib';
import { checkAiBudgets, getAiSettings, getSystemTimezone } from '@evtivity/database';
import {
  DRIVER_AI_ANALYZE_JOB,
  DRIVER_AI_QUEUE,
  DRIVER_AI_REQUESTS_CHANNEL,
  driverAiJobId,
  driverAiRequestSchema,
} from '@evtivity/lib/driver-ai';
import type { DriverAiRequest } from '@evtivity/lib/driver-ai';
import { createDriverAiAdapter, resolveDriverAiConfig } from '@evtivity/services/driver-ai-config';
import { aiProviderGate } from '@evtivity/services/ai-alerts';
import { logJobStarted, logJobCompleted, logJobFailed } from '../job-logger.js';
import { config } from '../lib/config.js';
import { analyzeDriverAiCase, failDriverAiCase } from './analyze.js';
import type { DriverAiJobDeps } from './analyze.js';

const log = createLogger('driver-ai-worker');

export const DRIVER_AI_WORKER_CONCURRENCY = 2;

let driverAiQueue: Queue | null = null;

/** The queue the enqueue helper adds to; set once at worker startup (null on shutdown). */
export function setDriverAiQueue(queue: Queue | null): void {
  driverAiQueue = queue;
}

/** Adds the analysis of a case under its deterministic id: a job that still exists is kept. */
export async function enqueueDriverAiJob(caseId: string): Promise<void> {
  if (driverAiQueue == null) throw new Error('Driver AI queue is not set');
  const data: DriverAiRequest = { caseId };
  await driverAiQueue.add(DRIVER_AI_ANALYZE_JOB, data, { jobId: driverAiJobId(caseId) });
}

/**
 * The sweeper's enqueue. BullMQ ignores an add while a finished job with the
 * same id is retained (`removeOnComplete`/`removeOnFail`), which would leave
 * a case queued for good after a stalled rerun that completed as a no-op, a
 * throw after the claim, or a failed final handler. A completed or failed
 * job of the case is removed first; a waiting, delayed or active job is kept,
 * so the case still gets one analysis at a time.
 */
export async function requeueDriverAiJob(caseId: string): Promise<void> {
  if (driverAiQueue == null) throw new Error('Driver AI queue is not set');
  const existing = await driverAiQueue.getJob(driverAiJobId(caseId));
  if (existing != null) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') await existing.remove();
  }
  await enqueueDriverAiJob(caseId);
}

/** Subscribes to `driver_ai_requests` and queues each case. A malformed message is dropped. */
export async function startDriverAiBridge(pubsub: PubSubClient): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(DRIVER_AI_REQUESTS_CHANNEL, (payload: string) => {
    let message: DriverAiRequest;
    try {
      message = driverAiRequestSchema.parse(JSON.parse(payload));
    } catch (err) {
      log.warn({ err }, 'Malformed driver AI request dropped');
      return;
    }
    enqueueDriverAiJob(message.caseId).catch((err: unknown) => {
      log.error({ err, caseId: message.caseId }, 'Failed to queue a driver AI job');
    });
  });
  log.info('Driver AI bridge started');
  return async () => {
    await subscription.unsubscribe();
    log.info('Driver AI bridge stopped');
  };
}

export function defaultDriverAiJobDeps(): DriverAiJobDeps {
  const nodeEnv = process.env['NODE_ENV'];
  return {
    getSettings: getAiSettings,
    resolveConfig: (settings) =>
      resolveDriverAiConfig(settings, config.SETTINGS_ENCRYPTION_KEY, nodeEnv === 'development'),
    createAdapter: createDriverAiAdapter,
    checkBudgets: checkAiBudgets,
    providerGate: aiProviderGate,
    systemTimezone: getSystemTimezone,
    now: () => new Date(),
  };
}

/** Attempts used up, or stalled past the limit (BullMQ sets `finishedOn` either way). */
function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** After the last attempt the case goes to operators; earlier attempts are only logged. */
export async function handleDriverAiJobFailed(
  job: Pick<Job<DriverAiRequest>, 'data' | 'attemptsMade' | 'opts' | 'finishedOn'>,
  err: Error,
  logger: Logger = log,
): Promise<void> {
  if (!isFinalFailure(job)) {
    logger.warn(
      { caseId: job.data.caseId, err, attempt: job.attemptsMade },
      'Driver AI attempt failed',
    );
    return;
  }
  logger.error({ caseId: job.data.caseId, err }, 'Driver AI job failed');
  await failDriverAiCase(job.data.caseId, logger);
}

export function createDriverAiWorker(
  connection: ConnectionOptions,
  deps: DriverAiJobDeps = defaultDriverAiJobDeps(),
): Worker<DriverAiRequest> {
  const worker = new Worker<DriverAiRequest>(
    DRIVER_AI_QUEUE,
    async (job) => {
      const logId = await logJobStarted(job.name, DRIVER_AI_QUEUE);
      const startTime = Date.now();
      try {
        const outcome = await analyzeDriverAiCase(
          job.data.caseId,
          deps,
          log.child({ jobId: job.id }),
        );
        await logJobCompleted(logId, Date.now() - startTime);
        return outcome;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr, jobId: job.id }, 'Failed to record driver AI job failure');
        });
        throw err;
      }
    },
    { connection, concurrency: DRIVER_AI_WORKER_CONCURRENCY },
  );
  worker.on('failed', (job, err) => {
    if (job == null) return;
    handleDriverAiJobFailed(job, err).catch((handlerErr: unknown) => {
      log.error({ err: handlerErr, jobId: job.id }, 'Driver AI failure handling failed');
    });
  });
  return worker;
}
