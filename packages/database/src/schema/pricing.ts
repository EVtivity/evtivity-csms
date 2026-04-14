// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  text,
  serial,
  integer,
  varchar,
  numeric,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { createId } from '../lib/id.js';
import { chargingStations, sites } from './assets.js';
import { drivers, fleets } from './drivers.js';

export const pricingGroups = pgTable('pricing_groups', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('pricingGroup')),
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tariffs = pgTable(
  'tariffs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('tariff')),
    pricingGroupId: text('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    pricePerKwh: numeric('price_per_kwh'),
    pricePerMinute: numeric('price_per_minute'),
    pricePerSession: numeric('price_per_session'),
    idleFeePricePerMinute: numeric('idle_fee_price_per_minute'),
    reservationFeePerMinute: numeric('reservation_fee_per_minute'),
    taxRate: numeric('tax_rate'),
    restrictions: jsonb('restrictions'),
    isActive: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_tariffs_group_active').on(table.pricingGroupId, table.isActive)],
);

export const pricingGroupStations = pgTable(
  'pricing_group_stations',
  {
    id: serial('id').primaryKey(),
    pricingGroupId: text('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_group_stations_group_id').on(table.pricingGroupId),
    index('idx_pricing_group_stations_station_id').on(table.stationId),
    unique('uq_pricing_group_stations_station').on(table.stationId),
  ],
);

export const pricingGroupDrivers = pgTable(
  'pricing_group_drivers',
  {
    id: serial('id').primaryKey(),
    pricingGroupId: text('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id, { onDelete: 'cascade' }),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_group_drivers_group_id').on(table.pricingGroupId),
    index('idx_pricing_group_drivers_driver_id').on(table.driverId),
    unique('uq_pricing_group_drivers_driver').on(table.driverId),
  ],
);

export const pricingGroupSites = pgTable(
  'pricing_group_sites',
  {
    id: serial('id').primaryKey(),
    pricingGroupId: text('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_group_sites_group_id').on(table.pricingGroupId),
    index('idx_pricing_group_sites_site_id').on(table.siteId),
    unique('uq_pricing_group_sites_site').on(table.siteId),
  ],
);

export const pricingGroupFleets = pgTable(
  'pricing_group_fleets',
  {
    id: serial('id').primaryKey(),
    pricingGroupId: text('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id, { onDelete: 'cascade' }),
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_group_fleets_group_id').on(table.pricingGroupId),
    index('idx_pricing_group_fleets_fleet_id').on(table.fleetId),
    unique('uq_pricing_group_fleets_fleet').on(table.fleetId),
  ],
);

export const pricingHolidays = pgTable(
  'pricing_holidays',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    date: date('date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_pricing_holidays_date').on(table.date)],
);

// sessionId FK to charging_sessions is defined in migration SQL (0017) to avoid circular imports.
// Constraint: ON DELETE CASCADE.
export const sessionTariffSegments = pgTable(
  'session_tariff_segments',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tariffId: text('tariff_id')
      .notNull()
      .references(() => tariffs.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    energyWhStart: numeric('energy_wh_start').notNull().default('0'),
    energyWhEnd: numeric('energy_wh_end'),
    durationMinutes: numeric('duration_minutes'),
    idleMinutes: numeric('idle_minutes').notNull().default('0'),
    costCents: integer('cost_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_session_tariff_segments_session').on(table.sessionId)],
);
