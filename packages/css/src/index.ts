// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import postgres from 'postgres';
import { RedisPubSubClient } from '@evtivity/lib';
import { SimulatorManager } from './simulator-manager.js';
import { ChaosOrchestrator } from './chaos-orchestrator.js';
import { config } from './lib/config.js';

const databaseUrl = config.DATABASE_URL;
const redisUrl = config.REDIS_URL;
const mode = config.CSS_MODE;
const healthPort = config.CSS_HEALTH_PORT;
const actionIntervalMs = config.CSS_ACTION_INTERVAL_MS;
const stationLimit = config.CSS_STATION_LIMIT;

const sql = postgres(databaseUrl);
const pubsub = new RedisPubSubClient(redisUrl);
const manager = new SimulatorManager(sql, pubsub);

async function waitForSchema(): Promise<void> {
  const MAX_ATTEMPTS = 20;
  const BASE_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sql`SELECT 1 FROM css_stations LIMIT 0`;
      return;
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Database schema not ready after ${String(MAX_ATTEMPTS)} attempts`);
      }
      const delay = Math.min(BASE_DELAY_MS * attempt, 30000);
      console.log(
        `[init] Schema not ready (attempt ${String(attempt)}/${String(MAX_ATTEMPTS)}), retrying in ${String(delay)}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main(): Promise<void> {
  await waitForSchema();

  // Subscribe to css_commands channel
  await pubsub.subscribe('css_commands', (raw: string) => {
    void manager.handleCommand(raw);
  });

  // Start the simulator manager (watches css_stations table, syncs simulators)
  await manager.start();
  console.log(`[css] SimulatorManager started. Mode: ${mode}`);

  // Chaos mode: orchestrator dispatches random actions against simulators
  // whose css_stations rows were already seeded by the database migrations.
  let chaos: ChaosOrchestrator | null = null;
  if (mode === 'chaos') {
    chaos = new ChaosOrchestrator(sql, pubsub, {
      actionIntervalMs,
      stationLimit,
    });
    await chaos.start();
    console.log('[css] ChaosOrchestrator started');
  }

  // Health endpoint for liveness/readiness probes
  const healthServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode, simulators: manager.simulatorCount }));
  });
  healthServer.listen(healthPort, () => {
    console.log(`[health] Listening on port ${String(healthPort)}`);
  });

  function shutdown(): void {
    console.log('\nShutting down CSS...');
    healthServer.close();
    if (chaos != null) chaos.stop();
    void manager
      .stop()
      .then(() => pubsub.close())
      .then(() => sql.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('CSS failed:', err);
  process.exit(1);
});
