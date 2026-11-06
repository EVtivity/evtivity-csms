// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@evtivity/lib';

// Created with the server: modules that count (storage, the depot interface) import this file,
// and their tests mock @evtivity/lib without a logger.
let logger: ReturnType<typeof createLogger> | null = null;

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
  help: 'Failed sign-ins: operator and driver password, MFA, passkey and SSO steps, and API keys',
  labelNames: ['realm', 'method', 'reason'] as const,
  registers: [register],
});

/** Who failed to sign in: an operator (CSMS user or API key) or a driver (portal or app). */
export type AuthFailureRealm = 'operator' | 'driver';

/**
 * How the failed sign-in tried to prove its identity: the auth audit methods, and
 * `api_key` for an API key. A fixed list, so a caller cannot pass request text.
 */
export const AUTH_FAILURE_METHODS = [
  'password',
  'mfa',
  'recovery_code',
  'webauthn',
  'passkey',
  'mfa_enrollment',
  'sso',
  'reset_token',
  'verification_token',
  'api_key',
] as const;
export type AuthFailureMethod = (typeof AUTH_FAILURE_METHODS)[number];

/**
 * Why a sign-in failed: the auth audit reasons and the API key reasons. A fixed list,
 * so the label values stay bounded; `unknown` stands for a failure without a reason.
 */
export const AUTH_FAILURE_REASONS = [
  'unknown',
  'unknown_account',
  'bad_password',
  'inactive',
  'locked',
  'device_locked',
  'no_portal_access',
  'reset_not_required',
  'sso_account',
  'sso_link_required',
  'sso_subject_mismatch',
  'domain_not_allowed',
  'mfa_code_invalid',
  'mfa_challenge_exhausted',
  'mfa_method_disabled',
  'mfa_policy_unavailable',
  'mfa_setup_unavailable',
  'mfa_enrollment_required',
  'mfa_factor_unsupported',
  'webauthn_unknown_credential',
  'webauthn_verification_failed',
  'api_key_expired',
  'api_key_invalid',
] as const;
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

/**
 * Counts one failed sign-in. `method` and `reason` are typed to the fixed lists above,
 * never request text, so the label values stay bounded. Fail-open: a metrics error
 * never fails a sign-in.
 */
export function countAuthFailure(
  realm: AuthFailureRealm,
  method: AuthFailureMethod,
  reason: AuthFailureReason,
): void {
  try {
    authFailuresTotal.inc({ realm, method, reason });
  } catch (err) {
    logger?.warn({ err }, 'auth failure metric failed');
  }
}

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
  help: 'Total charging stations, conformance test stations excluded',
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
  help: 'Total revenue in cents including tax (ended sessions and reservation fees, minus refunds), labelled with the company currency',
  labelNames: ['currency'] as const,
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

// --- OCPP server health (from the ping monitor rows, one per OCPP process) ---
// Fleet values over every live OCPP process. Each API task exports the same
// values, so dashboards aggregate them across API tasks with max(), not sum().

export const ocppConnectedStations = new Gauge({
  name: 'ocpp_connected_stations',
  help: 'Stations connected via WebSocket, summed over all OCPP processes',
  registers: [register],
});

export const ocppPingLatencyAvgMs = new Gauge({
  name: 'ocpp_ping_latency_avg_ms',
  help: 'Average WebSocket ping latency in milliseconds over all OCPP processes, weighted by connected stations',
  registers: [register],
});

export const ocppPingLatencyMaxMs = new Gauge({
  name: 'ocpp_ping_latency_max_ms',
  help: 'Maximum WebSocket ping latency in milliseconds over all OCPP processes',
  registers: [register],
});

export const ocppPingSuccessRate = new Gauge({
  name: 'ocpp_ping_success_rate',
  help: 'WebSocket ping/pong success rate (percentage) over all OCPP processes',
  registers: [register],
});

export const ocppInstances = new Gauge({
  name: 'ocpp_instances',
  help: 'OCPP processes with a fresh health row',
  registers: [register],
});

export const ocppInstanceConnectedStations = new Gauge({
  name: 'ocpp_instance_connected_stations',
  help: 'Stations connected via WebSocket to one OCPP process',
  labelNames: ['ocpp_instance'] as const,
  registers: [register],
});

export const ocppHeartbeatsTotal = new Gauge({
  name: 'ocpp_heartbeats_total',
  help: 'OCPP heartbeat messages received in last 24h',
  registers: [register],
});

// --- Worker jobs and crons (from worker_job_logs and cronjobs) ---
// The worker exposes no metrics endpoint; every queue job and cron writes a
// worker_job_logs row, so the API collector reads them. Same value on every
// API task: aggregate with max().

export const workerJobsLastHour = new Gauge({
  name: 'worker_jobs_last_hour',
  help: 'Worker queue jobs and crons started in the last hour, by queue and status',
  labelNames: ['queue', 'status'] as const,
  registers: [register],
});

