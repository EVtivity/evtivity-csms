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

export const configTemplates = pgTable('config_templates', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('configTemplate')),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  variables: jsonb('variables').notNull().default([]),
  ocppVersion: varchar('ocpp_version', { length: 10 }).notNull().default('2.1'),
  targetFilter: jsonb('target_filter'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const configTemplatePushStatusEnum = pgEnum('config_template_push_status', [
  'active',
  'completed',
]);

export const configTemplatePushStationStatusEnum = pgEnum('config_template_push_station_status', [
  'pending',
  'accepted',
  'rejected',
  'failed',
]);

export const configTemplatePushes = pgTable(
  'config_template_pushes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('configTemplatePush')),
    templateId: text('template_id')
      .notNull()
      .references(() => configTemplates.id, { onDelete: 'cascade' }),
    status: configTemplatePushStatusEnum('status').notNull().default('active'),
    stationCount: integer('station_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_config_template_pushes_template').on(table.templateId)],
);

export const configTemplatePushStations = pgTable(
  'config_template_push_stations',
  {
    id: serial('id').primaryKey(),
    pushId: text('push_id')
      .notNull()
      .references(() => configTemplatePushes.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    status: configTemplatePushStationStatusEnum('status').notNull().default('pending'),
    errorInfo: text('error_info'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_config_template_push_stations_push').on(table.pushId),
    index('idx_config_template_push_stations_station').on(table.stationId),
  ],
);
