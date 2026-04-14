// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const serverUrl = config.OCPP_SERVER_URL;
const tlsServerUrl = config.OCPP_TLS_SERVER_URL;
const password = config.CSS_STATION_PASSWORD;

const sql = postgres(databaseUrl);
const pubsub = new RedisPubSubClient(redisUrl);
const manager = new SimulatorManager(sql);

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

  // Load SP3 test certificates for TLS stations
  const testCertsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../test-certs');
  const clientCertPath = config.CSS_CLIENT_CERT ?? resolve(testCertsDir, 'client.pem');
  const clientKeyPath = config.CSS_CLIENT_KEY ?? resolve(testCertsDir, 'client-key.pem');
  const caCertPath = config.CSS_CA_CERT ?? resolve(testCertsDir, 'ca.pem');
  let sp3ClientCert: string | undefined;
  let sp3ClientKey: string | undefined;
  let sp3CaCert: string | undefined;
  if (existsSync(clientCertPath)) {
    sp3ClientCert = readFileSync(clientCertPath, 'utf-8');
    sp3ClientKey = readFileSync(clientKeyPath, 'utf-8');
    sp3CaCert = readFileSync(caCertPath, 'utf-8');
  }

  // Chaos mode: orchestrator reads CSMS stations and writes directly to css_* tables + Redis
  let chaos: ChaosOrchestrator | null = null;
  if (mode === 'chaos') {
    chaos = new ChaosOrchestrator(sql, pubsub, {
      actionIntervalMs,
      stationLimit,
      serverUrl,
      tlsServerUrl,
      password,
      ...(sp3ClientCert != null ? { clientCert: sp3ClientCert } : {}),
      ...(sp3ClientKey != null ? { clientKey: sp3ClientKey } : {}),
      ...(sp3CaCert != null ? { caCert: sp3CaCert } : {}),
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
