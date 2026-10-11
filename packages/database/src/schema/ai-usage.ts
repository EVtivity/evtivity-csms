// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  bigserial,
  bigint,
  integer,
  text,
  varchar,
  timestamp,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { sites } from './assets.js';
import { drivers } from './drivers.js';

// AI usage ledger and budget notices (migrations 0416, 0417, 0419).
// `recordAiUsage()` in `packages/database/src/lib/ai-usage.ts` is the only
// writer of both tables.

/**
 * One row per model call, on every AI surface: the single source of the AI
 * token budgets and the usage routes. `ai_messages.usage` stays as message
 * metadata for the UI. The provenance ids (conversation, message, insight,
 * worker run) carry no foreign key, so the ledger outlives conversation
 * retention; a deleted user or site leaves its rows with a null id.
 */
export const aiUsageLedger = pgTable(
  'ai_usage_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** chatbot, support, insight, insight_translation, worker or driver_support (`AI_USAGE_SURFACES`). */
    surface: varchar('surface', { length: 30 }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The site the usage is charged to; null for usage that belongs to no site (the chatbot). */
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id'),
    aiMessageId: text('ai_message_id'),
    insightId: text('insight_id'),
    workerRunId: text('worker_run_id'),
    /** The driver a driver_support call ran for (the driver daily budget, 0446). */
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    /** The support case of a driver_support call (provenance, no foreign key). */
    supportCaseId: text('support_case_id'),
    provider: varchar('provider', { length: 20 }).notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedReadTokens: integer('cached_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    /** Provider cost in micro-USD; null when the model has no recorded prices. */
    costMicros: bigint('cost_micros', { mode: 'number' }),
  },
  (table) => [
    index('idx_ai_usage_ledger_occurred_at').on(table.occurredAt),
    index('idx_ai_usage_ledger_site_occurred_at').on(table.siteId, table.occurredAt),
    index('idx_ai_usage_ledger_user_occurred_at').on(table.userId, table.occurredAt),
    index('idx_ai_usage_ledger_driver_occurred_at').on(table.driverId, table.occurredAt),
    check(
      'ai_usage_ledger_surface_check',
      sql`${table.surface} IN ('chatbot', 'support', 'insight', 'insight_translation', 'worker', 'driver_support')`,
    ),
    check(
      'ai_usage_ledger_tokens_check',
      sql`${table.inputTokens} >= 0 AND ${table.cachedReadTokens} >= 0 AND ${table.cacheWriteTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.reasoningTokens} >= 0`,
    ),
  ],
);

/**
 * A budget threshold notice already sent: one row per scope, period and
 * level, inserted with ON CONFLICT DO NOTHING, so each crossing is announced
 * once across processes. `scope_id` is the site id, or '' for the company.
 */
export const aiBudgetNotices = pgTable(
  'ai_budget_notices',
  {
    /** company or site. */
    scope: varchar('scope', { length: 10 }).notNull(),
    scopeId: text('scope_id').notNull(),
    /** The calendar month, YYYY-MM, in the system timezone. */
    period: varchar('period', { length: 7 }).notNull(),
    /** warn (the warnPercent threshold) or exceeded (100%). */
    level: varchar('level', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'ai_budget_notices_pkey',
      columns: [table.scope, table.scopeId, table.period, table.level],
    }),
    check('ai_budget_notices_scope_check', sql`${table.scope} IN ('company', 'site')`),
    check('ai_budget_notices_level_check', sql`${table.level} IN ('warn', 'exceeded')`),
  ],
);
