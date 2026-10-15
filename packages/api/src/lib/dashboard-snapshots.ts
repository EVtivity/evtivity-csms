// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { db, getCompanyCurrency } from '@evtivity/database';
import { requestHasPermission } from '../middleware/rbac.js';
import { getUserSiteIds } from './site-access.js';
import type { JwtPayload } from '../plugins/auth.js';

/** An aggregated dashboard snapshot (one date, or the average of a date range). */
export interface Snapshot {
  hasData: boolean;
  totalStations: number;
  onlineStations: number;
  onlinePercent: number;
  uptimePercent: number;
  activeSessions: number;
  totalEnergyWh: number;
  dayEnergyWh: number;
  totalSessions: number;
  daySessions: number;
  connectedStations: number;
  totalRevenueCents: number | null;
  dayRevenueCents: number | null;
  avgRevenueCentsPerSession: number | null;
  totalTransactions: number | null;
  dayTransactions: number | null;
  totalPorts: number;
  stationsBelowThreshold: number;
  avgPingLatencyMs: number;
  pingSuccessRate: number;
}

export interface DatedSnapshot extends Snapshot {
  date: string;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  hasData: false,
  totalStations: 0,
  onlineStations: 0,
  onlinePercent: 0,
  uptimePercent: 100,
  activeSessions: 0,
  totalEnergyWh: 0,
  dayEnergyWh: 0,
  totalSessions: 0,
  daySessions: 0,
  connectedStations: 0,
  totalRevenueCents: 0,
  dayRevenueCents: 0,
  avgRevenueCentsPerSession: 0,
  totalTransactions: 0,
  dayTransactions: 0,
  totalPorts: 0,
  stationsBelowThreshold: 0,
  avgPingLatencyMs: 0,
  pingSuccessRate: 100,
};

const MONEY_FIELDS = [
  'totalRevenueCents',
  'dayRevenueCents',
  'avgRevenueCentsPerSession',
  'totalTransactions',
  'dayTransactions',
] as const;

export interface SnapshotScope {
  /** `AND site_id IN (...)` for a site-restricted user, empty for every site. */
  siteFilter: SQL;
  companyCurrency: string;
  /** The snapshot as this user may see it: money fields null without payments:read. */
  present: <T extends Snapshot>(snapshot: T) => T;
}

