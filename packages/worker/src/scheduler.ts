// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Queue } from 'bullmq';
import { db, cronjobs } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';

const log = createLogger('cron-scheduler');

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
