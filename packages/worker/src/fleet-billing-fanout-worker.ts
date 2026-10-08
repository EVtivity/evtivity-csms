// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import { client } from '@evtivity/database';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import {
  FLEET_BILLING_FANOUT_CHANNEL,
  fleetBillingFanoutJobId,
  runFleetBillingFanout,
  type FleetBillingFanoutJob,
} from '@evtivity/services/fleet-billing-notice';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('fleet-billing-fanout-worker');

function isFanoutJob(value: unknown): value is FleetBillingFanoutJob {
  if (value == null || typeof value !== 'object') return false;
  const job = value as Partial<FleetBillingFanoutJob>;
  return (
    typeof job.fleetId === 'string' &&
    typeof job.enabled === 'boolean' &&
    typeof job.changedAt === 'string' &&
    !Number.isNaN(Date.parse(job.changedAt))
  );
}

/**
 * Subscribes to the fleet_billing_fanout channel and enqueues one
 * `fleet-billing-fanout` job per fleet switch change. The job id is
 * deterministic per fleet and change (fleetBillingFanoutJobId, P7), so a
 * repeated publish enqueues nothing.
 */
export async function startFleetBillingFanoutBridge(
  pubsub: PubSubClient,
  queue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe(FLEET_BILLING_FANOUT_CHANNEL, (payload: string) => {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      log.warn({ err, payload: payload.slice(0, 200) }, 'Malformed fleet_billing_fanout payload');
      return;
    }
    if (!isFanoutJob(data)) {
      log.warn({ payload: payload.slice(0, 200) }, 'Invalid fleet_billing_fanout payload');
      return;
    }
    void queue
      .add('fleet-billing-fanout', data, { jobId: fleetBillingFanoutJobId(data) })
      .catch((err: unknown) => {
        log.error({ err, fleetId: data.fleetId }, 'Failed to enqueue fleet-billing-fanout job');
      });
  });

  log.info('Fleet billing fan-out bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Fleet billing fan-out bridge stopped');
  };
}

/**
 * Runs a fleet switch fan-out: fleet.AccountBillingChanged to each member
 * whose billing the change moved. Each member is fail-open (logged), so the
 * job fails only when the member list cannot be read.
 */
export function createFleetBillingFanoutWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.FLEET_BILLING_FANOUT,
    async (job) => {
      const logId = await logJobStarted(job.name, QUEUE_NAMES.FLEET_BILLING_FANOUT);
      const startTime = Date.now();
      try {
        const data = job.data as FleetBillingFanoutJob;
        const result = await runFleetBillingFanout(client, data, log);
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
