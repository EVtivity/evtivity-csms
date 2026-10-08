// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker } from 'bullmq';
import {
  createLogger,
  tryParseJson,
  createBullMQConnection,
  logBullMQErrors,
  RedisPubSubClient,
  initSentry,
  clearNotificationSettingsCache,
  clearStationMessageCache,
} from '@evtivity/lib';
import {
  getSentryConfig,
  clearStationMessageSettingsCache,
  clearSystemSettingsCache,
} from '@evtivity/database';
import { setPubSub } from '@evtivity/lib/pubsub-instance';
import { createQueues, QUEUE_NAMES } from './queues.js';
import { createCronWorker } from './cron-worker.js';
import { scheduleCronJobs, scheduleLoadManagementCoordinator } from './scheduler.js';
import { rebuildDelayedJobs, startRedisRecoveryWatch } from './redis-recovery.js';
import { createLoadManagementWorker } from './load-management-worker.js';
import { createGuestSessionWorker, startGuestSessionBridge } from './guest-session-worker.js';
import { createReservationWorker, startReservationBridge } from './reservation-worker.js';
import {
  createMaintenanceFanoutWorker,
  startMaintenanceFanoutBridge,
} from './maintenance-fanout-worker.js';
import {
  createFleetBillingFanoutWorker,
  startFleetBillingFanoutBridge,
} from './fleet-billing-fanout-worker.js';
import { createFleetInvoiceWorker, setFleetInvoiceQueue } from './fleet-invoice-worker.js';
import { createStationWatchWorker, startStationWatchBridge } from './station-watch-worker.js';
import {
  createPaymentWebhookWorker,
  queueSimulatedSink,
  startPaymentWebhookBridge,
} from './payment-webhook-worker.js';
import { setSimulatedEventSink } from './lib/payments.js';
import {
  createRemoteStartTimeoutWorker,
  startRemoteStartTimeoutBridge,
} from './remote-start-timeout-worker.js';
import { createStationMessageWorker, startStationMessageBridge } from './station-message-worker.js';
import { createReportWorker, setReportQueue, startReportBridge } from './report-worker.js';
import { octtRunnerHandler } from './handlers/octt-runner.js';
import type { OcttJobData } from './handlers/octt-runner.js';

