// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  text,
  date,
  integer,
  bigint,
  numeric,
  varchar,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// Daily per-site operational snapshot. Money lives in dashboard_snapshot_revenue.
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

// Money for a dashboard snapshot, one row per currency. Amounts in different
// currencies are never added, so they cannot live on dashboard_snapshots.
// Revenue and transactions come from captured payments (payment currency).
// Sessions and electricity cost come from charging sessions (tariff currency,
// else the company currency).
export const dashboardSnapshotRevenue = pgTable(
  'dashboard_snapshot_revenue',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    totalRevenueCents: bigint('total_revenue_cents', { mode: 'number' }).notNull().default(0),
    dayRevenueCents: bigint('day_revenue_cents', { mode: 'number' }).notNull().default(0),
    totalSessions: integer('total_sessions').notNull().default(0),
    totalElectricityCostCents: bigint('total_electricity_cost_cents', { mode: 'number' })
      .notNull()
      .default(0),
    dayElectricityCostCents: bigint('day_electricity_cost_cents', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_dashboard_snapshot_revenue_site_date_currency').on(
      table.siteId,
      table.snapshotDate,
      table.currency,
    ),
    index('idx_dashboard_snapshot_revenue_date').on(table.snapshotDate),
  ],
);
