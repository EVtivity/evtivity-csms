// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { handleStationWatchDispatch } from './handlers/station-watch-dispatch.js';

const log = createLogger('station-watch-worker');

interface StationWatchJobData {
  stationId: string;
}

/**
 * Runs the station-watch dispatches. The API, OCPP and worker paths that can
 * free a station add the jobs themselves (alertStationWatchersIfAvailable),
 * so a signal waits while no worker runs. No deterministic jobId: several
 * paths may signal the same change, and the dispatch claims watches via
 * DELETE ... RETURNING under the shared availability rule, so a duplicate job
 * just no-ops.
 */
export function createStationWatchWorker(connection: ConnectionOptions): Worker {
  const worker = new Worker(
    QUEUE_NAMES.STATION_WATCH,
    async (job) => {
      const { stationId } = job.data as StationWatchJobData;
      await handleStationWatchDispatch(stationId, log.child({ jobId: job.id }));
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (job == null) return;
    log.error({ jobName: job.name, error: err }, 'Station-watch job failed');
  });

  return worker;
}
