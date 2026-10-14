// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Automatic insights (roadmap v0.1.44, item 1; migrations 0421 to 0423;
// reservation insights 0458, feedback 0471, v0.1.45). The
// insight service (`@evtivity/services/ai-insight.service`) is the only writer
// of these tables; the `ai-retention-prune` cron deletes expired rows.

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  pgTable,
  text,
  varchar,
  timestamp,
  index,
  integer,
  jsonb,
  bigint,
  boolean,
  check,
  primaryKey,
  unique,
} from 'drizzle-orm/pg-core';
import { chargingStations, sites } from './assets.js';
import { chargingSessions } from './charging.js';
import { authorizeAttempts } from './drivers.js';
import { reservations } from './reservations.js';
import { users } from './identity.js';
import { createId } from '../lib/id.js';

/**
 * One automatic insight: a root-cause note about a station, session, token
 * refusal, reservation or site.
 */
export const aiInsights = pgTable(
  'ai_insights',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('aiInsight')),
    /** `INSIGHT_KINDS` of `@evtivity/lib/ai-insights`. */
    kind: varchar('kind', { length: 32 }).notNull(),
    /** `station`, `session`, `authorization`, `reservation`, `site` or `company`. */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: text('subject_id').notNull(),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => chargingSessions.id, { onDelete: 'cascade' }),
    authorizeAttemptId: integer('authorize_attempt_id').references(() => authorizeAttempts.id, {
      onDelete: 'set null',
    }),
    /** The reservation of a reservation insight (migration 0458). */
    reservationId: text('reservation_id').references(() => reservations.id, {
      onDelete: 'cascade',
    }),
    /** Copied from the station (or the site) at creation; null: all-site users only. */
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    /** The site incident this station insight belongs to. */
    parentInsightId: text('parent_insight_id').references((): AnyPgColumn => aiInsights.id, {
      onDelete: 'set null',
    }),
    /** What created it, unique per subject and kind (P7). */
    triggerKey: varchar('trigger_key', { length: 200 }).notNull(),
    /**
     * The one status of the insight and its action (`INSIGHT_STATUSES`, 0474):
     * shown open, pending, done, rejected, resolved, dismissed, expired;
     * internal analyzing, skipped, failed, superseded. Single writer:
     * `@evtivity/services/ai-insight.service`.
     */
    status: varchar('status', { length: 16 }).notNull().default('analyzing'),
    skipReason: varchar('skip_reason', { length: 40 }),
    category: varchar('category', { length: 32 }),
    confidence: varchar('confidence', { length: 10 }),
    fixes: jsonb('fixes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    scope: jsonb('scope')
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidenceRefs: jsonb('evidence_refs')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** When the evidence was read, and a hash of the subject's state then (staleness). */
    basisAt: timestamp('basis_at', { withTimezone: true }),
    basisFingerprint: varchar('basis_fingerprint', { length: 64 }),
    primaryLanguage: varchar('primary_language', { length: 10 }).notNull(),
    /** `model` or `rule`. */
    generatedBy: varchar('generated_by', { length: 10 }),
    provider: varchar('provider', { length: 20 }),
    model: varchar('model', { length: 200 }),
    /** The user who asked for a regeneration: its model call is charged to them. */
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The model analysis of this regeneration read the regenerating user's
     * note on the insight it replaced (untrusted, framed and redacted).
     */
    feedbackUsed: boolean('feedback_used').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedBy: text('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    unique('uq_ai_insights_trigger').on(
      table.kind,
      table.subjectType,
      table.subjectId,
      table.triggerKey,
    ),
    index('idx_ai_insights_site_status_created').on(table.siteId, table.status, table.createdAt),
    index('idx_ai_insights_station_created').on(table.stationId, table.createdAt),
    index('idx_ai_insights_session').on(table.sessionId),
    index('idx_ai_insights_parent').on(table.parentInsightId),
    index('idx_ai_insights_status_created').on(table.status, table.createdAt),
    index('idx_ai_insights_authorize_attempt').on(table.authorizeAttemptId),
    index('idx_ai_insights_reservation').on(table.reservationId),
    check(
      'ai_insights_status_check',
      sql`${table.status} IN ('analyzing', 'skipped', 'failed', 'superseded', 'open', 'pending', 'done', 'rejected', 'resolved', 'dismissed', 'expired')`,
    ),
    check(
      'ai_insights_subject_type_check',
      sql`${table.subjectType} IN ('station', 'session', 'authorization', 'reservation', 'site', 'company')`,
    ),
    check(
      'ai_insights_generated_by_check',
      sql`${table.generatedBy} IS NULL OR ${table.generatedBy} IN ('model', 'rule')`,
    ),
  ],
);

/**
 * One operator's verdict on an insight (migration 0471): one row per user and
 * insight, changed or cleared by the user. `reason` is the operator's optional
 * note on a wrong insight: untrusted text, never sent to a model and never in
 * an API answer. Votes never feed any prompt.
 */
export const aiInsightFeedback = pgTable(
  'ai_insight_feedback',
  {
    insightId: text('insight_id')
      .notNull()
      .references(() => aiInsights.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    helpful: boolean('helpful').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_ai_insight_feedback_insight_user').on(table.insightId, table.userId),
    index('idx_ai_insight_feedback_user').on(table.userId),
    index('idx_ai_insight_feedback_updated').on(table.updatedAt),
  ],
);

/** The summary of an insight in one language: the canonical text or a translation. */
export const aiInsightTexts = pgTable(
  'ai_insight_texts',
  {
    insightId: text('insight_id')
      .notNull()
      .references(() => aiInsights.id, { onDelete: 'cascade' }),
    language: varchar('language', { length: 10 }).notNull(),
    /** Null while a translation is pending or when it could not be made. */
    summary: text('summary'),
    /** `ready`, `pending` or `unavailable`. */
    status: varchar('status', { length: 16 }).notNull(),
    /** `generated` (the canonical text) or `translated`. */
    source: varchar('source', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'ai_insight_texts_pk', columns: [table.insightId, table.language] }),
    check(
      'ai_insight_texts_status_check',
      sql`${table.status} IN ('ready', 'pending', 'unavailable')`,
    ),
    check('ai_insight_texts_source_check', sql`${table.source} IN ('generated', 'translated')`),
  ],
);

/** The next time a subject may get a model insight of a kind (atomic claim, P7). */
export const aiInsightCooldowns = pgTable(
  'ai_insight_cooldowns',
  {
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: text('subject_id').notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    nextAllowedAt: timestamp('next_allowed_at', { withTimezone: true }).notNull(),
    /** The insight holding the claim: its retries claim again. */
    claimedByInsightId: text('claimed_by_insight_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'ai_insight_cooldowns_pk',
      columns: [table.subjectType, table.subjectId, table.kind],
    }),
    index('idx_ai_insight_cooldowns_next_allowed').on(table.nextAllowedAt),
  ],
);

/**
 * The scan watermark per source table: the last serial id read (logs,
 * alerts, authorize attempts) or the last `(updated_at, id)` (sessions).
 */
export const aiInsightScanState = pgTable('ai_insight_scan_state', {
  source: varchar('source', { length: 40 }).primaryKey(),
  lastId: bigint('last_id', { mode: 'number' }),
  lastAt: timestamp('last_at', { withTimezone: true }),
  lastKey: text('last_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
