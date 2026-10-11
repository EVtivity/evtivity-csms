// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `ai-workers` queue: one job per background AI worker job, scope (a site,
 * `unsited` or `company`) and period, added by the worker crons under a
 * deterministic job id (P7). The worker runs them one at a time per process,
 * each under the lock `wkl:ai-worker:<job>:<scope>`, and the run's
 * `ai_worker_runs` claim keeps two replicas from running the same period
 * twice (TC-AI-WK-15).
 */

import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createLogger, withLock } from '@evtivity/lib';
import { getAiInsightSettings } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { storeWorkerInsight } from '@evtivity/services/ai-insight.service';
import { QUEUE_NAMES } from './queues.js';
import { config } from './lib/config.js';
import { AI_WORKER_RUNNERS } from './ai-workers/jobs.js';
import type { AiWorkerDeps, AiWorkerJobData } from './ai-workers/jobs.js';

const log = createLogger('ai-worker');

let aiWorkerQueue: Queue | null = null;

/** Binds the queue the AI worker crons add runs to (worker start). */
export function setAiWorkerQueue(queue: Queue | null): void {
  aiWorkerQueue = queue;
}

export function aiWorkerJobId(data: Pick<AiWorkerJobData, 'job' | 'scope' | 'period'>): string {
  return `aiw.${data.job}.${data.scope}.${data.period.replace(/:/g, '-')}`;
}

/** Redis key of the lock a run holds (ACL prefix `wkl:`). */
export function aiWorkerLockKey(data: Pick<AiWorkerJobData, 'job' | 'scope'>): string {
  return `wkl:ai-worker:${data.job}:${data.scope}`;
}

/** Adds one run; an id that exists or finished within the retention is not added again. */
export async function enqueueAiWorkerRun(data: AiWorkerJobData): Promise<void> {
  if (aiWorkerQueue == null) throw new Error('AI worker queue is not set');
  await aiWorkerQueue.add(data.job, data, { jobId: aiWorkerJobId(data) });
}

/** The production dependencies of a run: the company key and the base URL rule. */
export function aiWorkerDeps(): AiWorkerDeps {
  return {
    encryptionKey: config.SETTINGS_ENCRYPTION_KEY,
    allowPrivateHosts: (process.env['NODE_ENV'] ?? 'development') === 'development',
    // Worker output becomes an insight through the insight service (lane R2).
    writeInsight: async (input) =>
      storeWorkerInsight(
        {
          kind: input.kind,
          siteId: input.siteId,
          triggerKey: input.triggerKey,
          narrative: input.narrative,
          primaryLanguage: (await getAiInsightSettings()).primaryLanguage,
        },
        getPubSub(),
      ),
  };
}

export function createAiWorker(connection: ConnectionOptions, lockRedis: Redis): Worker {
  return new Worker<AiWorkerJobData>(
    QUEUE_NAMES.AI_WORKERS,
    async (job) => {
      const data = job.data;
      const runner = AI_WORKER_RUNNERS[data.job];
      const jobLog = log.child({ job: data.job, scope: data.scope, period: data.period });
      const { acquired } = await withLock(
        lockRedis,
        aiWorkerLockKey(data),
        () => runner(data, aiWorkerDeps(), jobLog),
        { acquireTimeoutMs: 0 },
      );
      if (!acquired) jobLog.warn('AI worker run skipped: the previous run still holds the lock');
    },
    { connection, concurrency: 1 },
  );
}
