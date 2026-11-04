// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  numeric,
  varchar,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TRANSFORMER_KINDS } from '@evtivity/lib/load-allocation';
import {
  ENERGY_ASSET_GRID_CHARGING,
  ENERGY_ASSET_TELEMETRY,
  ENERGY_ASSET_TYPES,
} from '@evtivity/lib/energy-supply';
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
    // The transformer that feeds this panel: the service transformer of a
    // top-level panel, or the step-down transformer between a sub-panel and
    // its parent (whose fed_from_panel_id is the parent). Written only by the
    // load management tree writer, which checks the link.
    transformerId: text('transformer_id').references((): AnyPgColumn => transformers.id, {
      onDelete: 'set null',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_panels_site').on(table.siteId),
    index('idx_panels_parent').on(table.parentPanelId),
    index('idx_panels_transformer').on(table.transformerId),
    check(
      'panels_phase_connections_check',
      sql`${table.phaseConnections} IS NULL OR ${table.phaseConnections} IN ('L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3')`,
    ),
  ],
);

export const transformerKindEnum = pgEnum('transformer_kind', TRANSFORMER_KINDS);

// A transformer of the site's load management tree. `service`: the
// transformer of the site's electrical service above its top-level panels;
// `step_down`: a dry-type unit fed from a panel breaker (fed_from_panel_id)
// that feeds a sub-panel. Its capacity (max_continuous_kw) is rated kVA x
// power factor x loading limit, computed by the tree writer; null while
// unrated, and an unrated transformer cannot be linked.
export const transformers = pgTable(
  'transformers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('transformer')),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    kind: transformerKindEnum('kind').notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    ratedKva: numeric('rated_kva'),
    phases: integer('phases').notNull().default(3),
    secondaryVoltageV: integer('secondary_voltage_v'),
    powerFactor: numeric('power_factor', { precision: 3, scale: 2 }).notNull().default('0.95'),
    loadingLimitPercent: integer('loading_limit_percent').notNull().default(100),
    safetyMarginKw: numeric('safety_margin_kw').notNull().default('0'),
    // A step-down unit goes with the panel that feeds it.
    fedFromPanelId: text('fed_from_panel_id').references((): AnyPgColumn => panels.id, {
      onDelete: 'cascade',
    }),
    maxContinuousKw: numeric('max_continuous_kw'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_transformers_site').on(table.siteId),
    index('idx_transformers_fed_from_panel').on(table.fedFromPanelId),
    check(
      'transformers_kind_feed_check',
      sql`(${table.kind} = 'service') = (${table.fedFromPanelId} IS NULL)`,
    ),
    check(
      'transformers_rated_kva_check',
      sql`${table.ratedKva} IS NULL OR ${table.ratedKva} BETWEEN 1 AND 100000`,
    ),
    check('transformers_phases_check', sql`${table.phases} IN (1, 3)`),
    check(
      'transformers_secondary_voltage_check',
      sql`${table.secondaryVoltageV} IS NULL OR ${table.secondaryVoltageV} IN (120, 208, 220, 230, 240, 277, 480)`,
    ),
    check('transformers_power_factor_check', sql`${table.powerFactor} BETWEEN 0.80 AND 1.00`),
    check('transformers_loading_limit_check', sql`${table.loadingLimitPercent} BETWEEN 50 AND 100`),
    check('transformers_safety_margin_check', sql`${table.safetyMarginKw} >= 0`),
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

export const siteLoadManagement = pgTable(
  'site_load_management',
  {
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
    // How long before a departure the planner aims to finish charging, 0 to 180.
    departureBufferMinutes: smallint('departure_buffer_minutes').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'site_load_management_departure_buffer_check',
      sql`${table.departureBufferMinutes} BETWEEN 0 AND 180`,
    ),
  ],
);

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
    // Battery and solar supply credited above their connection points in
    // this allocation, kW (0 when none was fresh).
    supplyCreditKw: numeric('supply_credit_kw').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_load_alloc_log_site').on(table.siteId),
    index('idx_load_alloc_log_created').on(table.createdAt),
  ],
);

export const energyAssetTypeEnum = pgEnum('energy_asset_type', ENERGY_ASSET_TYPES);
export const energyAssetGridChargingEnum = pgEnum(
  'energy_asset_grid_charging',
  ENERGY_ASSET_GRID_CHARGING,
);
export const energyAssetTelemetryEnum = pgEnum('energy_asset_telemetry', ENERGY_ASSET_TELEMETRY);

