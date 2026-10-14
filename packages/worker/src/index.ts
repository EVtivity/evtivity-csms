// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Worker, type Queue } from 'bullmq';
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
  guardPgConnectionRejections,
  clearStationMessageSettingsCache,
  clearSystemSettingsCache,
} from '@evtivity/database';
import { setPubSub } from '@evtivity/lib/pubsub-instance';
import { setJobQueueResolver } from '@evtivity/lib/job-queues';
import { queueSimulatedSink } from '@evtivity/payments';
import { createDriverAiWorker, setDriverAiQueue, startDriverAiBridge } from './driver-ai/queue.js';
import { createQueues, QUEUE_NAMES } from './queues.js';
import { createCronWorker } from './cron-worker.js';
import { scheduleCronJobs, scheduleLoadManagementCoordinator } from './scheduler.js';
import { rebuildDelayedJobs, startRedisRecoveryWatch } from './redis-recovery.js';
import { createLoadManagementWorker } from './load-management-worker.js';
import { createGuestSessionWorker, startGuestSessionBridge } from './guest-session-worker.js';
import {
  createReservationWorker,
  setReservationQueue,
  startReservationBridge,
} from './reservation-worker.js';
import { createMaintenanceFanoutWorker } from './maintenance-fanout-worker.js';
import { createFleetBillingFanoutWorker } from './fleet-billing-fanout-worker.js';
import { createFleetInvoiceWorker, setFleetInvoiceQueue } from './fleet-invoice-worker.js';
import { createMemberInvoiceWorker, setMemberInvoiceQueue } from './member-invoice-worker.js';
import { createStationWatchWorker } from './station-watch-worker.js';
import { createPaymentWebhookWorker } from './payment-webhook-worker.js';
import { setSimulatedEventSink } from './lib/payments.js';
import {
  createRemoteStartTimeoutWorker,
  startRemoteStartTimeoutBridge,
} from './remote-start-timeout-worker.js';
import { createStationMessageWorker } from './station-message-worker.js';
import { createReportWorker, setReportQueue, startReportBridge } from './report-worker.js';
import { createAiWorker, setAiWorkerQueue } from './ai-worker-queue.js';
import {
  createAiInsightWorker,
  setAiInsightQueue,
  startAiInsightBridge,
} from './ai-insight-worker.js';
import { octtRunnerJob } from './handlers/octt-runner.js';
import type { OcttJobData } from './handlers/octt-runner.js';
import { probeWorkerLockGrants } from './lib/redis-acl-probe.js';

