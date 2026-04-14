// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import {
  driversTotal,
  driversActive,
  stationsTotal,
  connectorsTotal,
  sessionsActive,
  sessionsByStatus,
  sessionsByHour,
  energyDeliveredWhTotal,
  revenueCentsTotal,
  reservationsByStatus,
  supportCasesOpen,
  sitesTotal,
  fleetsTotal,
  tariffsActive,
  avgSessionKwh,
  avgSessionDurationSeconds,
  idleSessionsActive,
  firmwareUpdatesPending,
  ocppTransactionsByTrigger,
  paymentsByStatus,
  ocppConnectedStations,
  ocppPingLatencyAvgMs,
  ocppPingLatencyMaxMs,
  ocppPingSuccessRate,
  ocppHeartbeatsTotal,
} from '../plugins/metrics.js';

const logger = createLogger('metrics-collector');

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function collectBusinessMetrics(): Promise<void> {
  try {
    const [
      driverRows,
      activeDriverRows,
      stationRows,
      connectorRows,
      activeSessionRows,
      sessionStatusRows,
      sessionHourRows,
      energyRows,
      revenueRows,
      reservationRows,
      supportRows,
      siteRows,
      fleetRows,
      tariffRows,
      avgRows,
      idleRows,
      firmwareRows,
      txEventRows,
      paymentRows,
      ocppHealthRows,
      heartbeatRows,
    ] = await Promise.all([
      // Total drivers
      db.execute(sql`SELECT count(*)::int AS count FROM drivers`),

      // Active drivers (session in last 30 days)
      db.execute(sql`
        SELECT count(DISTINCT driver_id)::int AS count
        FROM charging_sessions
        WHERE started_at >= NOW() - INTERVAL '30 days'
          AND driver_id IS NOT NULL
      `),

      // Stations by online status
      db.execute(sql`
        SELECT is_online::text AS is_online, count(*)::int AS count
        FROM charging_stations
        GROUP BY is_online
      `),

      // Connectors by status
      db.execute(sql`
        SELECT status, count(*)::int AS count
        FROM connectors
        GROUP BY status
      `),

      // Active sessions
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM charging_sessions
        WHERE status = 'active'
      `),

      // Sessions by status
      db.execute(sql`
        SELECT status, count(*)::int AS count
        FROM charging_sessions
        GROUP BY status
      `),

      // Average sessions by hour of day (last 30 days)
      db.execute(sql`
        SELECT
          EXTRACT(HOUR FROM started_at)::int AS hour,
          (count(*)::float / 30)::float AS avg_count
        FROM charging_sessions
        WHERE started_at >= NOW() - INTERVAL '30 days'
        GROUP BY EXTRACT(HOUR FROM started_at)
      `),

      // Total energy delivered (completed sessions)
      db.execute(sql`
        SELECT COALESCE(SUM(energy_delivered_wh), 0)::bigint AS total
        FROM charging_sessions
        WHERE status = 'completed'
      `),

      // Total revenue (completed sessions)
      db.execute(sql`
        SELECT COALESCE(SUM(final_cost_cents), 0)::bigint AS total
        FROM charging_sessions
        WHERE status = 'completed'
      `),

      // Reservations by status
      db.execute(sql`
        SELECT status, count(*)::int AS count
        FROM reservations
        GROUP BY status
      `),

      // Open support cases
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM support_cases
        WHERE status IN ('open', 'in_progress', 'waiting_on_driver')
      `),

      // Total sites
      db.execute(sql`SELECT count(*)::int AS count FROM sites`),

      // Total fleets
      db.execute(sql`SELECT count(*)::int AS count FROM fleets`),

      // Active tariffs
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM tariffs
        WHERE is_active = true
      `),

      // Average session kWh and duration (last 30 days, completed)
      db.execute(sql`
        SELECT
          COALESCE(AVG(energy_delivered_wh) / 1000.0, 0)::float AS avg_kwh,
          COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at))), 0)::float AS avg_duration_seconds
        FROM charging_sessions
        WHERE status = 'completed'
          AND started_at >= NOW() - INTERVAL '30 days'
          AND ended_at IS NOT NULL
      `),

      // Idle sessions
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM charging_sessions
        WHERE status = 'active'
          AND idle_started_at IS NOT NULL
      `),

      // Firmware updates pending
      db.execute(sql`
        SELECT count(DISTINCT fcs.station_id)::int AS count
        FROM firmware_campaign_stations fcs
        INNER JOIN firmware_campaigns fc ON fc.id = fcs.campaign_id
        WHERE fc.status = 'active'
          AND fcs.status IN ('pending', 'downloading')
      `),

      // Transaction events by trigger reason (last 24h)
      db.execute(sql`
        SELECT trigger_reason, count(*)::int AS count
        FROM transaction_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND trigger_reason IS NOT NULL
        GROUP BY trigger_reason
      `),

      // Payments by status
      db.execute(sql`
        SELECT status, count(*)::int AS count
        FROM payment_records
        GROUP BY status
      `),

      // OCPP server health (ping monitor snapshot)
      db.execute(sql`
        SELECT connected_stations, avg_ping_latency_ms, max_ping_latency_ms,
               ping_success_rate, total_pings_sent, total_pongs_received
        FROM ocpp_server_health
        WHERE id = 'singleton'
      `),

      // Total heartbeats received (last 24h)
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM domain_events
        WHERE event_type = 'ocpp.Heartbeat'
          AND occurred_at >= NOW() - INTERVAL '24 hours'
      `),
    ]);

    // Set gauges
    driversTotal.set(asInt(driverRows, 'count'));
    driversActive.set(asInt(activeDriverRows, 'count'));

    stationsTotal.reset();
    for (const row of asRows(stationRows)) {
      stationsTotal.set({ is_online: String(row['is_online']) }, asNum(row, 'count'));
    }

    connectorsTotal.reset();
    for (const row of asRows(connectorRows)) {
      connectorsTotal.set({ status: String(row['status']) }, asNum(row, 'count'));
    }

    sessionsActive.set(asInt(activeSessionRows, 'count'));

    sessionsByStatus.reset();
    for (const row of asRows(sessionStatusRows)) {
      sessionsByStatus.set({ status: String(row['status']) }, asNum(row, 'count'));
    }

    sessionsByHour.reset();
    for (const row of asRows(sessionHourRows)) {
      sessionsByHour.set({ hour: String(row['hour']) }, asFloat(row, 'avg_count'));
    }

    energyDeliveredWhTotal.set(asBigInt(energyRows, 'total'));
    revenueCentsTotal.set(asBigInt(revenueRows, 'total'));

    reservationsByStatus.reset();
    for (const row of asRows(reservationRows)) {
      reservationsByStatus.set({ status: String(row['status']) }, asNum(row, 'count'));
    }

    supportCasesOpen.set(asInt(supportRows, 'count'));
    sitesTotal.set(asInt(siteRows, 'count'));
    fleetsTotal.set(asInt(fleetRows, 'count'));
    tariffsActive.set(asInt(tariffRows, 'count'));

    const avgRow = asRows(avgRows)[0];
    if (avgRow != null) {
      avgSessionKwh.set(asFloat(avgRow, 'avg_kwh'));
      avgSessionDurationSeconds.set(asFloat(avgRow, 'avg_duration_seconds'));
    }

    idleSessionsActive.set(asInt(idleRows, 'count'));
    firmwareUpdatesPending.set(asInt(firmwareRows, 'count'));

    ocppTransactionsByTrigger.reset();
    for (const row of asRows(txEventRows)) {
      ocppTransactionsByTrigger.set(
        { trigger_reason: String(row['trigger_reason']) },
        asNum(row, 'count'),
      );
    }

    paymentsByStatus.reset();
    for (const row of asRows(paymentRows)) {
      paymentsByStatus.set({ status: String(row['status']) }, asNum(row, 'count'));
    }

    // OCPP server health
    const healthRow = asRows(ocppHealthRows)[0];
    if (healthRow != null) {
      ocppConnectedStations.set(asNum(healthRow, 'connected_stations'));
      ocppPingLatencyAvgMs.set(asFloat(healthRow, 'avg_ping_latency_ms'));
      ocppPingLatencyMaxMs.set(asFloat(healthRow, 'max_ping_latency_ms'));
      ocppPingSuccessRate.set(asFloat(healthRow, 'ping_success_rate'));
    }

    ocppHeartbeatsTotal.set(asInt(heartbeatRows, 'count'));
  } catch (err) {
    logger.error(err, 'Failed to collect business metrics');
  }
}

// Helpers for safe value extraction from raw SQL results
function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return [];
}

function asInt(result: unknown, key: string): number {
  const rows = asRows(result);
  const val = rows[0]?.[key];
  return typeof val === 'number' ? val : Number(val) || 0;
}

function asFloat(row: Record<string, unknown>, key: string): number {
  const val = row[key];
  return typeof val === 'number' ? val : Number(val) || 0;
}

function asBigInt(result: unknown, key: string): number {
  const rows = asRows(result);
  const val = rows[0]?.[key];
  return Number(val) || 0;
}

function asNum(row: Record<string, unknown>, key: string): number {
  const val = row[key];
  return typeof val === 'number' ? val : Number(val) || 0;
}

export function startMetricsCollector(intervalMs = 60_000): void {
  collectBusinessMetrics().catch(() => {});
  intervalHandle = setInterval(() => {
    collectBusinessMetrics().catch(() => {});
  }, intervalMs);
}

export function stopMetricsCollector(): void {
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
