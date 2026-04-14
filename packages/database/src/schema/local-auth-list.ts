// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';
import { driverTokens } from './drivers.js';

export const stationLocalAuthVersions = pgTable('station_local_auth_versions', {
  id: serial('id').primaryKey(),
  stationId: text('station_id')
    .notNull()
    .unique()
    .references(() => chargingStations.id, { onDelete: 'cascade' }),
  localVersion: integer('local_version').notNull().default(0),
  reportedVersion: integer('reported_version'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastModifiedAt: timestamp('last_modified_at', { withTimezone: true }),
  lastVersionCheckAt: timestamp('last_version_check_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stationLocalAuthEntries = pgTable(
  'station_local_auth_entries',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    driverTokenId: text('driver_token_id').references(() => driverTokens.id, {
      onDelete: 'set null',
    }),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    tokenType: varchar('token_type', { length: 20 }).notNull(),
    authStatus: varchar('auth_status', { length: 20 }).notNull().default('Accepted'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_local_auth_entries_station_id').on(table.stationId),
    index('idx_local_auth_entries_driver_token_id').on(table.driverTokenId),
    unique('uq_local_auth_entries_station_token').on(table.stationId, table.idToken),
  ],
);
