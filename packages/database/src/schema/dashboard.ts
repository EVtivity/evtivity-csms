// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  text,
  date,
  integer,
  numeric,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';

export const dashboardSnapshots = pgTable(
  'dashboard_snapshots',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    totalStations: integer('total_stations'),
    onlineStations: integer('online_stations'),
    onlinePercent: numeric('online_percent'),
    uptimePercent: numeric('uptime_percent'),
    activeSessions: integer('active_sessions'),
    totalEnergyWh: numeric('total_energy_wh'),
    dayEnergyWh: numeric('day_energy_wh'),
    totalSessions: integer('total_sessions'),
    daySessions: integer('day_sessions'),
    connectedStations: integer('connected_stations'),
    totalRevenueCents: integer('total_revenue_cents'),
    dayRevenueCents: integer('day_revenue_cents'),
    avgRevenueCentsPerSession: integer('avg_revenue_cents_per_session'),
    totalTransactions: integer('total_transactions'),
    dayTransactions: integer('day_transactions'),
    totalPorts: integer('total_ports'),
    stationsBelowThreshold: integer('stations_below_threshold'),
    avgPingLatencyMs: numeric('avg_ping_latency_ms'),
    pingSuccessRate: numeric('ping_success_rate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_dashboard_snapshots_site_date').on(table.siteId, table.snapshotDate),
    index('idx_dashboard_snapshots_date').on(table.snapshotDate),
  ],
);
