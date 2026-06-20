// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { QUEUE_NAMES } from './queues.js';
import { handleStationWatchDispatch } from './handlers/station-watch-dispatch.js';

const log = createLogger('station-watch-worker');

interface StationWatchJobData {
  stationId: string;
}

/**
 * Subscribes to the station_watch_available pub/sub channel (published by the
 * OCPP server when a station transitions to having a free connector) and
 * enqueues a dispatch job. No deterministic jobId: the projection's
 * previousDbStatus guard already prevents the same edge from firing twice, and
 * the dispatch claims watches via DELETE ... RETURNING, so a duplicate job just
 * no-ops. A static per-station jobId would instead drop a later legitimate fire
 * for the same station while an earlier completed job is still retained.
 */
export async function startStationWatchBridge(
  pubsub: PubSubClient,
  queue: Queue,
): Promise<() => Promise<void>> {
  const subscription = await pubsub.subscribe('station_watch_available', (payload: string) => {
    let data: { stationId?: unknown };
    try {
      data = JSON.parse(payload) as { stationId?: unknown };
    } catch (err) {
      log.warn(
        { err, payload: payload.slice(0, 200) },
        'Malformed station_watch_available payload',
      );
      return;
    }
    const stationId = data.stationId;
    if (typeof stationId !== 'string' || stationId === '') return;

    void queue.add('station-watch-dispatch', { stationId }).catch((err: unknown) => {
      log.error({ err, stationId }, 'Failed to enqueue station-watch job');
    });
  });

  log.info('Station-watch bridge started');

  return async () => {
    await subscription.unsubscribe();
    log.info('Station-watch bridge stopped');
  };
}

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
