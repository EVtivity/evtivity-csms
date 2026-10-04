// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Queue } from 'bullmq';
import { db, cronjobs } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';

const log = createLogger('cron-scheduler');

/** Job scheduler id of the load management coordinator (fans out per site). */
export const LOAD_MANAGEMENT_COORDINATOR = 'load-management-coordinator';
export const LOAD_MANAGEMENT_INTERVAL_MS = 10_000;

/**
 * Reads the cronjobs table and registers each job as a BullMQ repeating job.
 * Safe to call on every restart - upsertJobScheduler is idempotent.
 */
export async function scheduleCronJobs(cronQueue: Queue): Promise<void> {
  const jobs = await db.select().from(cronjobs);

  for (const job of jobs) {
    await cronQueue.upsertJobScheduler(job.name, { pattern: job.schedule }, { name: job.name });
    log.info({ jobName: job.name, schedule: job.schedule }, 'Cron job scheduled');
  }

  log.info({ count: jobs.length }, 'All cron jobs scheduled');
}

/** Registers the load management coordinator (every 10 s). Idempotent. */
export async function scheduleLoadManagementCoordinator(loadQueue: Queue): Promise<void> {
  await loadQueue.upsertJobScheduler(
    LOAD_MANAGEMENT_COORDINATOR,
    { every: LOAD_MANAGEMENT_INTERVAL_MS },
    { name: LOAD_MANAGEMENT_COORDINATOR },
  );
}

/**
 * The job schedulers this worker registers that Redis does not hold: one
 * per cronjobs row plus the load management coordinator. Redis keeps
 * schedulers only in memory unless it persists, so a restart or failover
 * without persistence drops them while the worker stays connected.
 */
export async function findMissingSchedulers(cronQueue: Queue, loadQueue: Queue): Promise<string[]> {
  const [jobs, cronSchedulers, loadSchedulers] = await Promise.all([
    db.select({ name: cronjobs.name }).from(cronjobs),
    cronQueue.getJobSchedulers(0, -1),
    loadQueue.getJobSchedulers(0, -1),
  ]);
  const registered = new Set(cronSchedulers.map((scheduler) => scheduler.key));
  const missing = jobs.map((job) => job.name).filter((name) => !registered.has(name));
  if (!loadSchedulers.some((scheduler) => scheduler.key === LOAD_MANAGEMENT_COORDINATOR)) {
    missing.push(LOAD_MANAGEMENT_COORDINATOR);
  }
  return missing;
}
