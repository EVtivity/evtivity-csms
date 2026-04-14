// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, serial, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const paymentReconciliationRuns = pgTable('payment_reconciliation_runs', {
  id: serial('id').primaryKey(),
  checkedCount: integer('checked_count').notNull().default(0),
  matchedCount: integer('matched_count').notNull().default(0),
  discrepancyCount: integer('discrepancy_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  discrepancies: jsonb('discrepancies'),
  errors: jsonb('errors'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
