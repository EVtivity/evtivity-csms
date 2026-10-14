// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createLogger, withLock } from '@evtivity/lib';
import {
  runMaintenanceFanout,
  type MaintenanceFanoutJob,
} from '@evtivity/services/maintenance.service';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('maintenance-fanout-worker');

/**
 * Creates the BullMQ Worker that runs the detached maintenance station fan-out.
 * The API, the worker cron and the OCPP server add the jobs themselves
 * (enqueueMaintenanceFanout), so a fan-out waits while no worker runs.
 */
export function createMaintenanceFanoutWorker(
  connection: ConnectionOptions,
  lockRedis?: Redis,
): Worker {
  const worker = new Worker(
    QUEUE_NAMES.MAINTENANCE_FANOUT,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.MAINTENANCE_FANOUT);
      const startTime = Date.now();
      try {
        const data = job.data as MaintenanceFanoutJob;
        const run = () => runMaintenanceFanout(data, log);
        // Per-site lock so fan-outs for the same site serialize across worker
        // replicas: a cancel's release job on pod A and a new event's enter job
        // on pod B must not interleave Operative/Inoperative on the same fleet.
        if (lockRedis != null) {
          await withLock(lockRedis, `mfl:${data.siteId ?? data.eventId}`, run);
        } else {
          await run();
        }
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    // concurrency 1 serializes fan-outs in enqueue order within this process;
    // the per-site lock above extends the guarantee across replicas.
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Maintenance fan-out job failed');
  });

  return worker;
}
