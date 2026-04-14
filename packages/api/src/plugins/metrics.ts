// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('metrics');

const register = new Registry();

// Collect default Node.js metrics (heap, CPU, event loop, GC, handles, etc.)
collectDefaultMetrics({ register });

// --- HTTP request metrics ---

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpActiveRequests = new Gauge({
  name: 'http_active_requests',
  help: 'Number of in-flight HTTP requests',
  registers: [register],
});

export const httpRequestSizeBytes = new Histogram({
  name: 'http_request_size_bytes',
  help: 'HTTP request body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [100, 1000, 10000, 100000, 1000000],
  registers: [register],
});

export const httpResponseSizeBytes = new Histogram({
  name: 'http_response_size_bytes',
  help: 'HTTP response body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [100, 1000, 10000, 100000, 1000000],
  registers: [register],
});

// --- Auth metrics ---

export const authFailuresTotal = new Counter({
  name: 'auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['reason'] as const,
  registers: [register],
});

// --- Business metric gauges ---

export const driversTotal = new Gauge({
  name: 'drivers_total',
  help: 'Total registered drivers',
  registers: [register],
});

export const driversActive = new Gauge({
  name: 'drivers_active',
  help: 'Drivers with a session in the last 30 days',
  registers: [register],
});

export const stationsTotal = new Gauge({
  name: 'stations_total',
  help: 'Total charging stations',
  labelNames: ['is_online'] as const,
  registers: [register],
});

export const connectorsTotal = new Gauge({
  name: 'connectors_total',
  help: 'Total connectors by status',
  labelNames: ['status'] as const,
  registers: [register],
});

export const sessionsActive = new Gauge({
  name: 'sessions_active',
  help: 'Currently active charging sessions',
  registers: [register],
});

export const sessionsByStatus = new Gauge({
  name: 'sessions_by_status',
  help: 'Total sessions by status',
  labelNames: ['status'] as const,
  registers: [register],
});

export const sessionsByHour = new Gauge({
  name: 'sessions_by_hour',
  help: 'Average active sessions by hour of day (last 30 days)',
  labelNames: ['hour'] as const,
  registers: [register],
});

export const energyDeliveredWhTotal = new Gauge({
  name: 'energy_delivered_wh_total',
  help: 'Total energy delivered in watt-hours (completed sessions)',
  registers: [register],
});

export const revenueCentsTotal = new Gauge({
  name: 'revenue_cents_total',
  help: 'Total revenue in cents (completed sessions)',
  registers: [register],
});

export const reservationsByStatus = new Gauge({
  name: 'reservations_by_status',
  help: 'Total reservations by status',
  labelNames: ['status'] as const,
  registers: [register],
});

export const supportCasesOpen = new Gauge({
  name: 'support_cases_open',
  help: 'Open support cases',
  registers: [register],
});

export const sitesTotal = new Gauge({
  name: 'sites_total',
  help: 'Total sites',
  registers: [register],
});

export const fleetsTotal = new Gauge({
  name: 'fleets_total',
  help: 'Total fleets',
  registers: [register],
});

export const tariffsActive = new Gauge({
  name: 'tariffs_active',
  help: 'Active pricing tariffs',
  registers: [register],
});

export const avgSessionKwh = new Gauge({
  name: 'avg_session_kwh',
  help: 'Rolling average kWh per completed session (last 30 days)',
  registers: [register],
});

export const avgSessionDurationSeconds = new Gauge({
  name: 'avg_session_duration_seconds',
  help: 'Rolling average session duration in seconds (last 30 days)',
  registers: [register],
});

export const idleSessionsActive = new Gauge({
  name: 'idle_sessions_active',
  help: 'Sessions currently in idle state',
  registers: [register],
});

export const firmwareUpdatesPending = new Gauge({
  name: 'firmware_updates_pending',
  help: 'Stations with pending firmware updates',
  registers: [register],
});

export const ocppTransactionsByTrigger = new Gauge({
  name: 'ocpp_transactions_by_trigger',
  help: 'OCPP transaction events by trigger reason (last 24h)',
  labelNames: ['trigger_reason'] as const,
  registers: [register],
});

export const paymentsByStatus = new Gauge({
  name: 'payments_by_status',
  help: 'Payment records by status',
  labelNames: ['status'] as const,
  registers: [register],
});

// --- OCPP server health (from ping monitor) ---

export const ocppConnectedStations = new Gauge({
  name: 'ocpp_connected_stations',
  help: 'Number of stations connected via WebSocket',
  registers: [register],
});

export const ocppPingLatencyAvgMs = new Gauge({
  name: 'ocpp_ping_latency_avg_ms',
  help: 'Average WebSocket ping latency in milliseconds',
  registers: [register],
});

export const ocppPingLatencyMaxMs = new Gauge({
  name: 'ocpp_ping_latency_max_ms',
  help: 'Maximum WebSocket ping latency in milliseconds',
  registers: [register],
});

export const ocppPingSuccessRate = new Gauge({
  name: 'ocpp_ping_success_rate',
  help: 'WebSocket ping/pong success rate (percentage)',
  registers: [register],
});

export const ocppHeartbeatsTotal = new Gauge({
  name: 'ocpp_heartbeats_total',
  help: 'OCPP heartbeat messages received in last 24h',
  registers: [register],
});

export { register };

// --- HTTP metrics Fastify hooks ---

export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    httpActiveRequests.inc();
    (request as unknown as Record<string, unknown>)['_metricsStart'] = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    httpActiveRequests.dec();
    const start = (request as unknown as Record<string, unknown>)['_metricsStart'] as
      | bigint
      | undefined;
    if (start == null) {
      done();
      return;
    }

    const durationNs = Number(process.hrtime.bigint() - start);
    const durationS = durationNs / 1e9;

    const route = request.routeOptions.url ?? request.url;
    const method = request.method;
    const statusCode = String(reply.statusCode);

    httpRequestDuration.observe({ method, route, status_code: statusCode }, durationS);
    httpRequestsTotal.inc({ method, route, status_code: statusCode });

    const reqSize = request.headers['content-length'];
    if (reqSize != null) {
      httpRequestSizeBytes.observe({ method, route }, Number(reqSize));
    }

    const resSize = reply.getHeader('content-length');
    if (resSize != null) {
      httpResponseSizeBytes.observe({ method, route }, Number(resSize));
    }
    done();
  });
}

// --- Metrics HTTP server ---

let metricsServer: Server | null = null;

export function startMetricsServer(port: number): void {
  metricsServer = createServer((_req, res) => {
    register
      .metrics()
      .then((metrics) => {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(metrics);
      })
      .catch((err: unknown) => {
        res.writeHead(500);
        res.end('Error collecting metrics');
        logger.error(err, 'Failed to collect metrics');
      });
  });

  metricsServer.listen(port, '0.0.0.0', () => {
    logger.info('Metrics server listening on port %d', port);
  });
}

export async function stopMetricsServer(): Promise<void> {
  if (metricsServer == null) return;
  return new Promise((resolve) => {
    metricsServer?.close(() => {
      resolve();
    });
  });
}
