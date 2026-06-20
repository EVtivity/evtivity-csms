// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger, withLock } from '@evtivity/lib';
import {
  runMaintenanceFanout,
  MAINTENANCE_FANOUT_CHANNEL,
  type MaintenanceFanoutJob,
} from '@evtivity/api/src/services/maintenance.service.js';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('maintenance-fanout-worker');

// Stable job id so duplicate publishes for the same logical fan-out dedup. For
// add/remove the station set is part of the identity, so two distinct add
// requests on the same event still enqueue separately while an exact-duplicate
// publish collapses to one job. Reassert publishes carry a nonce because each
// reconnect is a new logical fan-out: without it, a station that flaps twice
// would have its second re-assert collapsed into the already-completed first.
// Segments join with '.' because BullMQ rejects custom job ids containing ':'
// (it only tolerates exactly-3-segment ids for legacy repeatable-job compat,
// which silently broke every add/remove enqueue when ':' was the separator).
function fanoutJobId(job: MaintenanceFanoutJob): string {
  let id = `mf.${job.eventId}.${job.phase}`;
  if (job.stationDbIds != null && job.stationDbIds.length > 0) {
    id += `.${[...job.stationDbIds].sort().join(',')}`;
  }
  if (job.nonce != null) {
    id += `.${job.nonce}`;
  }
  return id;
}

/**
 * Subscribes to the maintenance_fanout pub/sub channel and enqueues a BullMQ job
 * that runs the per-station OCPP fan-out in the worker process, surviving API
 * restarts.
 */
export async function startMaintenanceFanoutBridge(
  pubsub: PubSubClient,
  maintenanceFanoutQueue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(MAINTENANCE_FANOUT_CHANNEL, (payload: string) => {
    let data: MaintenanceFanoutJob;
    try {
      data = JSON.parse(payload) as MaintenanceFanoutJob;
    } catch (err) {
      log.warn({ err, payload: payload.slice(0, 200) }, 'Malformed maintenance_fanout payload');
      return;
    }

    void maintenanceFanoutQueue
      .add('maintenance-fanout', data, { jobId: fanoutJobId(data) })
      .catch((err: unknown) => {
        log.error(
          { err, eventId: data.eventId, phase: data.phase },
          'Failed to enqueue maintenance-fanout job',
        );
      });
  });

  log.info('Maintenance fan-out bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Maintenance fan-out bridge stopped');
  };
}

/**
 * Creates the BullMQ Worker that runs the detached maintenance station fan-out.
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
