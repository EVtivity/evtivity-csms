// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, siteLoadManagement } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';
import { runLoadManagementCycle } from '@evtivity/api/src/services/load-management.service.js';

const log = createLogger('load-management-worker');

/**
 * Reads all sites with active load management and enqueues one job per site.
 * jobId deduplication prevents duplicate jobs for the same site.
 * Called every 10 seconds by the BullMQ repeating coordinator job.
 */
export async function enqueueLoadManagementJobs(loadQueue: Queue): Promise<void> {
  const sites = await db
    .select({ siteId: siteLoadManagement.siteId })
    .from(siteLoadManagement)
    .where(eq(siteLoadManagement.isEnabled, true));

  for (const site of sites) {
    await loadQueue.add(
      'load-management',
      { siteId: site.siteId },
      {
        jobId: `load-management-${site.siteId}`,
        attempts: 1,
      },
    );
  }
}

/**
 * Creates the BullMQ Worker that processes load management jobs.
 * Handles two job types:
 * - 'load-management-coordinator': fans out per-site jobs via enqueueLoadManagementJobs
 * - 'load-management': processes a single site
 */
export function createLoadManagementWorker(
  connection: ConnectionOptions,
  loadQueue: Queue,
): Worker {
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
        log.info({ siteId }, 'Processing load management for site');
        await runLoadManagementCycle(log, siteId);
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    const { siteId } = job.data as { siteId: string };
    log.error({ err, siteId }, 'Load management job failed');
  });

  return worker;
}
