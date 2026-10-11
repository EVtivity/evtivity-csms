// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `ai-insights` queue (roadmap v0.1.44, item 1): `generate` jobs (job id
 * = the insight id, delayed by the debounce when the scan created the
 * insight) and `translate` jobs (job id `ins-tr.<insightId>.<language>`; a
 * BullMQ job id cannot hold a colon). The scan adds generations directly;
 * the API publishes regenerations and translations on
 * `ai_insight_requests` and the bridge below adds them, so the same publish
 * received by every replica makes one job (P7).
 *
 * Concurrency 2 per replica; 3 attempts with exponential backoff from 30 s.
 * After the last attempt a generation ends `failed` and a translation
 * `unavailable` (no `active` row from a failed job).
 */

import { Worker, type ConnectionOptions, type Job, type Queue } from 'bullmq';
import { z } from 'zod';
import { createLogger, type PubSubClient } from '@evtivity/lib';
import type { Logger } from '@evtivity/lib';
import { checkAiBudgets, getInsightAiSettings } from '@evtivity/database';
import {
  AI_INSIGHT_REQUESTS_CHANNEL,
  failInsight,
  getInsightRow,
  publishInsightUpdated,
  storeInsightTranslation,
} from '@evtivity/services/ai-insight.service';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { config } from './lib/config.js';
import { generateInsight } from './ai-insights/generate.js';
import type { InsightJobDeps } from './ai-insights/generate.js';
import { translateInsight } from './ai-insights/translate.js';
import { createOpsAdapter, resolveOpsAiConfig } from '@evtivity/services/ai-ops-config';

const log = createLogger('ai-insight-worker');

export const AI_INSIGHT_WORKER_CONCURRENCY = 2;

export type AiInsightJobData =
  | { kind: 'generate'; insightId: string }
  | { kind: 'translate'; insightId: string; language: string };

const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generate'), insightId: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('translate'),
    insightId: z.string().min(1).max(64),
    language: z.enum(['en', 'de', 'es', 'ko', 'zh', 'zh-TW']),
  }),
]);

/** Attempts used up, or stalled past the limit (BullMQ sets `finishedOn` either way). */
function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

export function insightJobId(data: AiInsightJobData): string {
  return data.kind === 'generate' ? data.insightId : `ins-tr.${data.insightId}.${data.language}`;
}

let insightQueue: Queue | null = null;

/** The queue the enqueue helpers add to; set once at worker startup (null on shutdown). */
export function setAiInsightQueue(queue: Queue | null): void {
  insightQueue = queue;
}

/** Adds a job under its deterministic id: a job that still exists is kept (P7). */
export async function enqueueAiInsightJob(data: AiInsightJobData, delayMs = 0): Promise<void> {
  if (insightQueue == null) throw new Error('AI insight queue is not set');
  await insightQueue.add(data.kind, data, {
    jobId: insightJobId(data),
    ...(delayMs > 0 ? { delay: delayMs } : {}),
  });
}

/**
 * Subscribes to `ai_insight_requests` (regenerations and translations the
 * API asked for) and queues them. A malformed message is dropped.
 */
export async function startAiInsightBridge(pubsub: PubSubClient): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(AI_INSIGHT_REQUESTS_CHANNEL, (payload: string) => {
    let message: AiInsightJobData;
    try {
      message = requestSchema.parse(JSON.parse(payload));
    } catch (err) {
      log.warn({ err }, 'Malformed AI insight request dropped');
      return;
    }
    enqueueAiInsightJob(message).catch((err: unknown) => {
      log.error({ err, insightId: message.insightId }, 'Failed to queue an AI insight job');
    });
  });
  log.info('AI insight bridge started');
  return async () => {
    await subscription.unsubscribe();
    log.info('AI insight bridge stopped');
  };
}

export function defaultInsightJobDeps(pubsub: PubSubClient): InsightJobDeps {
  const nodeEnv = process.env['NODE_ENV'];
  return {
    // Reservation insights only while reservations are on (getInsightAiSettings).
    getSettings: getInsightAiSettings,
    resolveConfig: (settings) =>
      resolveOpsAiConfig(settings, config.SETTINGS_ENCRYPTION_KEY, nodeEnv === 'development'),
    createAdapter: createOpsAdapter,
    checkBudgets: checkAiBudgets,
    pubsub,
    now: () => new Date(),
    subjectSecret: config.SETTINGS_ENCRYPTION_KEY,
  };
}

export async function runAiInsightJob(
  data: AiInsightJobData,
  deps: InsightJobDeps,
  logger: Logger,
): Promise<string> {
  return data.kind === 'generate'
    ? generateInsight(data.insightId, deps, logger)
    : translateInsight(data.insightId, data.language, deps, logger);
}

/**
 * After the last attempt: a generation ends `failed`, a translation
 * `unavailable`. Earlier attempts are only logged (the job retries).
 */
export async function handleAiInsightJobFailed(
  job: Pick<Job<AiInsightJobData>, 'data' | 'attemptsMade' | 'opts' | 'finishedOn'>,
  err: Error,
  pubsub: PubSubClient,
  logger: Logger = log,
): Promise<void> {
  if (!isFinalFailure(job)) {
    logger.warn({ ...job.data, err, attempt: job.attemptsMade }, 'AI insight job attempt failed');
    return;
  }
  logger.error({ ...job.data, err }, 'AI insight job failed');
  const row = await getInsightRow(job.data.insightId);
  if (row == null) return;
  const changed =
    job.data.kind === 'generate'
      ? await failInsight(row.id)
      : await storeInsightTranslation(row.id, job.data.language, null);
  if (changed) await publishInsightUpdated(pubsub, row);
}

export function createAiInsightWorker(
  connection: ConnectionOptions,
  pubsub: PubSubClient,
  deps: InsightJobDeps = defaultInsightJobDeps(pubsub),
): Worker<AiInsightJobData> {
  const worker = new Worker<AiInsightJobData>(
    QUEUE_NAMES.AI_INSIGHTS,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.AI_INSIGHTS);
      const startTime = Date.now();
      try {
        const outcome = await runAiInsightJob(job.data, deps, log.child({ jobId: job.id }));
        await logJobCompleted(logId, Date.now() - startTime);
        return outcome;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch((logErr: unknown) => {
          log.warn({ err: logErr, jobId: job.id }, 'Failed to record AI insight job failure');
        });
        throw err;
      }
    },
    { connection, concurrency: AI_INSIGHT_WORKER_CONCURRENCY },
  );
  worker.on('failed', (job, err) => {
    if (job == null) return;
    handleAiInsightJobFailed(job, err, pubsub).catch((handlerErr: unknown) => {
      log.error({ err: handlerErr, jobId: job.id }, 'AI insight failure handling failed');
    });
  });
  return worker;
}
