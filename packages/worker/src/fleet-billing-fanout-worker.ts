// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { client } from '@evtivity/database';
import { createLogger, withLock } from '@evtivity/lib';
import {
  runFleetBillingFanout,
  type FleetBillingFanoutJob,
} from '@evtivity/services/fleet-billing-notice';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('fleet-billing-fanout-worker');

/** Redis key of the per-fleet fan-out lock (ACL prefix `wkl:`). */
export function fleetBillingFanoutLockKey(fleetId: string): string {
  return `wkl:fleet-billing:${fleetId}`;
}

/**
 * Runs a fleet switch fan-out: fleet.AccountBillingChanged to each member
 * whose billing the change moved. The API adds the jobs itself
 * (enqueueFleetBillingFanout), so a change waits while no worker runs. Each
 * member is fail-open (logged), so the
 * job fails only when the member list cannot be read.
 *
 * `concurrency` is per worker instance. A per-fleet Redis lock serializes the
 * fan-outs of one fleet across worker replicas, so an on and a quick off
 * reach the members in order. Different fleets run in parallel.
 */
export function createFleetBillingFanoutWorker(
  connection: ConnectionOptions,
  lockRedis: Redis,
): Worker {
  const worker = new Worker(
    QUEUE_NAMES.FLEET_BILLING_FANOUT,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.FLEET_BILLING_FANOUT);
      const startTime = Date.now();
      try {
        const data = job.data as FleetBillingFanoutJob;
        const { result } = await withLock(lockRedis, fleetBillingFanoutLockKey(data.fleetId), () =>
          runFleetBillingFanout(client, data, log),
        );
        log.info({ fleetId: data.fleetId, ...result }, 'Fleet billing fan-out done');
        await logJobCompleted(logId, Date.now() - startTime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Fleet billing fan-out job failed');
  });

  return worker;
}
