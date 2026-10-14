// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createLogger, withLock } from '@evtivity/lib';
import {
  pushAllMessagesToAllStations,
  runStationRefresh,
  runStationRender,
  runStationTransaction,
  STATION_MESSAGE_JOBS,
  type StationMessageRepushJob,
  type StationRefreshJob,
  type StationRenderRunner,
  type StationTransactionJob,
} from '@evtivity/services/station-message.service';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('station-message-worker');

/**
 * Renders of one station run one at a time across worker replicas (Redis
 * lock) and within this process (runStationRender), so two jobs for the same
 * station cannot both read the old content hash and send the same screen.
 */
export function stationRenderRunner(lockRedis: Redis): StationRenderRunner {
  return async (internalStationId, render) => {
    await withLock(
      lockRedis,
      `sml:${internalStationId}`,
      () => runStationRender(internalStationId, render),
      { ttlMs: 30_000, retryMs: 100, acquireTimeoutMs: 60_000 },
    );
  };
}

async function runRepushJob(
  name: string,
  data: StationMessageRepushJob,
  render: StationRenderRunner,
): Promise<void> {
  const logId = await logJobStarted(name, QUEUE_NAMES.STATION_MESSAGES);
  const startTime = Date.now();
  try {
    await pushAllMessagesToAllStations(log, data, render);
    await logJobCompleted(logId, Date.now() - startTime);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    await logJobFailed(logId, Date.now() - startTime, errorMsg).catch(() => {});
    throw err;
  }
}

/**
 * Runs the station message jobs, which the OCPP server, the API and the
 * worker cron add themselves (enqueueStationRefresh, enqueueStationTransaction,
 * requestStationMessageRepush). Renders skip screens whose content hash is
 * unchanged.
 */
export function createStationMessageWorker(
  connection: ConnectionOptions,
  lockRedis: Redis,
): Worker {
  const render = stationRenderRunner(lockRedis);
  const worker = new Worker(
    QUEUE_NAMES.STATION_MESSAGES,
    async (job) => {
      switch (job.name) {
        case STATION_MESSAGE_JOBS.REPUSH:
          await runRepushJob(job.name, job.data as StationMessageRepushJob, render);
          return;
        case STATION_MESSAGE_JOBS.REFRESH:
          await runStationRefresh(job.data as StationRefreshJob, log, render);
          return;
        case STATION_MESSAGE_JOBS.TRANSACTION:
          await runStationTransaction(job.data as StationTransactionJob, log, render);
          return;
        default:
          log.warn({ jobName: job.name }, 'Unknown station message job');
      }
    },
    // Jobs for different stations run in parallel; one station's renders are
    // serialized by the lock in stationRenderRunner.
    { connection, concurrency: 10 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Station message job failed');
  });

  return worker;
}
