// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  text,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const octtRunStatusEnum = pgEnum('octt_run_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);

export const octtTestStatusEnum = pgEnum('octt_test_status', [
  'passed',
  'failed',
  'skipped',
  'error',
]);

export const octtRuns = pgTable('octt_runs', {
  id: serial('id').primaryKey(),
  status: octtRunStatusEnum('status').notNull().default('pending'),
  ocppVersion: varchar('ocpp_version', { length: 10 }).notNull(),
  sutType: varchar('sut_type', { length: 10 }).notNull().default('csms'),
  totalTests: integer('total_tests').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  durationMs: integer('duration_ms'),
  triggeredBy: text('triggered_by').references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const octtTestResults = pgTable(
  'octt_test_results',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => octtRuns.id, { onDelete: 'cascade' }),
    testId: varchar('test_id', { length: 50 }).notNull(),
    testName: varchar('test_name', { length: 200 }).notNull(),
    module: varchar('module', { length: 50 }).notNull(),
    ocppVersion: varchar('ocpp_version', { length: 10 }).notNull(),
    status: octtTestStatusEnum('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    steps: jsonb('steps'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_octt_test_results_run_id').on(table.runId),
    index('idx_octt_test_results_test_id').on(table.testId),
  ],
);
