// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  index,
  integer,
  jsonb,
  check,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { sites, chargingStations } from './assets.js';
import { chargingSessions } from './charging.js';
import { aiInsights } from './ai-insights.js';
import { createId } from '../lib/id.js';

/**
 * One run of a background AI worker job for one site (or the company) and
 * one period (migration 0431). The unique (job, scope_key, period) row is the
 * run's claim: two worker replicas produce one run (TC-AI-WK-15).
 */
export const aiWorkerRuns = pgTable(
  'ai_worker_runs',
  {
    id: serial('id').primaryKey(),
    /** network_summary, stuck_sessions, tariff_anomalies (`AI_WORKER_JOBS`). */
    job: varchar('job', { length: 40 }).notNull(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    /** The site id, or `company` for the company-level run. */
    scopeKey: varchar('scope_key', { length: 40 }).notNull(),
    /** The period the run covers: a day (`2026-10-10`) or a 15-minute slot (`2026-10-10T10:15`). */
    period: varchar('period', { length: 32 }).notNull(),
    /** running, completed, failed, skipped, budget_skipped. */
    status: varchar('status', { length: 20 }).notNull().default('running'),
    proposalsCount: integer('proposals_count').notNull().default(0),
    findingsCount: integer('findings_count').notNull().default(0),
    /** The insight the run wrote (summary or findings), if any. */
    insightId: text('insight_id'),
    /** Deterministic metrics or findings the run computed (structured, no model text). */
    output: jsonb('output'),
    error: varchar('error', { length: 1000 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_ai_worker_runs_job_scope_period').on(table.job, table.scopeKey, table.period),
    index('idx_ai_worker_runs_started').on(table.startedAt),
    check(
      'ai_worker_runs_status_check',
      sql`${table.status} IN ('running', 'completed', 'failed', 'skipped', 'budget_skipped')`,
    ),
  ],
);

/**
 * The action an automatic insight carries (migrations 0431, 0473): a write a
 * background worker suggests. It runs only after an operator confirms it on
 * the insight, under that operator's own authorization. One action per
 * insight. The single writer is `@evtivity/services/ai-proposal.service` (P3).
 */
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiProposal')),
    /** The worker job that suggested it (`AI_WORKER_JOBS`). */
    job: varchar('job', { length: 40 }),
    /** The insight that carries the action; pruned with it. */
    insightId: text('insight_id')
      .notNull()
      .references(() => aiInsights.id, { onDelete: 'cascade' }),
    workerRunId: integer('worker_run_id').references(() => aiWorkerRuns.id, {
      onDelete: 'set null',
    }),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'cascade' }),
    operationId: varchar('operation_id', { length: 200 }).notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    path: text('path').notNull(),
    /** The arguments as they will run, policy-checked. */
    args: jsonb('args').notNull(),
    argsHash: varchar('args_hash', { length: 64 }).notNull(),
    /** Structured fields for the localized confirmation card. */
    summary: jsonb('summary').notNull().default({}),
    /** `{ kind, params }`, checked again at confirm (`AI_PROPOSAL_PRECONDITION_KINDS`). */
    precondition: jsonb('precondition'),
    /** One pending proposal per key (worker: `<job>:<subject>`), so a rerun proposes nothing twice. */
    dedupKey: varchar('dedup_key', { length: 200 }),
    /** pending, executed, failed, rejected, expired, stale (`AI_PROPOSAL_STATUSES`). */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when an operator confirms or rejects; a confirm claims the row with it while it runs. */
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** `{ httpStatus, body }`: the route's answer, redacted. */
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_proposals_status_site').on(table.status, table.siteId, table.createdAt),
    index('idx_ai_proposals_station').on(table.stationId),
    index('idx_ai_proposals_session').on(table.sessionId),
    index('idx_ai_proposals_pending_expiry')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('uq_ai_proposals_pending_dedup')
      .on(table.dedupKey)
      .where(sql`${table.status} = 'pending' AND ${table.dedupKey} IS NOT NULL`),
    uniqueIndex('uq_ai_proposals_insight').on(table.insightId),
    check(
      'ai_proposals_status_check',
      sql`${table.status} IN ('pending', 'executed', 'failed', 'rejected', 'expired', 'stale')`,
    ),
  ],
);
