// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const cronjobStatusEnum = pgEnum('cronjob_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);

export const cronjobs = pgTable(
  'cronjobs',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    schedule: varchar('schedule', { length: 100 }).notNull(),
    status: cronjobStatusEnum('status').notNull().default('pending'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    result: jsonb('result'),
    error: varchar('error', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_cronjobs_name').on(table.name),
    index('idx_cronjobs_next_run_at').on(table.nextRunAt),
  ],
);
