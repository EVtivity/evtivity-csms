// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger, tryParseJson, withLock } from '@evtivity/lib';
import {
  pushAllMessagesToAllStations,
  parseStationRefreshPayload,
  parseStationTransactionPayload,
  runStationRefresh,
  runStationRender,
  runStationTransaction,
  STATION_MESSAGE_REFRESH_CHANNEL,
  STATION_MESSAGE_REPUSH_CHANNEL,
  STATION_MESSAGE_TRANSACTION_CHANNEL,
  type StationMessageRepushJob,
  type StationRefreshJob,
  type StationRenderRunner,
  type StationTransactionJob,
} from '@evtivity/services/station-message.service';
import { QUEUE_NAMES } from './queues.js';
import { logJobStarted, logJobCompleted, logJobFailed } from './job-logger.js';

const log = createLogger('station-message-worker');

export const STATION_MESSAGE_JOBS = {
  REPUSH: 'station-message-repush',
  REFRESH: 'station-message-refresh',
  TRANSACTION: 'station-message-transaction',
} as const;

/**
 * Repush requests within this window collapse into one job: saving a settings
 * tab writes several keys at once.
 */
export const STATION_MESSAGE_REPUSH_DEBOUNCE_MS = 3000;

/**
 * Station events within this window collapse into one render. Every worker
 * replica bridges the same pub/sub message, so the window also makes one
 * event one job across replicas. The job renders the state stored at run
 * time, so the last event wins.
 */
export const STATION_MESSAGE_EVENT_DEBOUNCE_MS = 500;

/** Deduplication id of a repush scope ('.' separated: BullMQ ids reject ':'). */
export function stationMessageRepushDedupId(job: StationMessageRepushJob): string {
  if (job.siteId != null) return `smr.site.${job.siteId}`;
  if (job.stationId != null) return `smr.station.${job.stationId}`;
  if (job.pricingGroupId != null) return `smr.group.${job.pricingGroupId}`;
  return 'smr.all';
}

function debounced(id: string, ms: number): JobsOptions {
  return { delay: ms, deduplication: { id, ttl: ms, extend: true, replace: true } };
}

function parseRepushPayload(raw: string): StationMessageRepushJob | null {
  const parsed = tryParseJson(raw);
  if (typeof parsed !== 'object' || parsed == null) return null;
  const value = parsed as Record<string, unknown>;
  for (const key of ['siteId', 'stationId', 'pricingGroupId'] as const) {
    const field = value[key];
    if (typeof field === 'string' && field !== '') return { [key]: field };
  }
  return {};
}

/**
 * Bridges the three station message channels into the station-messages queue.
 * Every worker replica runs the bridge; the deduplication ids keep one job
 * per station event, per session event, and per repush scope.
 */
export async function startStationMessageBridge(
  pubsub: PubSubClient,
  queue: Queue,
): Promise<() => Promise<void>> {
  const enqueue = (name: string, data: object, opts: JobsOptions, context: object): void => {
    void queue.add(name, data, opts).catch((err: unknown) => {
      log.error({ err, ...context }, `Failed to enqueue ${name} job`);
    });
  };

  const repush = await pubsub.subscribe(STATION_MESSAGE_REPUSH_CHANNEL, (payload: string) => {
    const data = parseRepushPayload(payload);
    if (data == null) {
      log.warn({ payload: payload.slice(0, 200) }, 'Malformed station_message_repush payload');
      return;
    }
    enqueue(
      STATION_MESSAGE_JOBS.REPUSH,
      data,
      debounced(stationMessageRepushDedupId(data), STATION_MESSAGE_REPUSH_DEBOUNCE_MS),
      data,
    );
  });

  const refresh = await pubsub.subscribe(STATION_MESSAGE_REFRESH_CHANNEL, (payload: string) => {
    const data = parseStationRefreshPayload(payload);
    if (data == null) {
      log.warn({ payload: payload.slice(0, 200) }, 'Malformed station_message_refresh payload');
      return;
    }
    enqueue(
      STATION_MESSAGE_JOBS.REFRESH,
      data,
      debounced(`smf.${data.internalStationId}`, STATION_MESSAGE_EVENT_DEBOUNCE_MS),
      { stationId: data.stationOcppId },
    );
  });

  const transaction = await pubsub.subscribe(
    STATION_MESSAGE_TRANSACTION_CHANNEL,
    (payload: string) => {
      const data = parseStationTransactionPayload(payload);
      if (data == null) {
        log.warn(
          { payload: payload.slice(0, 200) },
          'Malformed station_message_transaction payload',
        );
        return;
      }
      // One id per session: a later event replaces a pending one, and the job
      // clears the slots when the session has ended by the time it runs.
      enqueue(
        STATION_MESSAGE_JOBS.TRANSACTION,
        data,
        debounced(`smt.${data.sessionId}`, STATION_MESSAGE_EVENT_DEBOUNCE_MS),
        { sessionId: data.sessionId },
      );
    },
  );

  log.info('Station message bridge started');

  return async () => {
    await repush.unsubscribe();
    await refresh.unsubscribe();
    await transaction.unsubscribe();
    log.info('Station message bridge stopped');
  };
}

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

/** Runs the station message jobs. Renders skip screens whose content hash is unchanged. */
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