export const workerJobDurationAvgMs = new Gauge({
  name: 'worker_job_duration_avg_ms',
  help: 'Average duration of the worker jobs that ended in the last 15 minutes, by queue',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const workerJobDurationMaxMs = new Gauge({
  name: 'worker_job_duration_max_ms',
  help: 'Longest worker job that ended in the last 15 minutes, by queue',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const cronJobLastFailed = new Gauge({
  name: 'cron_job_last_failed',
  help: '1 when the last run of the cron job failed, else 0',
  labelNames: ['name'] as const,
  registers: [register],
});

// --- Load management (from site_load_management and load_allocation_log) ---

export const loadManagementSitesEnabled = new Gauge({
  name: 'load_management_sites_enabled',
  help: 'Sites with load management on',
  registers: [register],
});

export const loadManagementSitesOverCapacity = new Gauge({
  name: 'load_management_sites_over_capacity',
  help: 'Sites with load management on whose last allocation measured a draw above the site capacity',
  registers: [register],
});

export const loadManagementAppliedAgeMaxSeconds = new Gauge({
  name: 'load_management_applied_age_max_seconds',
  help: 'Oldest time since a site with load management on last sent its limits (a cycle sends at least every 5 minutes)',
  registers: [register],
});

export const loadManagementSitesSendFailed = new Gauge({
  name: 'load_management_sites_send_failed',
  help: 'Sites with load management on whose last limit send failed (sent again by the next cycle)',
  registers: [register],
});

export const loadManagementSupplyCreditKw = new Gauge({
  name: 'load_management_supply_credit_kw',
  help: 'Battery and solar supply credited in the last allocation of every site with load management on, kW',
  registers: [register],
});

// --- Route-aware charging (from vehicle_departures and site_charging_plans) ---

export const departuresScheduled = new Gauge({
  name: 'departures_scheduled',
  help: 'Scheduled departures by readiness (unplanned when the planner has not rated it)',
  labelNames: ['readiness'] as const,
  registers: [register],
});

export const departureNoticesLastHour = new Gauge({
  name: 'departure_notices_last_hour',
  help: 'Departure at risk and missed notices sent in the last hour',
  labelNames: ['kind'] as const,
  registers: [register],
});

export const departuresCompletedLast24h = new Gauge({
  name: 'departures_completed_last_24h',
  help: 'Departures completed in the last 24 hours by outcome',
  labelNames: ['outcome'] as const,
  registers: [register],
});

export const chargingPlansStale = new Gauge({
  name: 'charging_plans_stale',
  help: 'Depot charging plans marked stale more than a minute ago and not planned again',
  registers: [register],
});

export const chargingPlanStalenessMaxSeconds = new Gauge({
  name: 'charging_plan_staleness_max_seconds',
  help: 'Longest time a depot charging plan has been waiting to be planned again',
  registers: [register],
});

export const chargingPlanRuntimeMaxMs = new Gauge({
  name: 'charging_plan_runtime_max_ms',
  help: 'Longest depot charging plan run of the plans computed in the last hour',
  registers: [register],
});

// --- Batteries and solar (from site_energy_assets and energy_asset_readings) ---

export const energyAssetsTotal = new Gauge({
  name: 'energy_assets_total',
  help: 'Site batteries and solar arrays by type',
  labelNames: ['type'] as const,
  registers: [register],
});

export const energyAssetsReadingStale = new Gauge({
  name: 'energy_assets_reading_stale',
  help: 'Connected batteries and solar arrays with API telemetry whose reading is missing or past its lifetime (no supply credit; simulated readings are computed in each cycle and never stale)',
  labelNames: ['type'] as const,
  registers: [register],
});

// --- Bus depot interface (VDV 463) ---

export const depotInterfaceEnabled = new Gauge({
  name: 'depot_interface_enabled',
  help: '1 while the bus depot interface switch (vdv463.enabled) is on, else 0',
  registers: [register],
});

export const depotSystemsEnabled = new Gauge({
  name: 'depot_systems_enabled',
  help: 'Bus depot systems turned on',
  registers: [register],
});

export const depotSystemsAuthLocked = new Gauge({
  name: 'depot_systems_auth_locked',
  help: 'Bus depot systems whose sign-in is locked after too many wrong passwords',
  registers: [register],
});

export const depotSystemRefusedRequests = new Gauge({
  name: 'depot_system_refused_requests',
  help: 'Charging requests of the last lists of every bus depot system that were refused, by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

/** Live connections on this API process; sum over the API tasks. */
export const depotSystemConnections = new Gauge({
  name: 'depot_system_connections',
  help: 'Bus depot system WebSocket connections on this API process',
  registers: [register],
});

export const depotSystemSignInsTotal = new Counter({
  name: 'depot_system_sign_ins_total',
  help: 'Bus depot system sign-in attempts on this API process by result',
  labelNames: ['result'] as const,
  registers: [register],
});

export const depotSystemAuthLocksTotal = new Counter({
  name: 'depot_system_auth_locks_total',
  help: 'Bus depot system sign-in locks on this API process (scope address or system)',
  labelNames: ['scope'] as const,
  registers: [register],
});

export const depotSystemRequestListsTotal = new Counter({
  name: 'depot_system_request_lists_total',
  help: 'Bus depot system charging request lists on this API process by result (applied, failed, recheck_failed)',
  labelNames: ['result'] as const,
  registers: [register],
});

// --- Object storage ---

export const storageOperationsTotal = new Counter({
  name: 'storage_operations_total',
  help: 'Object storage calls on this API process by operation, provider and result',
  labelNames: ['operation', 'provider', 'result'] as const,
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
  logger ??= createLogger('metrics');
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
        logger?.error(err, 'Failed to collect metrics');
      });
  });

  metricsServer.listen(port, '0.0.0.0', () => {
    logger?.info('Metrics server listening on port %d', port);
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
