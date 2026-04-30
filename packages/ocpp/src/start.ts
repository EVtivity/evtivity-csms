// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
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

const OCPP_TLS_PORT = config.OCPP_TLS_PORT ?? 8443;

// Resolve the instance ID that RedisConnectionRegistry uses to route station
// commands to the pod that owns each WebSocket. Helm sets OCPP_INSTANCE_ID
// from the pod name via the Downward API; ECS Fargate has no such API, so
// we read the task ID from the metadata endpoint at startup. Local dev
// falls back to hostname().
async function deriveInstanceId(): Promise<string> {
  if (config.OCPP_INSTANCE_ID != null && config.OCPP_INSTANCE_ID !== '') {
    return config.OCPP_INSTANCE_ID;
  }
  const metadataUri = process.env['ECS_CONTAINER_METADATA_URI_V4'];
  if (metadataUri != null && metadataUri !== '') {
    try {
      const res = await fetch(`${metadataUri}/task`);
      const data = (await res.json()) as { TaskARN?: string };
      const taskId = (data.TaskARN ?? '').split('/').pop();
      if (taskId != null && taskId !== '') return `ocpp-${taskId}`;
    } catch {
      // fall through to hostname
    }
  }
  return hostname();
}

// Resolve TLS material from either env var (ECS / Secrets Manager) or file
// path (Helm / Kubernetes Secret volume). The *_PEM forms take precedence
// because the CDK injects them directly; the path forms are read from disk.
function resolvePem(pem: string | undefined, path: string | undefined): string | undefined {
  if (pem != null && pem !== '') return pem;
  if (path != null && path !== '') return readFileSync(path, 'utf-8');
  return undefined;
}
const OCPP_TLS_CERT = resolvePem(config.OCPP_TLS_CERT_PEM, config.OCPP_TLS_CERT);
const OCPP_TLS_KEY = resolvePem(config.OCPP_TLS_KEY_PEM, config.OCPP_TLS_KEY);
const OCPP_TLS_CA = resolvePem(config.OCPP_TLS_CA_PEM, config.OCPP_TLS_CA);

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

  const instanceId = await deriveInstanceId();

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
  server.getConnectionManager().setRegistry(registry, instanceId);

  registerProjections(server.getEventBus(), DATABASE_URL, pubsub, {
    registry,
    instanceId,
  });

  commandListener = new CommandListener(
    pubsub,
    server.getDispatcher(),
    server.getLogger(),
    server.getEventBus(),
    { registry, instanceId },
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