const log = createLogger('worker');
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function start(): Promise<void> {
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-worker', sentryConfig);

  log.info('Worker starting...');

  const pubsub = new RedisPubSubClient(REDIS_URL);
  setPubSub(pubsub);
  const {
    cronQueue,
    loadQueue,
    guestSessionQueue,
    reservationQueue,
    octtQueue,
    maintenanceFanoutQueue,
    fleetBillingFanoutQueue,
    fleetInvoiceQueue,
    stationWatchQueue,
    paymentWebhookQueue,
    remoteStartTimeoutQueue,
    stationMessageQueue,
    reportQueue,
  } = createQueues(REDIS_URL);
  setSimulatedEventSink(queueSimulatedSink(paymentWebhookQueue));
  setReportQueue(reportQueue);
  setFleetInvoiceQueue(fleetInvoiceQueue);

  // Schedule cron jobs from database
  await scheduleCronJobs(cronQueue);

  // Schedule load management coordinator (runs every 10s, fans out per-site)
  await scheduleLoadManagementCoordinator(loadQueue);

  // Redis without persistence loses schedulers and delayed jobs on a restart
  // or failover: rebuild the delayed jobs the database knows about now (a
  // restart together with Redis), and watch for a later loss.
  const recoveryQueues = {
    cronQueue,
    loadQueue,
    reservationQueue,
    remoteStartTimeoutQueue,
    guestSessionQueue,
  };
  const rebuilt = await rebuildDelayedJobs(recoveryQueues);
  log.info({ ...rebuilt }, 'Delayed jobs checked against the database');
  const redisRecoveryWatch = await startRedisRecoveryWatch(recoveryQueues, log);

  // Create workers (each needs its own Redis connection per BullMQ docs)
  const cronWorker = createCronWorker(createBullMQConnection(REDIS_URL));
  const loadWorker = createLoadManagementWorker(createBullMQConnection(REDIS_URL), loadQueue);
  const guestWorker = createGuestSessionWorker(createBullMQConnection(REDIS_URL));
  const reservationWorker = createReservationWorker(createBullMQConnection(REDIS_URL), pubsub);
  const maintenanceFanoutWorker = createMaintenanceFanoutWorker(
    createBullMQConnection(REDIS_URL),
    createBullMQConnection(REDIS_URL),
  );
  const fleetBillingFanoutWorker = createFleetBillingFanoutWorker(
    createBullMQConnection(REDIS_URL),
  );
  const fleetInvoiceWorker = createFleetInvoiceWorker(createBullMQConnection(REDIS_URL));
  const stationWatchWorker = createStationWatchWorker(createBullMQConnection(REDIS_URL));
  const paymentWebhookWorker = createPaymentWebhookWorker(
    createBullMQConnection(REDIS_URL),
    pubsub,
  );
  const remoteStartTimeoutWorker = createRemoteStartTimeoutWorker(
    createBullMQConnection(REDIS_URL),
    pubsub,
  );

  const stationMessageWorker = createStationMessageWorker(
    createBullMQConnection(REDIS_URL),
    createBullMQConnection(REDIS_URL),
  );

  const reportWorker = createReportWorker(createBullMQConnection(REDIS_URL));

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

  for (const [name, worker] of Object.entries({
    cronWorker,
    loadWorker,
    guestWorker,
    reservationWorker,
    maintenanceFanoutWorker,
    fleetBillingFanoutWorker,
    fleetInvoiceWorker,
    stationWatchWorker,
    paymentWebhookWorker,
    remoteStartTimeoutWorker,
    stationMessageWorker,
    reportWorker,
    octtWorker,
  })) {
    // BullMQ re-emits Redis errors on every Worker; unheard, it prints each one
    // as a raw stack trace. The queues log theirs in createQueues.
    logBullMQErrors(worker, name);
  }

  // Start bridges (pub/sub -> BullMQ)
  const stopGuestBridge = await startGuestSessionBridge(pubsub, guestSessionQueue);
  const stopReservationBridge = await startReservationBridge(pubsub, reservationQueue);
  const stopMaintenanceFanoutBridge = await startMaintenanceFanoutBridge(
    pubsub,
    maintenanceFanoutQueue,
  );
  const stopFleetBillingFanoutBridge = await startFleetBillingFanoutBridge(
    pubsub,
    fleetBillingFanoutQueue,
  );
  const stopStationWatchBridge = await startStationWatchBridge(pubsub, stationWatchQueue);
  const stopPaymentWebhookBridge = await startPaymentWebhookBridge(pubsub, paymentWebhookQueue);
  const stopRemoteStartTimeoutBridge = await startRemoteStartTimeoutBridge(
    pubsub,
    remoteStartTimeoutQueue,
  );
  const stopStationMessageBridge = await startStationMessageBridge(pubsub, stationMessageQueue);
  const stopReportBridge = await startReportBridge(pubsub);

  // Listen for credential-rotation invalidations from the API so the next
  // dispatchDriverNotification / scheduled report email reads fresh SMTP and
  // Twilio creds instead of waiting out the 60s TTL.
  const cacheInvalidateSubscription = await pubsub.subscribe(
    'cache_invalidate',
    (payload: string) => {
      const msg = tryParseJson(payload) as { kind?: string } | null | undefined;
      if (msg == null || typeof msg !== 'object') {
        log.warn({ payload }, 'Malformed cache_invalidate message ignored');
        return;
      }
      if (msg.kind === 'notification_settings') {
        clearNotificationSettingsCache();
      }
      if (msg.kind === 'station_message') {
        // Station screens render here (station-messages and tariff boundary jobs).
        clearStationMessageCache();
        clearStationMessageSettingsCache();
        clearSystemSettingsCache();
      }
    },
  );

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
    await redisRecoveryWatch.stop();
    await stopGuestBridge();
    await stopReservationBridge();
    await stopMaintenanceFanoutBridge();
    await stopFleetBillingFanoutBridge();
    await stopStationWatchBridge();
    await stopPaymentWebhookBridge();
    await stopRemoteStartTimeoutBridge();
    await stopStationMessageBridge();
    await stopReportBridge();
    await octtSubscription.unsubscribe();
    await cacheInvalidateSubscription.unsubscribe();
    await cronWorker.close();
    await loadWorker.close();
    await guestWorker.close();
    await reservationWorker.close();
    await maintenanceFanoutWorker.close();
    await fleetBillingFanoutWorker.close();
    await fleetInvoiceWorker.close();
    await stationWatchWorker.close();
    await paymentWebhookWorker.close();
    await remoteStartTimeoutWorker.close();
    await stationMessageWorker.close();
    await reportWorker.close();
    await octtWorker.close();
    await cronQueue.close();
    await loadQueue.close();
    await guestSessionQueue.close();
    await reservationQueue.close();
    await octtQueue.close();
    await maintenanceFanoutQueue.close();
    await fleetBillingFanoutQueue.close();
    setFleetInvoiceQueue(null);
    await fleetInvoiceQueue.close();
    await stationWatchQueue.close();
    setSimulatedEventSink(null);
    await paymentWebhookQueue.close();
    await remoteStartTimeoutQueue.close();
    await stationMessageQueue.close();
    await reportQueue.close();
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
