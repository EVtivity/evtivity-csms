// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker } from 'bullmq';
import { createLogger, createBullMQConnection, RedisPubSubClient, initSentry } from '@evtivity/lib';
import { getSentryConfig } from '@evtivity/database';
import { setPubSub } from '@evtivity/api/src/lib/pubsub.js';
import { createQueues, QUEUE_NAMES } from './queues.js';
import { createCronWorker } from './cron-worker.js';
import { scheduleCronJobs } from './scheduler.js';
import { createLoadManagementWorker } from './load-management-worker.js';
import { createGuestSessionWorker, startGuestSessionBridge } from './guest-session-worker.js';
import { createReservationWorker, startReservationBridge } from './reservation-worker.js';
import { octtRunnerHandler } from './handlers/octt-runner.js';
import type { OcttJobData } from './handlers/octt-runner.js';

const log = createLogger('worker');
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const LOAD_MANAGEMENT_INTERVAL_MS = 10_000;

async function start(): Promise<void> {
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-worker', sentryConfig);

  log.info('Worker starting...');

  const pubsub = new RedisPubSubClient(REDIS_URL);
  setPubSub(pubsub);
  const { cronQueue, loadQueue, guestSessionQueue, reservationQueue, octtQueue, deadLetterQueue } =
    createQueues(REDIS_URL);

  // Schedule cron jobs from database
  await scheduleCronJobs(cronQueue);

  // Schedule load management coordinator (runs every 10s, fans out per-site)
  await loadQueue.upsertJobScheduler(
    'load-management-coordinator',
    { every: LOAD_MANAGEMENT_INTERVAL_MS },
    { name: 'load-management-coordinator' },
  );

  // Create workers (each needs its own Redis connection per BullMQ docs)
  const cronWorker = createCronWorker(createBullMQConnection(REDIS_URL));
  const loadWorker = createLoadManagementWorker(createBullMQConnection(REDIS_URL), loadQueue);
  const guestWorker = createGuestSessionWorker(createBullMQConnection(REDIS_URL));
  const reservationWorker = createReservationWorker(createBullMQConnection(REDIS_URL), pubsub);

  // OCTT conformance test worker
  const octtWorker = new Worker<OcttJobData>(
    QUEUE_NAMES.OCTT,
    async (job) => {
      await octtRunnerHandler(job.data, log.child({ jobId: job.id }), pubsub);
    },
    {
      connection: createBullMQConnection(REDIS_URL),
      concurrency: 1,
    },
  );

  // Start bridges (pub/sub -> BullMQ)
  const stopGuestBridge = await startGuestSessionBridge(pubsub, guestSessionQueue);
  const stopReservationBridge = await startReservationBridge(pubsub, reservationQueue);

  // OCTT run bridge: pub/sub -> BullMQ
  const octtSubscription = await pubsub.subscribe('octt_run', (message: string) => {
    void (async () => {
      try {
        const data = JSON.parse(message) as OcttJobData;
        await octtQueue.add('octt-run', data, { jobId: `octt-run-${String(data.runId)}` });
        log.info({ runId: data.runId }, 'OCTT run job enqueued');
      } catch (err) {
        log.error({ error: err }, 'Failed to enqueue OCTT run');
      }
    })();
  });

  log.info('Worker started. All queues and workers active.');

  const shutdown = async (): Promise<void> => {
    log.info('Worker shutting down...');
    await stopGuestBridge();
    await stopReservationBridge();
    await octtSubscription.unsubscribe();
    await cronWorker.close();
    await loadWorker.close();
    await guestWorker.close();
    await reservationWorker.close();
    await octtWorker.close();
    await cronQueue.close();
    await loadQueue.close();
    await guestSessionQueue.close();
    await reservationQueue.close();
    await octtQueue.close();
    await deadLetterQueue.close();
    await pubsub.close();
    log.info('Worker shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

start().catch((err: unknown) => {
  log.error({ err }, 'Worker failed to start');
  process.exit(1);
});
