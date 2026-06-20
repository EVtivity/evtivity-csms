// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyServerOptions } from 'fastify';
import { RedisPubSubClient, createBullMQConnection, initSentry } from '@evtivity/lib';
import { getSentryConfig } from '@evtivity/database';
import { buildOcpiApp } from './app.js';
import { OcpiPushListener } from './services/push.service.js';
import { OcpiPullListener } from './services/pull.service.js';
import { OcpiRegisterListener } from './services/register-listener.service.js';
import { initCommandCallbackService } from './services/command-callback.service.js';
import { setPubSub } from './lib/pubsub.js';
import { config } from './lib/config.js';

async function start(): Promise<void> {
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-ocpi', sentryConfig);

  const opts: FastifyServerOptions = {
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
  };

  if (process.env['NODE_ENV'] !== 'production') {
    (opts.logger as Record<string, unknown>)['transport'] = {
      target: 'pino-pretty',
    };
  }

  const app = await buildOcpiApp(opts);

  const pubsub = new RedisPubSubClient(config.REDIS_URL);
  setPubSub(pubsub);

  // Raw Redis connection for the per-partner pull lock (pub/sub clients can't
  // run SET NX / EVAL). Serializes overlapping pulls across OCPI replicas.
  const lockRedis = createBullMQConnection(config.REDIS_URL);

  // Start push listener for data change notifications
  const pushListener = new OcpiPushListener(pubsub);
  await pushListener.start();

  // Start pull listener for sync requests
  const pullListener = new OcpiPullListener(pubsub, lockRedis);
  await pullListener.start();

  // Start outbound-registration listener so the operator-triggered
  // /v1/ocpi/partners/:id/register endpoint actually drives a handshake.
  const registerListener = new OcpiRegisterListener(pubsub);
  await registerListener.start();

  // Start command callback service for OCPI-initiated OCPP commands
  const commandCallbackService = initCommandCallbackService(pubsub);
  await commandCallbackService.start();

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    await commandCallbackService.stop();
    await registerListener.stop();
    await pullListener.stop();
    await pushListener.stop();
    await pubsub.close();
    await lockRedis.quit();
    await app.close();
  };

  const handleSignal = (): void => {
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  await app.listen({ port: config.OCPI_PORT, host: config.OCPI_HOST });
  app.log.info(`OCPI server listening on ${config.OCPI_HOST}:${String(config.OCPI_PORT)}`);
}

start().catch((err: unknown) => {
  console.error('Failed to start OCPI server:', err);
  process.exit(1);
});
