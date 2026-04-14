// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';
import { createId } from '../lib/id.js';

export const chargingProfileTemplates = pgTable('charging_profile_templates', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('cpTemplate')),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  ocppVersion: varchar('ocpp_version', { length: 10 }).notNull().default('2.1'),
  profileId: integer('profile_id').notNull().default(100),
  profilePurpose: varchar('profile_purpose', { length: 50 }).notNull(),
  profileKind: varchar('profile_kind', { length: 20 }).notNull(),
  recurrencyKind: varchar('recurrency_kind', { length: 10 }),
  stackLevel: integer('stack_level').notNull().default(0),
  evseId: integer('evse_id').notNull().default(0),
  chargingRateUnit: varchar('charging_rate_unit', { length: 1 }).notNull().default('W'),
  schedulePeriods: jsonb('schedule_periods').notNull().default([]),
  startSchedule: timestamp('start_schedule', { withTimezone: true }),
  duration: integer('duration'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  targetFilter: jsonb('target_filter'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chargingProfilePushStatusEnum = pgEnum('charging_profile_push_status', [
  'active',
  'completed',
]);

export const chargingProfilePushStationStatusEnum = pgEnum('charging_profile_push_station_status', [
  'pending',
  'accepted',
  'rejected',
  'failed',
]);

export const chargingProfilePushes = pgTable(
  'charging_profile_pushes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('cpPush')),
    templateId: text('template_id')
      .notNull()
      .references(() => chargingProfileTemplates.id, { onDelete: 'cascade' }),
    status: chargingProfilePushStatusEnum('status').notNull().default('active'),
    stationCount: integer('station_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_cp_pushes_template').on(table.templateId)],
);

export const chargingProfilePushStations = pgTable(
  'charging_profile_push_stations',
  {
    id: serial('id').primaryKey(),
    pushId: text('push_id')
      .notNull()
      .references(() => chargingProfilePushes.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    status: chargingProfilePushStationStatusEnum('status').notNull().default('pending'),
    errorInfo: text('error_info'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_cp_push_stations_push').on(table.pushId),
    index('idx_cp_push_stations_station').on(table.stationId),
  ],
);
