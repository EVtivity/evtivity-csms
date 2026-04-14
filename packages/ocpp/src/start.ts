// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { OcppServer } from './server/ocpp-server.js';
import { CommandListener } from './server/command-listener.js';
import { PgEventPersistence, getSentryConfig } from '@evtivity/database';
import { RedisPubSubClient, RedisConnectionRegistry, initSentry } from '@evtivity/lib';
import { registerProjections } from './server/event-projections.js';
import { config } from './lib/config.js';

const OCPP_PORT = config.OCPP_PORT;
const OCPP_HOST = config.OCPP_HOST;
const OCPP_HEALTH_PORT = config.OCPP_HEALTH_PORT;
const DATABASE_URL = config.DATABASE_URL;
const REDIS_URL = config.REDIS_URL;

const OCPP_TLS_CERT = config.OCPP_TLS_CERT;
const OCPP_TLS_KEY = config.OCPP_TLS_KEY;
const OCPP_TLS_CA = config.OCPP_TLS_CA;
const OCPP_TLS_PORT = config.OCPP_TLS_PORT ?? 8443;
const OCPP_INSTANCE_ID = config.OCPP_INSTANCE_ID ?? hostname();

const eventPersistence = new PgEventPersistence();
const server = new OcppServer({ eventPersistence, databaseUrl: DATABASE_URL });
let commandListener: CommandListener | null = null;
let healthServer: Server | null = null;
let pubsub: RedisPubSubClient | null = null;
let registryRedis: Redis | null = null;
let shuttingDown = false;

async function start(): Promise<void> {
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-ocpp', sentryConfig);

  const tls =
    OCPP_TLS_CERT != null && OCPP_TLS_KEY != null
      ? { cert: OCPP_TLS_CERT, key: OCPP_TLS_KEY, ca: OCPP_TLS_CA, port: OCPP_TLS_PORT }
      : undefined;
  await server.start({ port: OCPP_PORT, host: OCPP_HOST, tls });

  pubsub = new RedisPubSubClient(REDIS_URL);

  // Create a separate Redis client for the connection registry (not the pub/sub client)
  registryRedis = new Redis(REDIS_URL);
  const registry = new RedisConnectionRegistry(registryRedis);

  // Pass registry to connection manager for station ownership tracking
  server.getConnectionManager().setRegistry(registry, OCPP_INSTANCE_ID);

  registerProjections(server.getEventBus(), DATABASE_URL, pubsub, {
    registry,
    instanceId: OCPP_INSTANCE_ID,
  });

  commandListener = new CommandListener(
    pubsub,
    server.getDispatcher(),
    server.getLogger(),
    server.getEventBus(),
    { registry, instanceId: OCPP_INSTANCE_ID },
  );
  await commandListener.start();

  // Health check HTTP server
  // Returns 503 during shutdown so Kubernetes stops routing traffic before
  // connections are drained (readiness probe fails, pod is removed from Service).
  healthServer = createServer((_req, res) => {
    if (shuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'shutting_down',
          timestamp: new Date().toISOString(),
          connectedStations: server.getConnectionManager().count(),
        }),
      );
      return;
    }

    const connectedStations = server.getConnectionManager().count();

    if (pubsub == null) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'degraded',
          timestamp: new Date().toISOString(),
          connectedStations,
          redis: 'error',
        }),
      );
      return;
    }

    pubsub
      .ping()
      .then((redisOk) => {
        const status = redisOk ? 'ok' : 'degraded';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status,
            timestamp: new Date().toISOString(),
            connectedStations,
            redis: redisOk ? 'ok' : 'error',
          }),
        );
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'degraded',
            timestamp: new Date().toISOString(),
            connectedStations,
            redis: 'error',
          }),
        );
      });
  });
  healthServer.listen(OCPP_HEALTH_PORT, OCPP_HOST);
}

async function shutdown(): Promise<void> {
  console.log('\nShutting down OCPP server...');
  shuttingDown = true;
  if (healthServer != null) {
    healthServer.close();
  }
  if (commandListener != null) {
    await commandListener.stop();
  }
  if (pubsub != null) {
    await pubsub.close();
  }
  if (registryRedis != null) {
    registryRedis.disconnect();
  }
  await server.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

start().catch((err: unknown) => {
  console.error('OCPP server failed to start:', err);
  process.exit(1);
});
