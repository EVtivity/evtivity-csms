// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyServerOptions } from 'fastify';
import { RedisPubSubClient, createLogger, initSentry, logFormatOptions } from '@evtivity/lib';
import { client, getSentryConfig, guardPgConnectionRejections } from '@evtivity/database';
import { createShutdownHandler } from './lib/process-shutdown.js';
import { closeJobQueues, initJobQueues } from '@evtivity/lib/job-queues';
import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { setPubSub } from '@evtivity/lib/pubsub-instance';
import { startMetricsServer, stopMetricsServer, registerHttpMetrics } from './plugins/metrics.js';
import {
  startMetricsCollector,
  stopMetricsCollector,
} from './services/metrics-collector.service.js';
import { startCacheInvalidateListener } from './services/cache-invalidate-listener.js';
import { reportPricingGroupsWithoutDefault } from './lib/pricing-default-report.js';

async function start(): Promise<void> {
  // A backend terminated while postgres.js fetches its array types must not end
  // the process (pg-connection-rejections.ts).
  guardPgConnectionRejections(createLogger('api'));
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-api', sentryConfig);

  const opts: FastifyServerOptions = {
    logger: {
      level: config.LOG_LEVEL,
      ...logFormatOptions,
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url.replace(/token=[^&]+/, 'token=REDACTED'),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
  };

  if (config.NODE_ENV !== 'production') {
    (opts.logger as Record<string, unknown>)['transport'] = {
      target: 'pino-pretty',
    };
  }

  // Requests that must reach the worker even while it is stopped add their
  // BullMQ jobs to its queues directly (the api Redis user may write only
  // those queues), so the queues are ready before the first request.
  initJobQueues(config.REDIS_URL);

  const app = await buildApp(opts);

  registerHttpMetrics(app);
  startMetricsServer(config.METRICS_PORT);
  startMetricsCollector();

  const pubsub = new RedisPubSubClient(config.REDIS_URL);
  setPubSub(pubsub);

  // Guest session linking + payment finalization is intentionally NOT
  // wired here. It runs in the worker package via startGuestSessionBridge
  // (BullMQ jobId dedup) so multiple API replicas don't all process the
  // same TransactionStarted event and create duplicate payment_records.
  // dev:worker is required for guest charging in dev mode.

  // Station screen renders run in the worker through the station-messages
  // queue, once per event across replicas (station-message-worker.ts), not in
  // every API pod.
  const cacheInvalidateSubscription = await startCacheInvalidateListener(app.log);

  app.addHook('onClose', async () => {
    stopMetricsCollector();
    await stopMetricsServer();
    await cacheInvalidateSubscription.unsubscribe();
    await closeJobQueues();
    await pubsub.close();
  });

  // Without handlers SIGTERM kills the process at once: in-flight requests
  // are cut and the onClose hooks above never run.
  const shutdown = createShutdownHandler({
    closeApp: () => app.close(),
    closeDatabase: () => client.end({ timeout: 5 }),
    exit: (code) => process.exit(code),
    logger: app.log,
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(`API server listening on ${config.API_HOST}:${String(config.API_PORT)}`);
  await reportPricingGroupsWithoutDefault(client, app.log);
}

start().catch((err: unknown) => {
  console.error('Failed to start API server:', err);
  process.exit(1);
});
