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
} from 'drizzle-orm/pg-core';
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
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_circuits_panel').on(table.panelId)],
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