const log = createLogger('worker');
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function start(): Promise<void> {
  // A backend terminated while postgres.js fetches its array types must not end
  // the process (pg-connection-rejections.ts).
  guardPgConnectionRejections(log);
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-worker', sentryConfig);

  log.info('Worker starting...');

  // Fail the rollout when the worker Redis user lacks a lock prefix grant (an
  // upgraded Redis that still has the previous release's ACL), instead of
  // every locked job failing later with NOPERM.
  const probeRedis = createBullMQConnection(REDIS_URL);
  try {
    await probeWorkerLockGrants(probeRedis);
  } finally {
    probeRedis.disconnect();
  }

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
    memberInvoiceQueue,
    stationWatchQueue,
    paymentWebhookQueue,
    remoteStartTimeoutQueue,
    stationMessageQueue,
    reportQueue,
    aiWorkerQueue,
    aiInsightQueue,
    driverAiQueue,
  } = createQueues(REDIS_URL);
  // Jobs this process adds to its own queues through the shared producers
  // (maintenance cron, station-watch alerts, station screens, simulated
  // payment events) go to the queues created above.
  const queuesByName = new Map<string, Queue>([
    [QUEUE_NAMES.MAINTENANCE_FANOUT, maintenanceFanoutQueue],
    [QUEUE_NAMES.FLEET_BILLING_FANOUT, fleetBillingFanoutQueue],
    [QUEUE_NAMES.MEMBER_INVOICES, memberInvoiceQueue],
    [QUEUE_NAMES.STATION_WATCH, stationWatchQueue],
    [QUEUE_NAMES.PAYMENT_WEBHOOKS, paymentWebhookQueue],
    [QUEUE_NAMES.STATION_MESSAGES, stationMessageQueue],
  ]);
  setJobQueueResolver((name) => queuesByName.get(name));
  setSimulatedEventSink(queueSimulatedSink());
  setReportQueue(reportQueue);
  setAiWorkerQueue(aiWorkerQueue);
  setFleetInvoiceQueue(fleetInvoiceQueue);
  setMemberInvoiceQueue(memberInvoiceQueue);
  setReservationQueue(reservationQueue);
  setAiInsightQueue(aiInsightQueue);
  setDriverAiQueue(driverAiQueue);

  // Schedule cron jobs from database
  await scheduleCronJobs(cronQueue);

  // Schedule load management coordinator (runs every 10s, fans out per-site)
  await scheduleLoadManagementCoordinator(loadQueue);

  // Create workers (each needs its own Redis connection per BullMQ docs)
  // Lock connections (withLock), closed on shutdown after their workers.
  const cronLockRedis = createBullMQConnection(REDIS_URL);
  const maintenanceLockRedis = createBullMQConnection(REDIS_URL);
  const fleetBillingLockRedis = createBullMQConnection(REDIS_URL);
  const stationMessageLockRedis = createBullMQConnection(REDIS_URL);
  const octtLockRedis = createBullMQConnection(REDIS_URL);
  const aiWorkerLockRedis = createBullMQConnection(REDIS_URL);
  const cronWorker = createCronWorker(createBullMQConnection(REDIS_URL), cronLockRedis);
  const loadWorker = createLoadManagementWorker(createBullMQConnection(REDIS_URL), loadQueue);
  const guestWorker = createGuestSessionWorker(createBullMQConnection(REDIS_URL));
  const reservationWorker = createReservationWorker(createBullMQConnection(REDIS_URL), pubsub);
  const maintenanceFanoutWorker = createMaintenanceFanoutWorker(
    createBullMQConnection(REDIS_URL),
    maintenanceLockRedis,
  );
  const fleetBillingFanoutWorker = createFleetBillingFanoutWorker(
    createBullMQConnection(REDIS_URL),
    fleetBillingLockRedis,
  );
  const fleetInvoiceWorker = createFleetInvoiceWorker(createBullMQConnection(REDIS_URL));
  const memberInvoiceWorker = createMemberInvoiceWorker(createBullMQConnection(REDIS_URL));
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
    stationMessageLockRedis,
  );

  const reportWorker = createReportWorker(createBullMQConnection(REDIS_URL));
  const aiWorker = createAiWorker(createBullMQConnection(REDIS_URL), aiWorkerLockRedis);
  const aiInsightWorker = createAiInsightWorker(createBullMQConnection(REDIS_URL), pubsub);
  const driverAiWorker = createDriverAiWorker(createBullMQConnection(REDIS_URL));

  // OCTT conformance test worker
  const octtWorker = new Worker<OcttJobData>(
    QUEUE_NAMES.OCTT,
    async (job) => {
      await octtRunnerJob(octtLockRedis, job.data, log.child({ jobId: job.id }), pubsub);
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
    memberInvoiceWorker,
    stationWatchWorker,
    paymentWebhookWorker,
    remoteStartTimeoutWorker,
    stationMessageWorker,
    reportWorker,
    aiWorker,
    aiInsightWorker,
    driverAiWorker,
    octtWorker,
  })) {
    // BullMQ re-emits Redis errors on every Worker; unheard, it prints each one
    // as a raw stack trace. The queues log theirs in createQueues.
    logBullMQErrors(worker, name);
  }

  // Start bridges (pub/sub -> BullMQ)
  const stopGuestBridge = await startGuestSessionBridge(pubsub, guestSessionQueue);
  const stopReservationBridge = await startReservationBridge(pubsub, reservationQueue);
  const stopRemoteStartTimeoutBridge = await startRemoteStartTimeoutBridge(
    pubsub,
    remoteStartTimeoutQueue,
  );
  const stopReportBridge = await startReportBridge(pubsub);
  const stopAiInsightBridge = await startAiInsightBridge(pubsub);
  const stopDriverAiBridge = await startDriverAiBridge(pubsub);

  // Redis without persistence loses schedulers and delayed jobs on a restart
  // or failover: rebuild the delayed jobs the database knows about now (a
  // restart together with Redis), and watch for a later loss. The rebuild
  // runs after the bridges subscribe, so a reservation or remote start
  // published while this worker was down (no subscriber, message lost) is
  // rebuilt from the database, and one published from now on reaches a
  // bridge: no gap between the two.
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
    await stopRemoteStartTimeoutBridge();
    await stopReportBridge();
    await stopAiInsightBridge();
    await stopDriverAiBridge();
    await octtSubscription.unsubscribe();
    await cacheInvalidateSubscription.unsubscribe();
    await cronWorker.close();
    await loadWorker.close();
    await guestWorker.close();
    await reservationWorker.close();
    await maintenanceFanoutWorker.close();
    await fleetBillingFanoutWorker.close();
    await fleetInvoiceWorker.close();
    await memberInvoiceWorker.close();
    await stationWatchWorker.close();
    await paymentWebhookWorker.close();
    await remoteStartTimeoutWorker.close();
    await stationMessageWorker.close();
    await reportWorker.close();
    await aiWorker.close();
    await aiInsightWorker.close();
    await driverAiWorker.close();
    await octtWorker.close();
    await cronQueue.close();
    await loadQueue.close();
    await guestSessionQueue.close();
    await reservationQueue.close();
    await octtQueue.close();
    setJobQueueResolver(null);
    await maintenanceFanoutQueue.close();
    await fleetBillingFanoutQueue.close();
    setFleetInvoiceQueue(null);
    await fleetInvoiceQueue.close();
    setMemberInvoiceQueue(null);
    await memberInvoiceQueue.close();
    await stationWatchQueue.close();
    setSimulatedEventSink(null);
    await paymentWebhookQueue.close();
    await remoteStartTimeoutQueue.close();
    await stationMessageQueue.close();
    await reportQueue.close();
    setAiWorkerQueue(null);
    await aiWorkerQueue.close();
    setAiInsightQueue(null);
    await aiInsightQueue.close();
    setDriverAiQueue(null);
    await driverAiQueue.close();
    for (const lockRedis of [
      cronLockRedis,
      maintenanceLockRedis,
      fleetBillingLockRedis,
      stationMessageLockRedis,
      octtLockRedis,
      aiWorkerLockRedis,
    ]) {
      try {
        await lockRedis.quit();
      } catch (err) {
        log.warn({ err }, 'Closing a lock Redis connection failed');
      }
    }
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
