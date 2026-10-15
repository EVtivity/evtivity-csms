// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  numeric,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sites, loadAllocationStrategyEnum } from './assets.js';
import { createId } from '../lib/id.js';

export const panels = pgTable(
  'panels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('panel')),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    parentPanelId: text('parent_panel_id'),
    name: varchar('name', { length: 255 }).notNull(),
    breakerRatingAmps: integer('breaker_rating_amps').notNull(),
    voltageV: integer('voltage_v').notNull().default(240),
    phases: integer('phases').notNull().default(1),
    // Phases of a three-phase parent panel that feed this single-phase
    // sub-panel (L1, L2, L3, L1L2, L1L3, L2L3). Null: unknown, its load counts
    // in full on every phase of the parent.
    phaseConnections: varchar('phase_connections', { length: 10 }),
    maxContinuousKw: numeric('max_continuous_kw').notNull(),
    safetyMarginKw: numeric('safety_margin_kw').notNull().default('0'),
    oversubscriptionRatio: numeric('oversubscription_ratio').notNull().default('1.0'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_panels_site').on(table.siteId),
    index('idx_panels_parent').on(table.parentPanelId),
    check(
      'panels_phase_connections_check',
      sql`${table.phaseConnections} IS NULL OR ${table.phaseConnections} IN ('L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3')`,
    ),
  ],
);

export const circuits = pgTable(
  'circuits',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('circuit')),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    breakerRatingAmps: integer('breaker_rating_amps').notNull(),
    maxContinuousKw: numeric('max_continuous_kw').notNull(),
    phaseConnections: varchar('phase_connections', { length: 10 }),
    // Voltage of the circuit when it differs from its single-phase panel (a
    // 120 V branch of a 240 V split-phase panel). Null: the panel voltage.
    voltageV: integer('voltage_v'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_circuits_panel').on(table.panelId),
    check(
      'circuits_voltage_v_check',
      sql`${table.voltageV} IS NULL OR ${table.voltageV} IN (120, 208, 220, 230, 240, 277, 480)`,
    ),
  ],
);

export const unmanagedLoads = pgTable(
  'unmanaged_loads',
  {
    id: serial('id').primaryKey(),
    panelId: text('panel_id').references(() => panels.id, { onDelete: 'cascade' }),
    circuitId: text('circuit_id').references(() => circuits.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    estimatedDrawKw: numeric('estimated_draw_kw').notNull(),
    meterDeviceId: text('meter_device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_unmanaged_loads_panel').on(table.panelId),
    index('idx_unmanaged_loads_circuit').on(table.circuitId),
  ],
);

export const siteLoadManagement = pgTable('site_load_management', {
  id: serial('id').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' })
    .unique(),
  strategy: loadAllocationStrategyEnum('strategy').notNull().default('equal_share'),
  isEnabled: boolean('is_enabled').notNull().default(false),
  // The allocations last sent to the stations (and the reservations kept for
  // offline stations), shared by every worker process: the next cycle sends
  // again only when they change, when they are older than the refresh
  // interval, or when a send failed (appliedAt null). A config change nulls
  // both so the next cycle sends.
  appliedAllocations: jsonb('applied_allocations'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const loadAllocationLog = pgTable(
  'load_allocation_log',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    siteLimitKw: numeric('site_limit_kw').notNull(),
    totalDrawKw: numeric('total_draw_kw').notNull(),
    availableKw: numeric('available_kw').notNull(),
    strategy: varchar('strategy', { length: 50 }).notNull(),
    allocations: jsonb('allocations').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_load_alloc_log_site').on(table.siteId),
    index('idx_load_alloc_log_created').on(table.createdAt),
  ],
);
