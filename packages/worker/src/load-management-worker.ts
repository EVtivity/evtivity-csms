// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import {
  client,
  db,
  loadManagementCycleStart,
  markLoadManagementRecomputeRequested,
  recomputeRequestedSince,
  runWithLoadManagementFence,
  siteLoadManagement,
  takeLoadManagementFence,
} from '@evtivity/database';
import { createLogger, withLock } from '@evtivity/lib';
import {
  LOAD_MANAGEMENT_RECOMPUTE_DEBOUNCE_MS,
  LOAD_MANAGEMENT_RECOMPUTE_JOB_NAME,
  LOAD_MANAGEMENT_RECOMPUTE_JOB_OPTIONS,
  loadManagementEventJobId,
  loadManagementFollowUpJobId,
} from '@evtivity/lib/worker-queues';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { runLoadManagementCycle } from '@evtivity/services/load-management.service';

const log = createLogger('load-management-worker');

/** The queue label of a failed allocation log write in worker_job_logs. */
export const LOG_FAILURE_QUEUE = 'load-allocation-log';

/**
 * Reads all sites with active load management and enqueues one job per site.
 * The jobId collapses an add while the site's previous job is still waiting
 * or running. A finished job is removed at once (removeOnComplete and
 * removeOnFail true): BullMQ ignores an add whose id still exists, so a kept
 * finished job would skip the site's next ticks until the queue evicts it.
 * Called every 10 seconds by the BullMQ repeating coordinator job.
 */