// A battery or a solar array of the site. It counts as supply only while it
// has a connection point (a transformer, supply-side, or a panel, load-side)
// and a fresh reading (@evtivity/lib/energy-supply); without a connection it
// is informational. Written only by lib/site-energy-assets.ts.
export const siteEnergyAssets = pgTable(
  'site_energy_assets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('energyAsset')),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    type: energyAssetTypeEnum('type').notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    capacityKwh: integer('capacity_kwh'),
    peakKwp: integer('peak_kwp'),
    inverterKw: numeric('inverter_kw'),
    maxDischargeKw: numeric('max_discharge_kw'),
    maxChargeKw: numeric('max_charge_kw'),
    phases: integer('phases').notNull().default(3),
    connectionTransformerId: text('connection_transformer_id').references(() => transformers.id, {
      onDelete: 'set null',
    }),
    connectionPanelId: text('connection_panel_id').references(() => panels.id, {
      onDelete: 'set null',
    }),
    gridCharging: energyAssetGridChargingEnum('grid_charging').notNull().default('possible'),
    reservePercent: integer('reserve_percent').notNull().default(10),
    telemetry: energyAssetTelemetryEnum('telemetry').notNull().default('none'),
    readingTtlSeconds: integer('reading_ttl_seconds').notNull().default(60),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_site_energy_assets_site').on(table.siteId),
    check(
      'site_energy_assets_connection_check',
      sql`${table.connectionTransformerId} IS NULL OR ${table.connectionPanelId} IS NULL`,
    ),
    check(
      'site_energy_assets_type_fields_check',
      sql`(${table.type} = 'battery' AND ${table.peakKwp} IS NULL) OR (${table.type} = 'solar' AND ${table.capacityKwh} IS NULL AND ${table.maxDischargeKw} IS NULL AND ${table.maxChargeKw} IS NULL)`,
    ),
    check(
      'site_energy_assets_ratings_check',
      sql`(${table.capacityKwh} IS NULL OR ${table.capacityKwh} BETWEEN 1 AND 100000) AND (${table.peakKwp} IS NULL OR ${table.peakKwp} BETWEEN 1 AND 100000) AND (${table.inverterKw} IS NULL OR (${table.inverterKw} > 0 AND ${table.inverterKw} <= 100000)) AND (${table.maxDischargeKw} IS NULL OR (${table.maxDischargeKw} > 0 AND ${table.maxDischargeKw} <= 100000)) AND (${table.maxChargeKw} IS NULL OR (${table.maxChargeKw} > 0 AND ${table.maxChargeKw} <= 100000))`,
    ),
    check('site_energy_assets_phases_check', sql`${table.phases} IN (1, 3)`),
    check('site_energy_assets_reserve_check', sql`${table.reservePercent} BETWEEN 0 AND 100`),
    check('site_energy_assets_ttl_check', sql`${table.readingTtlSeconds} BETWEEN 15 AND 600`),
  ],
);

// The latest reading of an energy asset, one row per asset (no history: the
// allocation log keeps the credit each cycle used). power_kw is positive for
// output or discharge, negative while a battery charges. Written only by
// lib/site-energy-assets.ts, which never replaces a newer reading with an
// older one.
export const energyAssetReadings = pgTable(
  'energy_asset_readings',
  {
    assetId: text('asset_id')
      .primaryKey()
      .references(() => siteEnergyAssets.id, { onDelete: 'cascade' }),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    powerKw: numeric('power_kw').notNull(),
    availableKw: numeric('available_kw'),
    socPercent: numeric('soc_percent'),
    source: varchar('source', { length: 20 }).notNull(),
    // The API key that sent it (refresh_tokens.id as text, like the audit
    // actor columns); null for a session.
    apiKeyId: text('api_key_id'),
  },
  (table) => [
    check('energy_asset_readings_source_check', sql`${table.source} IN ('api', 'simulated')`),
    check(
      'energy_asset_readings_range_check',
      sql`${table.powerKw} BETWEEN -100000 AND 100000 AND (${table.availableKw} IS NULL OR ${table.availableKw} BETWEEN 0 AND 100000) AND (${table.socPercent} IS NULL OR ${table.socPercent} BETWEEN 0 AND 100)`,
    ),
  ],
);