/** The snapshot scope of the request user, or null when the user has no site. */
export async function snapshotScope(request: FastifyRequest): Promise<SnapshotScope | null> {
  const { userId } = request.user as JwtPayload;
  const [siteIds, companyCurrency, seesMoney] = await Promise.all([
    getUserSiteIds(userId),
    getCompanyCurrency(),
    requestHasPermission(request, 'payments:read'),
  ]);
  if (siteIds != null && siteIds.length === 0) return null;
  const siteFilter =
    siteIds != null
      ? sql`AND site_id IN (${sql.join(
          siteIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  return {
    siteFilter,
    companyCurrency,
    present: (snapshot) => {
      if (seesMoney) return snapshot;
      const hidden = { ...snapshot };
      for (const field of MONEY_FIELDS) hidden[field] = null;
      return hidden;
    },
  };
}

interface DayRow {
  date: string;
  total_stations: string;
  online_stations: string;
  online_percent: string;
  uptime_percent: string;
  active_sessions: string;
  total_energy_wh: string;
  day_energy_wh: string;
  total_sessions: string;
  day_sessions: string;
  connected_stations: string;
  total_revenue_cents: string;
  day_revenue_cents: string;
  session_revenue_cents: string | null;
  billed_sessions: string | null;
  legacy_avg_revenue: string | null;
  total_transactions: string;
  day_transactions: string;
  total_ports: string;
  stations_below_threshold: string;
  avg_ping_latency_ms: string;
  ping_success_rate: string;
}

/**
 * Snapshot rows of the scope summed per date (oldest first): counts and money
 * summed over sites, percentages weighted by station count, money only for
 * rows in the company currency. Revenue per session is the billed session
 * revenue over the billed sessions, as the live figure; rows written before
 * v0.1.46 have no billed count and use their stored per-site average.
 */
export async function querySnapshotDays(
  scope: SnapshotScope,
  dateFilter: SQL,
): Promise<DatedSnapshot[]> {
  const billed = sql`upper(currency) = ${scope.companyCurrency}`;
  const rows = await db.execute<DayRow & Record<string, unknown>>(sql`
    SELECT
      snapshot_date::text AS date,
      COALESCE(SUM(total_stations), 0) AS total_stations,
      COALESCE(SUM(online_stations), 0) AS online_stations,
      CASE WHEN SUM(total_stations) > 0
        THEN SUM(online_percent::numeric * total_stations) / SUM(total_stations)
        ELSE 0
      END AS online_percent,
      CASE WHEN SUM(total_stations) > 0
        THEN SUM(uptime_percent::numeric * total_stations) / SUM(total_stations)
        ELSE COALESCE(AVG(uptime_percent::numeric), 100)
      END AS uptime_percent,
      COALESCE(SUM(active_sessions), 0) AS active_sessions,
      COALESCE(SUM(total_energy_wh::numeric), 0) AS total_energy_wh,
      COALESCE(SUM(day_energy_wh::numeric), 0) AS day_energy_wh,
      COALESCE(SUM(total_sessions), 0) AS total_sessions,
      COALESCE(SUM(day_sessions), 0) AS day_sessions,
      COALESCE(SUM(connected_stations), 0) AS connected_stations,
      COALESCE(SUM(total_revenue_cents) FILTER (WHERE ${billed}), 0) AS total_revenue_cents,
      COALESCE(SUM(day_revenue_cents) FILTER (WHERE ${billed}), 0) AS day_revenue_cents,
      SUM(session_revenue_cents) FILTER (WHERE ${billed} AND billed_sessions IS NOT NULL) AS session_revenue_cents,
      SUM(billed_sessions) FILTER (WHERE ${billed} AND billed_sessions IS NOT NULL) AS billed_sessions,
      AVG(avg_revenue_cents_per_session) FILTER (WHERE ${billed} AND billed_sessions IS NULL) AS legacy_avg_revenue,
      COALESCE(SUM(total_transactions) FILTER (WHERE ${billed}), 0) AS total_transactions,
      COALESCE(SUM(day_transactions) FILTER (WHERE ${billed}), 0) AS day_transactions,
      COALESCE(SUM(total_ports), 0) AS total_ports,
      COALESCE(SUM(stations_below_threshold), 0) AS stations_below_threshold,
      CASE WHEN SUM(total_stations) > 0
        THEN SUM(avg_ping_latency_ms::numeric * total_stations) / SUM(total_stations)
        ELSE COALESCE(AVG(avg_ping_latency_ms::numeric), 0)
      END AS avg_ping_latency_ms,
      CASE WHEN SUM(total_stations) > 0
        THEN SUM(ping_success_rate::numeric * total_stations) / SUM(total_stations)
        ELSE COALESCE(AVG(ping_success_rate::numeric), 100)
      END AS ping_success_rate
    FROM dashboard_snapshots
    WHERE ${dateFilter} ${scope.siteFilter}
    GROUP BY snapshot_date
    ORDER BY snapshot_date
  `);
  return rows.map((r) => {
    const billedSessions = Number(r.billed_sessions ?? 0);
    const avgRevenue =
      billedSessions > 0
        ? Number(r.session_revenue_cents ?? 0) / billedSessions
        : Number(r.legacy_avg_revenue ?? 0);
    return roundSnapshot({
      date: r.date,
      hasData: true,
      totalStations: Number(r.total_stations),
      onlineStations: Number(r.online_stations),
      onlinePercent: Number(r.online_percent),
      uptimePercent: Number(r.uptime_percent),
      activeSessions: Number(r.active_sessions),
      totalEnergyWh: Number(r.total_energy_wh),
      dayEnergyWh: Number(r.day_energy_wh),
      totalSessions: Number(r.total_sessions),
      daySessions: Number(r.day_sessions),
      connectedStations: Number(r.connected_stations),
      totalRevenueCents: Number(r.total_revenue_cents),
      dayRevenueCents: Number(r.day_revenue_cents),
      avgRevenueCentsPerSession: avgRevenue,
      totalTransactions: Number(r.total_transactions),
      dayTransactions: Number(r.day_transactions),
      totalPorts: Number(r.total_ports),
      stationsBelowThreshold: Number(r.stations_below_threshold),
      avgPingLatencyMs: Number(r.avg_ping_latency_ms),
      pingSuccessRate: Number(r.ping_success_rate),
    });
  });
}

function roundSnapshot<T extends Snapshot>(s: T): T {
  const round = (v: number | null): number | null => (v == null ? null : Math.round(v));
  return {
    ...s,
    totalStations: Math.round(s.totalStations),
    onlineStations: Math.round(s.onlineStations),
    onlinePercent: Math.round(s.onlinePercent * 10) / 10,
    uptimePercent: Math.round(s.uptimePercent * 100) / 100,
    activeSessions: Math.round(s.activeSessions),
    totalEnergyWh: Math.round(s.totalEnergyWh),
    dayEnergyWh: Math.round(s.dayEnergyWh),
    totalSessions: Math.round(s.totalSessions),
    daySessions: Math.round(s.daySessions),
    connectedStations: Math.round(s.connectedStations),
    totalRevenueCents: round(s.totalRevenueCents),
    dayRevenueCents: round(s.dayRevenueCents),
    avgRevenueCentsPerSession: round(s.avgRevenueCentsPerSession),
    totalTransactions: round(s.totalTransactions),
    dayTransactions: round(s.dayTransactions),
    totalPorts: Math.round(s.totalPorts),
    stationsBelowThreshold: Math.round(s.stationsBelowThreshold),
    avgPingLatencyMs: Math.round(s.avgPingLatencyMs * 100) / 100,
    pingSuccessRate: Math.round(s.pingSuccessRate * 10) / 10,
  };
}

/** The average of per-day snapshots (a date range), or the empty snapshot when none has data. */
export function averageSnapshotDays(days: readonly DatedSnapshot[]): Snapshot {
  if (days.length === 0) return EMPTY_SNAPSHOT;
  const mean = (pick: (d: DatedSnapshot) => number | null): number =>
    days.reduce((sum, d) => sum + (pick(d) ?? 0), 0) / days.length;
  const average: Snapshot = {
    hasData: true,
    totalStations: mean((d) => d.totalStations),
    onlineStations: mean((d) => d.onlineStations),
    onlinePercent: mean((d) => d.onlinePercent),
    uptimePercent: mean((d) => d.uptimePercent),
    activeSessions: mean((d) => d.activeSessions),
    totalEnergyWh: mean((d) => d.totalEnergyWh),
    dayEnergyWh: mean((d) => d.dayEnergyWh),
    totalSessions: mean((d) => d.totalSessions),
    daySessions: mean((d) => d.daySessions),
    connectedStations: mean((d) => d.connectedStations),
    totalRevenueCents: mean((d) => d.totalRevenueCents),
    dayRevenueCents: mean((d) => d.dayRevenueCents),
    avgRevenueCentsPerSession: mean((d) => d.avgRevenueCentsPerSession),
    totalTransactions: mean((d) => d.totalTransactions),
    dayTransactions: mean((d) => d.dayTransactions),
    totalPorts: mean((d) => d.totalPorts),
    stationsBelowThreshold: mean((d) => d.stationsBelowThreshold),
    avgPingLatencyMs: mean((d) => d.avgPingLatencyMs),
    pingSuccessRate: mean((d) => d.pingSuccessRate),
  };
  return roundSnapshot(average);
}
