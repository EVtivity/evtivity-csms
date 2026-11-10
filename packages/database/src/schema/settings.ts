// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { pgTable, serial, varchar, jsonb, timestamp, smallint, check } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 255 }).notNull().unique(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The latest released CSMS version, read by the worker from the EVtivity
 * website at most once a day while `system.updateCheckEnabled` is on. One row
 * (`id = 1`), written only by `lib/csms-update-check.ts`. `checkedAt` is the
 * last successful read, `attemptedAt` the last try.
 */
export const csmsUpdateChecks = pgTable(
  'csms_update_checks',
  {
    id: smallint('id').primaryKey().default(1),
    latestVersion: varchar('latest_version', { length: 64 }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
  },
  (table) => [check('csms_update_checks_single_row', sql`${table.id} = 1`)],
);