export async function enqueueLoadManagementJobs(loadQueue: Queue): Promise<void> {
  const sites = await db
    .select({ siteId: siteLoadManagement.siteId })
    .from(siteLoadManagement)
    .where(eq(siteLoadManagement.isEnabled, true));

  // Per-site enqueue calls are independent — Promise.all bounds the
  // coordinator's wall time by Redis round-trip latency, not by it.
  await Promise.all(
    sites.map((site) =>
      loadQueue.add(
        'load-management',
        { siteId: site.siteId },
        {
          jobId: `load-management-${site.siteId}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    ),
  );
}

/** The lock that keeps two cycles of one site from running at once, across workers. */
export function loadManagementLockKey(siteId: string): string {
  return `wkl:load-management:${siteId}`;
}

/**
 * The site lock lease. The lock is renewed every third of it while a cycle
 * runs, so a worker that dies mid-cycle holds the site at most this long
 * before the next tick takes over.
 */
export const LOAD_MANAGEMENT_LOCK_TTL_MS = 15_000;

/**
 * Load management jobs run at once per worker. A cycle mostly waits on
 * station replies (up to 5 s for the cuts of a send), not on the CPU, so a
 * worker runs many sites side by side; a busy site never holds a slot.
 */
export const LOAD_MANAGEMENT_WORKER_CONCURRENCY = 20;

/**
 * Runs one site's cycle under the site lock. A run that finds the site busy,
 * a periodic tick or a recompute, waits for nothing and queues nothing: it
 * marks the site's `recompute_requested_at` and frees its slot. The running
 * cycle reads the mark when it ends (`recompute_requested_at` at or after its
 * start) and queues one recompute with the other job id (BullMQ ignores an add
 * whose id is active, so the running job's own id would swallow it), so
 * however many runs find the site busy, one follow-up runs after it. A mark
 * that lands after the holder's read waits for the next tick (10 s); a holder
 * that died hands the site to the next tick once its lease ends.
 */
export async function runSiteCycle(
  siteId: string,
  job: { name: string; id?: string | undefined },
  deps: {
    lockRedis: Redis;
    loadQueue: Pick<Queue, 'add'>;
    cycle: (siteId: string) => Promise<{ failedSites: number; logFailures: number }>;
    lockTtlMs?: number;
  },
): Promise<{ ran: boolean; failedSites: number; logFailures: number }> {
  const ttlMs = deps.lockTtlMs ?? LOAD_MANAGEMENT_LOCK_TTL_MS;
  const queueFollowUp = async (trigger: string, delay: number): Promise<void> => {
    const nextId =
      job.id === loadManagementEventJobId(siteId)
        ? loadManagementFollowUpJobId(siteId)
        : loadManagementEventJobId(siteId);
    await deps.loadQueue.add(
      LOAD_MANAGEMENT_RECOMPUTE_JOB_NAME,
      { siteId, trigger },
      { ...LOAD_MANAGEMENT_RECOMPUTE_JOB_OPTIONS, jobId: nextId, delay },
    );
  };
  const locked = await withLock(
    deps.lockRedis,
    loadManagementLockKey(siteId),
    async (signal) => {
      const startedAt = await loadManagementCycleStart(client);
      // Fenced: if this lease is lost and another worker takes the site, the
      // claims and sends of this cycle find a newer fence and do nothing.
      const fence = await takeLoadManagementFence(client, siteId);
      const result =
        fence == null
          ? await deps.cycle(siteId)
          : await runWithLoadManagementFence({ siteId, fence, signal }, () => deps.cycle(siteId));
      return { ...result, startedAt };
    },
    { ttlMs, acquireTimeoutMs: 0 },
  );
  if (!locked.acquired || locked.result == null) {
    await markLoadManagementRecomputeRequested(client, siteId);
    return { ran: false, failedSites: 0, logFailures: 0 };
  }
  const { startedAt, failedSites, logFailures } = locked.result;
  if (await recomputeRequestedSince(client, siteId, startedAt)) {
    await queueFollowUp('follow_up', LOAD_MANAGEMENT_RECOMPUTE_DEBOUNCE_MS);
  }
  return { ran: true, failedSites, logFailures };
}

/**
 * Creates the BullMQ Worker that processes load management jobs.
 * Handles two job types:
 * - 'load-management-coordinator': fans out per-site jobs via enqueueLoadManagementJobs
 * - 'load-management': processes a single site
 *
 * `allowSimulatedEnergyAssets` is the worker's ENERGY_ASSETS_ALLOW_SIMULATED
 * (owner decision D13): only then does the cycle compute simulated battery
 * and solar readings.
 */
export function createLoadManagementWorker(
  connection: ConnectionOptions,
  loadQueue: Queue,
  options: {
    allowSimulatedEnergyAssets?: boolean;
    lockRedis: Redis;
    /** The site cycle; `runLoadManagementCycle` unless given. */
    cycle?: (siteId: string) => Promise<{ failedSites: number; logFailures: number }>;
  },
): Worker {
  const cycleOptions = { allowSimulatedEnergyAssets: options.allowSimulatedEnergyAssets === true };
  const cycle = options.cycle ?? ((id: string) => runLoadManagementCycle(log, id, cycleOptions));
  const worker = new Worker(
    QUEUE_NAMES.LOAD_MANAGEMENT,
    async (job) => {
      if (job.name === 'load-management-coordinator') {
        await enqueueLoadManagementJobs(loadQueue);
        return;
      }
      const { siteId } = job.data as { siteId: string };
      const logId = await logJobStarted(`load-management:${siteId}`, 'load-management');
      const startTime = Date.now();
      try {
        log.info({ siteId, job: job.name }, 'Processing load management for site');
        const { ran, failedSites, logFailures } = await runSiteCycle(siteId, job, {
          lockRedis: options.lockRedis,
          loadQueue,
          cycle,
        });
        // The cycle logs a site failure and goes on; the job row records it as
        // failed, so worker_jobs_last_hour counts it (the job is not retried).
        if (failedSites > 0) {
          await logJobFailed(logId, Date.now() - startTime, 'Load management cycle failed');
        } else {
          await logJobCompleted(logId, Date.now() - startTime);
        }
        if (!ran)
          log.debug({ siteId }, 'Load management cycle of the site is running, queued again');
        // A failed allocation log write is its own failed row, so the log
        // failure gauge and its alert count it while the limits went out.
        if (logFailures > 0) {
          const failId = await logJobStarted(`load-allocation-log:${siteId}`, LOG_FAILURE_QUEUE);
          await logJobFailed(failId, 0, 'Load allocation log write failed');
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    {
      connection,
      concurrency: LOAD_MANAGEMENT_WORKER_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    const { siteId } = job.data as { siteId: string };
    log.error({ err, siteId }, 'Load management job failed');
  });

  return worker;
}
