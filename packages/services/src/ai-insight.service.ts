// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Automatic insights: the only writer of `ai_insights`, `ai_insight_texts`,
 * `ai_insight_cooldowns` and `ai_insight_scan_state` (P3; the retention cron
 * deletes expired rows), and the reads the API, Explain and the support
 * draft share.
 *
 * Status (P5): `pending` and `active` are open; `resolved`, `superseded`,
 * `skipped`, `failed` and `dismissed` are terminal. Every status write is a
 * compare-and-set from an open status, so a late job cannot revive a closed
 * insight.
 */

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  aiInsightAuditLog,
  aiInsights,
  aiInsightTexts,
  client,
  db,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import { createLogger, type PubSubClient } from '@evtivity/lib';
import {
  aiInsightDtoSchema,
  INSIGHT_KINDS,
  insightFixSchema,
  insightScopeSchema,
} from '@evtivity/lib/ai-insights';
import type {
  AiInsightDto,
  InsightConfidence,
  InsightFix,
  InsightGenerator,
  InsightKind,
  InsightScope,
  InsightSkipReason,
  InsightStatus,
  InsightTextStatus,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
import type { InsightSubjectType } from './ai-evidence/pack.js';
import { scopeForViewer } from './ai-evidence/scope.js';
import { currentFingerprints } from './ai-evidence/state.js';

const log = createLogger('ai-insight-service');

/** Redis channel the API publishes on to ask the worker for a generation or a translation. */
export const AI_INSIGHT_REQUESTS_CHANNEL = 'ai_insight_requests';

/** SSE event on `csms_events` when an insight is created, generated or closed. */
export const AI_INSIGHT_UPDATED_EVENT = 'ai.insight.updated';

export const OPEN_INSIGHT_STATUSES = [
  'pending',
  'active',
] as const satisfies readonly InsightStatus[];

export type AiInsightRow = typeof aiInsights.$inferSelect;

export interface InsightAuditActor {
  actor: AuditActor;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
}

// ---------------------------------------------------------------------------
// Creation, cooldown, status
// ---------------------------------------------------------------------------

export interface NewInsight {
  kind: InsightKind;
  subjectType: InsightSubjectType;
  subjectId: string;
  triggerKey: string;
  siteId: string | null;
  primaryLanguage: string;
  stationId?: string | null;
  sessionId?: string | null;
  authorizeAttemptId?: number | null;
  parentInsightId?: string | null;
  /** `superseded`: a member of a site incident, never generated on its own. */
  status?: 'pending' | 'superseded';
  requestedBy?: string | null;
}

/**
 * Inserts an insight unless the same trigger already made one (P7: the
 * unique key on kind, subject and trigger key). Returns the new id, or null
 * when the trigger was seen before.
 */
export async function createInsight(input: NewInsight): Promise<string | null> {
  const [row] = await db
    .insert(aiInsights)
    .values({
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      triggerKey: input.triggerKey.slice(0, 200),
      siteId: input.siteId,
      primaryLanguage: input.primaryLanguage,
      stationId: input.stationId ?? null,
      sessionId: input.sessionId ?? null,
      authorizeAttemptId: input.authorizeAttemptId ?? null,
      parentInsightId: input.parentInsightId ?? null,
      status: input.status ?? 'pending',
      requestedBy: input.requestedBy ?? null,
    })
    .onConflictDoNothing({
      target: [
        aiInsights.kind,
        aiInsights.subjectType,
        aiInsights.subjectId,
        aiInsights.triggerKey,
      ],
    })
    .returning({ id: aiInsights.id });
  return row?.id ?? null;
}

/**
 * Claims the cooldown of a subject and kind for an insight: true when no
 * other insight got a model call for it within `minutes`, or when this
 * insight already holds the claim (a retry of its job after a provider
 * error). Atomic (one statement), so of two concurrent claims by different
 * insights exactly one wins (P7).
 */
export async function claimInsightCooldown(input: {
  subjectType: string;
  subjectId: string;
  kind: string;
  minutes: number;
  insightId: string;
}): Promise<boolean> {
  const rows = await client<{ subject_id: string }[]>`
    INSERT INTO ai_insight_cooldowns
      (subject_type, subject_id, kind, next_allowed_at, claimed_by_insight_id, updated_at)
    VALUES (${input.subjectType}, ${input.subjectId}, ${input.kind},
      now() + make_interval(mins => ${input.minutes}), ${input.insightId}, now())
    ON CONFLICT (subject_type, subject_id, kind) DO UPDATE
      SET next_allowed_at = CASE
          WHEN ai_insight_cooldowns.claimed_by_insight_id = EXCLUDED.claimed_by_insight_id
            AND ai_insight_cooldowns.next_allowed_at > now()
          THEN ai_insight_cooldowns.next_allowed_at
          ELSE EXCLUDED.next_allowed_at END,
        claimed_by_insight_id = EXCLUDED.claimed_by_insight_id,
        updated_at = now()
      WHERE ai_insight_cooldowns.next_allowed_at <= now()
        OR ai_insight_cooldowns.claimed_by_insight_id = EXCLUDED.claimed_by_insight_id
    RETURNING subject_id
  `;
  return rows.length > 0;
}

/** When the subject's cooldown ends, null when none is running. */
export async function insightCooldownUntil(input: {
  subjectType: string;
  subjectId: string;
  kind: string;
}): Promise<Date | null> {
  const [row] = await client<{ next_allowed_at: Date | string }[]>`
    SELECT next_allowed_at FROM ai_insight_cooldowns
    WHERE subject_type = ${input.subjectType} AND subject_id = ${input.subjectId}
      AND kind = ${input.kind} AND next_allowed_at > now()
  `;
  return row == null ? null : new Date(row.next_allowed_at);
}

/** Structured fields a skipped insight still carries (the rule fallback, no text). */
export interface SkippedInsightFields {
  category: RootCauseCategory;
  confidence: InsightConfidence;
  fixes: InsightFix[];
  scope: InsightScope;
}

/**
 * `pending` to `skipped` with a reason, optionally with the rule fallback's
 * structured fields (a budget refusal still shows a category and fixes).
 * False when the insight was no longer pending.
 */
export async function skipInsight(
  id: string,
  reason: InsightSkipReason,
  fields?: SkippedInsightFields,
): Promise<boolean> {
  const rows = await db
    .update(aiInsights)
    .set({
      status: 'skipped',
      skipReason: reason,
      ...(fields != null
        ? {
            category: fields.category,
            confidence: fields.confidence,
            fixes: fields.fixes,
            scope: fields.scope,
            generatedBy: 'rule',
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(aiInsights.id, id), eq(aiInsights.status, 'pending')))
    .returning({ id: aiInsights.id });
  return rows.length > 0;
}

/** `pending` to `failed` (the job used up its attempts). */
export async function failInsight(id: string): Promise<boolean> {
  const rows = await db
    .update(aiInsights)
    .set({ status: 'failed', updatedAt: sql`now()` })
    .where(and(eq(aiInsights.id, id), eq(aiInsights.status, 'pending')))
    .returning({ id: aiInsights.id });
  return rows.length > 0;
}

export interface InsightResult {
  category: RootCauseCategory;
  confidence: InsightConfidence;
  fixes: InsightFix[];
  evidenceRefs: string[];
  scope: InsightScope;
  /** Null for a rule insight: its structured fields are localized at view time. */
  summary: string | null;
  language: string;
  generatedBy: InsightGenerator;
  provider: string | null;
  model: string | null;
  basisAt: Date;
  basisFingerprint: string | null;
}

/**
 * Stores a generated or rule insight: `pending` to `active` with its
 * structured fields, and the canonical text, in one transaction. False (and
 * nothing written) when the insight was no longer pending (P5).
 */
export async function activateInsight(id: string, result: InsightResult): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(aiInsights)
      .set({
        status: 'active',
        skipReason: null,
        category: result.category,
        confidence: result.confidence,
        fixes: result.fixes,
        scope: result.scope,
        evidenceRefs: result.evidenceRefs,
        basisAt: result.basisAt,
        basisFingerprint: result.basisFingerprint,
        primaryLanguage: result.language,
        generatedBy: result.generatedBy,
        provider: result.provider,
        model: result.model,
        updatedAt: sql`now()`,
      })
      .where(and(eq(aiInsights.id, id), eq(aiInsights.status, 'pending')))
      .returning({ id: aiInsights.id });
    if (rows.length === 0) return false;
    if (result.summary == null) return true;
    await tx
      .insert(aiInsightTexts)
      .values({
        insightId: id,
        language: result.language,
        summary: result.summary,
        status: 'ready',
        source: 'generated',
      })
      .onConflictDoUpdate({
        target: [aiInsightTexts.insightId, aiInsightTexts.language],
        set: {
          summary: result.summary,
          status: 'ready',
          source: 'generated',
          updatedAt: sql`now()`,
        },
      });
    return true;
  });
}

/** Open to `resolved` (the condition cleared). Returns the ids it closed. */
export async function resolveInsights(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(aiInsights)
    .set({ status: 'resolved', resolvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(inArray(aiInsights.id, [...ids]), inArray(aiInsights.status, OPEN_INSIGHT_STATUSES)))
    .returning({ id: aiInsights.id });
  return rows.map((r) => r.id);
}

/**
 * Links pending station insights to their site incident: they end
 * `superseded` with the incident as parent and get no model call.
 */
export async function attachToIncident(
  memberIds: readonly string[],
  parentId: string,
): Promise<string[]> {
  if (memberIds.length === 0) return [];
  const rows = await db
    .update(aiInsights)
    .set({ status: 'superseded', parentInsightId: parentId, updatedAt: sql`now()` })
    .where(and(inArray(aiInsights.id, [...memberIds]), eq(aiInsights.status, 'pending')))
    .returning({ id: aiInsights.id });
  return rows.map((r) => r.id);
}

/** Open to `dismissed` by an operator, audited. False when it was already closed. */
export async function dismissInsight(id: string, actor: InsightAuditActor): Promise<boolean> {
  const rows = await db
    .update(aiInsights)
    .set({
      status: 'dismissed',
      dismissedAt: sql`now()`,
      dismissedBy: actor.actorUserId ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(aiInsights.id, id), inArray(aiInsights.status, OPEN_INSIGHT_STATUSES)))
    .returning({ id: aiInsights.id, status: aiInsights.status });
  if (rows.length === 0) return false;
  await auditInsight(id, 'dismissed', actor, { status: 'dismissed' });
  return true;
}

/** Records an operator's verdict on an insight (audit only). */
export async function recordInsightFeedback(
  id: string,
  helpful: boolean,
  actor: InsightAuditActor,
): Promise<void> {
  await auditInsight(id, helpful ? 'feedback_helpful' : 'feedback_wrong', actor, { helpful });
}

async function auditInsight(
  id: string,
  action: 'regenerated' | 'dismissed' | 'feedback_helpful' | 'feedback_wrong',
  actor: InsightAuditActor,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(
    { table: aiInsightAuditLog, idColumn: 'ai_insight_id' },
    {
      entityId: id,
      entityIdSnapshot: id,
      action,
      actor: actor.actor,
      actorUserId: actor.actorUserId ?? null,
      actorApiKeyId: actor.actorApiKeyId ?? null,
      after,
    },
    db,
    log,
  );
}

/** Statuses an operator can regenerate from (never a pending or dismissed one). */
export const REGENERATABLE_STATUSES = ['active', 'resolved', 'skipped', 'failed'] as const;

export type RegenerateResult =
  | { status: 'created'; insightId: string }
  /** Not regeneratable: pending, dismissed, superseded or a site incident member. */
  | { status: 'not_allowed' }
  /** A generation of the same subject and kind is already pending. */
  | { status: 'busy' };

/**
 * A new generation of an insight an operator asked for: a new `pending`
 * insight of the same subject, charged to the user, and the old one
 * `superseded` when it was still active. The old row is locked, so two
 * clicks make one new insight; a pending generation of the subject refuses
 * another.
 */
export async function regenerateInsight(
  oldId: string,
  actor: InsightAuditActor & { actorUserId: string },
): Promise<RegenerateResult> {
  const result = await db.transaction(async (tx): Promise<RegenerateResult> => {
    const [old] = await tx
      .select()
      .from(aiInsights)
      .where(eq(aiInsights.id, oldId))
      .for('update')
      .limit(1);
    if (
      old == null ||
      old.parentInsightId != null ||
      !(REGENERATABLE_STATUSES as readonly string[]).includes(old.status)
    ) {
      return { status: 'not_allowed' };
    }
    const [running] = await tx
      .select({ id: aiInsights.id })
      .from(aiInsights)
      .where(
        and(
          eq(aiInsights.kind, old.kind),
          eq(aiInsights.subjectType, old.subjectType),
          eq(aiInsights.subjectId, old.subjectId),
          eq(aiInsights.status, 'pending'),
        ),
      )
      .limit(1);
    if (running != null) return { status: 'busy' };
    const [created] = await tx
      .insert(aiInsights)
      .values({
        kind: old.kind,
        subjectType: old.subjectType,
        subjectId: old.subjectId,
        triggerKey: `regenerate:${old.id}:${String(Date.now())}`,
        siteId: old.siteId,
        stationId: old.stationId,
        sessionId: old.sessionId,
        authorizeAttemptId: old.authorizeAttemptId,
        primaryLanguage: old.primaryLanguage,
        status: 'pending',
        requestedBy: actor.actorUserId,
      })
      .returning({ id: aiInsights.id });
    if (created == null) throw new Error('Insight regeneration insert returned no row');
    // Members of a site incident move to the new incident.
    if (old.kind === 'site_incident') {
      await tx
        .update(aiInsights)
        .set({ parentInsightId: created.id, updatedAt: sql`now()` })
        .where(eq(aiInsights.parentInsightId, old.id));
    }
    await tx
      .update(aiInsights)
      .set({ status: 'superseded', updatedAt: sql`now()` })
      .where(and(eq(aiInsights.id, old.id), eq(aiInsights.status, 'active')));
    return { status: 'created', insightId: created.id };
  });
  if (result.status === 'created') {
    await auditInsight(oldId, 'regenerated', actor, { newInsightId: result.insightId });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Texts (canonical summary and lazy translations, decision D2)
// ---------------------------------------------------------------------------

/**
 * Asks for the summary in `language`: inserts a `pending` text row. True when
 * this call created it (the caller then queues the translation job), false
 * when a row already exists (pending, ready or unavailable).
 */
export async function requestInsightTranslation(id: string, language: string): Promise<boolean> {
  const rows = await db
    .insert(aiInsightTexts)
    .values({ insightId: id, language, summary: null, status: 'pending', source: 'translated' })
    .onConflictDoNothing({ target: [aiInsightTexts.insightId, aiInsightTexts.language] })
    .returning({ insightId: aiInsightTexts.insightId });
  return rows.length > 0;
}

/**
 * Stores a translation (or `unavailable` when it could not be made: over
 * budget, provider error). Only a pending translation row is written.
 */
export async function storeInsightTranslation(
  id: string,
  language: string,
  summary: string | null,
): Promise<boolean> {
  const rows = await db
    .update(aiInsightTexts)
    .set({
      summary,
      status: summary == null ? 'unavailable' : 'ready',
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(aiInsightTexts.insightId, id),
        eq(aiInsightTexts.language, language),
        eq(aiInsightTexts.status, 'pending'),
        eq(aiInsightTexts.source, 'translated'),
      ),
    )
    .returning({ insightId: aiInsightTexts.insightId });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Scan watermarks
// ---------------------------------------------------------------------------

export interface ScanWatermark {
  lastId: number | null;
  /**
   * The exact `timestamptz` text (microseconds kept): a JS Date would round it
   * to milliseconds and the scan would read the rows at that instant again.
   */
  lastAt: string | null;
  lastKey: string | null;
}

export async function readScanWatermark(source: string): Promise<ScanWatermark | null> {
  const [row] = await client<
    { last_id: string | number | null; last_at: string | null; last_key: string | null }[]
  >`
    SELECT last_id, last_at::text AS last_at, last_key FROM ai_insight_scan_state
    WHERE source = ${source}
  `;
  if (row == null) return null;
  return {
    lastId: row.last_id == null ? null : Number(row.last_id),
    lastAt: row.last_at,
    lastKey: row.last_key,
  };
}

/** Moves a watermark forward only (two replicas never move it back). */
export async function writeScanWatermark(source: string, mark: ScanWatermark): Promise<void> {
  await client`
    INSERT INTO ai_insight_scan_state (source, last_id, last_at, last_key, updated_at)
    VALUES (${source}, ${mark.lastId}, ${mark.lastAt}::timestamptz, ${mark.lastKey}, now())
    ON CONFLICT (source) DO UPDATE SET
      last_id = GREATEST(ai_insight_scan_state.last_id, EXCLUDED.last_id),
      last_at = CASE
        WHEN ai_insight_scan_state.last_at IS NULL
          OR (EXCLUDED.last_at, coalesce(EXCLUDED.last_key, ''))
            > (ai_insight_scan_state.last_at, coalesce(ai_insight_scan_state.last_key, ''))
        THEN EXCLUDED.last_at ELSE ai_insight_scan_state.last_at END,
      last_key = CASE
        WHEN ai_insight_scan_state.last_at IS NULL
          OR (EXCLUDED.last_at, coalesce(EXCLUDED.last_key, ''))
            > (ai_insight_scan_state.last_at, coalesce(ai_insight_scan_state.last_key, ''))
        THEN EXCLUDED.last_key ELSE ai_insight_scan_state.last_key END,
      updated_at = now()
  `;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Tells the CSMS an insight changed. Carries the siteId, so the SSE stream
 * sends it only to users of the site (an unsited insight reaches all-site
 * users only). Fail-open (P9).
 */
export async function publishInsightUpdated(
  pubsub: PubSubClient,
  row: Pick<AiInsightRow, 'id' | 'siteId' | 'stationId' | 'sessionId' | 'status' | 'kind'>,
): Promise<void> {
  try {
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: AI_INSIGHT_UPDATED_EVENT,
        insightId: row.id,
        siteId: row.siteId,
        stationId: row.stationId,
        sessionId: row.sessionId,
        kind: row.kind,
        status: row.status,
      }),
    );
  } catch (err) {
    log.warn({ err, insightId: row.id }, 'Insight update event publish failed');
  }
}

export type AiInsightRequest =
  | { kind: 'generate'; insightId: string }
  | { kind: 'translate'; insightId: string; language: string };

/** Asks the worker for a generation or a translation (fail-open: the scan re-enqueues). */
export async function publishInsightRequest(
  pubsub: PubSubClient,
  request: AiInsightRequest,
): Promise<boolean> {
  try {
    await pubsub.publish(AI_INSIGHT_REQUESTS_CHANNEL, JSON.stringify(request));
    return true;
  } catch (err) {
    log.warn({ err, insightId: request.insightId }, 'Insight request publish failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getInsightRow(id: string): Promise<AiInsightRow | null> {
  const [row] = await db.select().from(aiInsights).where(eq(aiInsights.id, id)).limit(1);
  return row ?? null;
}

export interface InsightListFilter {
  stationId?: string;
  sessionId?: string;
  siteId?: string;
  kind?: InsightKind;
  status?: InsightStatus;
  category?: RootCauseCategory;
  /** Support case panel: the case station and its accessible linked sessions. */
  supportCase?: { stationId: string | null; sessionIds: readonly string[] };
  /**
   * Authorize log: the authorization insights that cover any of these
   * attempts (the same token at the same station in the same UTC hour as the
   * insight's first attempt, so grouped refusals match too).
   */
  authorizeAttemptIds?: readonly number[];
}

/** The SQL test that an attempt `a` belongs to the authorization insight's group. */
function coversAttemptSql(attempt: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM authorize_attempts f, authorize_attempts a
    WHERE f.id = ${aiInsights.authorizeAttemptId} AND a.id = ${attempt}
      AND a.station_id = f.station_id AND a.id_token = f.id_token
      AND a.outcome <> 'accepted'
      AND date_trunc('hour', a.created_at AT TIME ZONE 'UTC')
        = date_trunc('hour', f.created_at AT TIME ZONE 'UTC')
  )`;
}

/**
 * For each listed authorization insight, the attempts of `attemptIds` it
 * covers (the authorize log marks each refused row with its insight).
 */
export async function insightCoveredAttempts(
  insightIds: readonly string[],
  attemptIds: readonly number[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (insightIds.length === 0 || attemptIds.length === 0) return out;
  const rows = await client<{ insight_id: string; attempt_id: number }[]>`
    SELECT i.id AS insight_id, a.id AS attempt_id
    FROM ai_insights i
    JOIN authorize_attempts f ON f.id = i.authorize_attempt_id
    JOIN authorize_attempts a ON a.station_id = f.station_id AND a.id_token = f.id_token
      AND a.outcome <> 'accepted'
      AND date_trunc('hour', a.created_at AT TIME ZONE 'UTC')
        = date_trunc('hour', f.created_at AT TIME ZONE 'UTC')
    WHERE i.id = ANY(${[...insightIds]}::text[]) AND a.id = ANY(${[...attemptIds]}::int[])
    ORDER BY a.id
  `;
  for (const r of rows) {
    const list = out.get(r.insight_id) ?? [];
    list.push(r.attempt_id);
    out.set(r.insight_id, list);
  }
  return out;
}

/** The site condition: null siteIds is every site; unsited rows only for all-site users. */
export function insightSiteCondition(siteIds: readonly string[] | null): SQL | undefined {
  if (siteIds == null) return undefined;
  if (siteIds.length === 0) return sql`false`;
  return inArray(aiInsights.siteId, [...siteIds]);
}

export async function listInsightRows(
  filter: InsightListFilter,
  siteIds: readonly string[] | null,
  page: { limit: number; offset: number },
): Promise<{ rows: AiInsightRow[]; total: number }> {
  const conditions: SQL[] = [];
  const scope = insightSiteCondition(siteIds);
  if (scope != null) conditions.push(scope);
  if (filter.stationId != null) conditions.push(eq(aiInsights.stationId, filter.stationId));
  if (filter.sessionId != null) conditions.push(eq(aiInsights.sessionId, filter.sessionId));
  if (filter.siteId != null) conditions.push(eq(aiInsights.siteId, filter.siteId));
  if (filter.kind != null) conditions.push(eq(aiInsights.kind, filter.kind));
  if (filter.status != null) conditions.push(eq(aiInsights.status, filter.status));
  if (filter.category != null) conditions.push(eq(aiInsights.category, filter.category));
  if (filter.authorizeAttemptIds != null) {
    if (filter.authorizeAttemptIds.length === 0) {
      conditions.push(sql`false`);
    } else {
      const ids = [...filter.authorizeAttemptIds];
      conditions.push(
        eq(aiInsights.kind, 'authorization_refused'),
        or(...ids.map((id) => coversAttemptSql(sql`${id}`))) as SQL,
      );
    }
  }
  if (filter.supportCase != null) {
    const { stationId, sessionIds } = filter.supportCase;
    const parts: SQL[] = [];
    if (stationId != null) {
      parts.push(and(eq(aiInsights.stationId, stationId), isNull(aiInsights.sessionId)) as SQL);
    }
    if (sessionIds.length > 0) parts.push(inArray(aiInsights.sessionId, [...sessionIds]));
    conditions.push(parts.length === 0 ? sql`false` : (or(...parts) as SQL));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(aiInsights)
      .where(where)
      .orderBy(desc(aiInsights.createdAt), desc(aiInsights.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiInsights)
      .where(where),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export interface InsightTextRow {
  insightId: string;
  language: string;
  summary: string | null;
  status: string;
}

/** The texts of the insights in the requested language and in their primary language. */
export async function insightTexts(
  rows: readonly Pick<AiInsightRow, 'id' | 'primaryLanguage'>[],
  language: string,
): Promise<Map<string, { requested?: InsightTextRow; primary?: InsightTextRow }>> {
  const out = new Map<string, { requested?: InsightTextRow; primary?: InsightTextRow }>();
  if (rows.length === 0) return out;
  const texts = await db
    .select({
      insightId: aiInsightTexts.insightId,
      language: aiInsightTexts.language,
      summary: aiInsightTexts.summary,
      status: aiInsightTexts.status,
    })
    .from(aiInsightTexts)
    .where(
      inArray(
        aiInsightTexts.insightId,
        rows.map((r) => r.id),
      ),
    );
  for (const r of rows) {
    const mine = texts.filter((t) => t.insightId === r.id);
    const entry: { requested?: InsightTextRow; primary?: InsightTextRow } = {};
    const requested = mine.find((t) => t.language === language);
    const primary = mine.find((t) => t.language === r.primaryLanguage);
    if (requested != null) entry.requested = requested;
    if (primary != null) entry.primary = primary;
    out.set(r.id, entry);
  }
  return out;
}

export interface InsightViewOptions {
  language: string;
  /** All-site viewer: sees `scope.network`. */
  allSites: boolean;
  stale: boolean;
}

function parseJson<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : fallback;
}

function isKind(value: string): value is InsightKind {
  return (INSIGHT_KINDS as readonly string[]).includes(value);
}

/**
 * The DTO a viewer gets. The summary is the requested language's text when
 * ready, else `textStatus` says why not (`pending` translation, or
 * `unavailable`: the primary text is then offered as the original).
 */
export function toInsightDto(
  row: AiInsightRow,
  texts: { requested?: InsightTextRow; primary?: InsightTextRow } | undefined,
  options: InsightViewOptions,
): AiInsightDto {
  const requested = texts?.requested;
  let summary: string | null = null;
  let textStatus: InsightTextStatus = 'unavailable';
  if (requested?.status === 'ready' && requested.summary != null) {
    summary = requested.summary;
    textStatus = 'ready';
  } else if (requested?.status === 'pending') {
    textStatus = 'pending';
  } else if (row.status === 'pending') {
    textStatus = 'pending';
  }
  const scope = scopeForViewer(parseJson(insightScopeSchema, row.scope, {}), options.allSites);
  const fixes = Array.isArray(row.fixes)
    ? (row.fixes as unknown[]).flatMap((f) => {
        const parsed = insightFixSchema.safeParse(f);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const dto = {
    id: row.id,
    kind: isKind(row.kind) ? row.kind : 'station_alert',
    status: row.status,
    skipReason: row.skipReason,
    siteId: row.siteId,
    stationId: row.stationId,
    sessionId: row.sessionId,
    authorizeAttemptId: row.authorizeAttemptId,
    parentInsightId: row.parentInsightId,
    category: row.category,
    confidence: row.confidence,
    fixes,
    scope,
    generatedBy: row.generatedBy,
    language: requested?.status === 'ready' ? options.language : row.primaryLanguage,
    summary,
    textStatus,
    stale: options.stale,
    basisAt: row.basisAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  };
  return aiInsightDtoSchema.parse(dto);
}

/** The primary-language text, shown behind "Show original" when no translation is ready. */
export function originalSummary(
  texts: { requested?: InsightTextRow; primary?: InsightTextRow } | undefined,
): string | null {
  const primary = texts?.primary;
  return primary?.status === 'ready' ? primary.summary : null;
}

/**
 * Whether each open insight's subject changed since its evidence was read
 * (`stale`). Closed insights are never reported stale.
 */
export async function staleFlags(rows: readonly AiInsightRow[]): Promise<Map<string, boolean>> {
  const open = rows.filter((r) => r.status === 'active' && r.basisFingerprint != null);
  const current = await currentFingerprints(
    open.map((r) => ({
      id: r.id,
      kind: r.kind as InsightKind,
      stationId: r.stationId,
      sessionId: r.sessionId,
      authorizeAttemptId: r.authorizeAttemptId,
    })),
  );
  const out = new Map<string, boolean>();
  for (const r of rows) {
    const now = current.get(r.id);
    out.set(r.id, now !== undefined && now !== null && now !== r.basisFingerprint);
  }
  return out;
}

export interface InsightSubjectQuery {
  kind: 'station' | 'session' | 'authorization';
  stationId: string | null;
  sessionId: string | null;
  authorizeAttemptId: number | null;
}

/**
 * The newest active, not stale insight of a record, for Explain: its text in
 * `language` when that translation is ready, else the canonical text. Reads
 * only: no model call and no translation request (Explain spends no tokens
 * on the insight). The caller has checked the record's site scope; network
 * counts are left out.
 */
export async function latestActiveInsight(
  subject: InsightSubjectQuery,
  language: string,
): Promise<AiInsightDto | null> {
  const conditions: SQL[] = [eq(aiInsights.status, 'active')];
  if (subject.kind === 'station') {
    if (subject.stationId == null) return null;
    conditions.push(
      eq(aiInsights.stationId, subject.stationId),
      inArray(aiInsights.kind, ['station_offline', 'station_faulted', 'station_alert']),
    );
  } else if (subject.kind === 'session') {
    if (subject.sessionId == null) return null;
    conditions.push(eq(aiInsights.sessionId, subject.sessionId));
  } else {
    if (subject.authorizeAttemptId == null || subject.stationId == null) return null;
    // The insights of the same token at the station: their first refused
    // attempt carries the same token value.
    conditions.push(
      eq(aiInsights.kind, 'authorization_refused'),
      eq(aiInsights.stationId, subject.stationId),
      sql`EXISTS (
        SELECT 1 FROM authorize_attempts a, authorize_attempts b
        WHERE a.id = ${aiInsights.authorizeAttemptId} AND b.id = ${subject.authorizeAttemptId}
          AND a.id_token = b.id_token
      )`,
    );
  }
  const rows = await db
    .select()
    .from(aiInsights)
    .where(and(...conditions))
    .orderBy(desc(aiInsights.createdAt), desc(aiInsights.id))
    .limit(5);
  if (rows.length === 0) return null;
  const stale = await staleFlags(rows);
  const row = rows.find((r) => stale.get(r.id) !== true);
  if (row == null) return null;
  const texts = (await insightTexts([row], language)).get(row.id);
  const requestedReady = texts?.requested?.status === 'ready';
  const shown = requestedReady || texts?.primary == null ? texts : { requested: texts.primary };
  return toInsightDto(row, shown, {
    language: requestedReady ? language : row.primaryLanguage,
    allSites: false,
    stale: false,
  });
}

/** A background worker's insight (lane R5): a summary or tariff findings. */
export interface WorkerInsightInput {
  kind: 'site_summary' | 'company_summary' | 'tariff_anomaly';
  /** Null: a company summary, visible to all-site users only. */
  siteId: string | null;
  triggerKey: string;
  /** The model narrative over the worker's facts; null when none was written. */
  narrative: { text: string; language: string; provider: string; model: string } | null;
  /** The language when there is no narrative (`aiInsights.primaryLanguage`). */
  primaryLanguage: string;
}

/**
 * Stores a background worker's output as an active insight: tariff findings
 * as category `tariff` with the tariff fix, summaries as `unknown`; the
 * narrative is the canonical text. One insight per trigger key (P7): a
 * repeated run returns null. Publishes the SSE update (fail-open).
 */
export async function storeWorkerInsight(
  input: WorkerInsightInput,
  pubsub: PubSubClient,
): Promise<string | null> {
  const language = input.narrative?.language ?? input.primaryLanguage;
  const id = await createInsight({
    kind: input.kind,
    subjectType: input.siteId == null ? 'company' : 'site',
    subjectId: input.siteId ?? 'company',
    triggerKey: input.triggerKey,
    siteId: input.siteId,
    primaryLanguage: language,
  });
  if (id == null) return null;
  const tariff = input.kind === 'tariff_anomaly';
  const stored = await activateInsight(id, {
    category: tariff ? 'tariff' : 'unknown',
    confidence: 'medium',
    fixes: tariff ? [{ code: 'review_tariff_assignment' }] : [],
    evidenceRefs: [],
    scope: {},
    summary: input.narrative?.text ?? null,
    language,
    generatedBy: input.narrative != null ? 'model' : 'rule',
    provider: input.narrative?.provider ?? null,
    model: input.narrative?.model ?? null,
    basisAt: new Date(),
    basisFingerprint: null,
  });
  if (stored) {
    await publishInsightUpdated(pubsub, {
      id,
      siteId: input.siteId,
      stationId: null,
      sessionId: null,
      kind: input.kind,
      status: 'active',
    });
  }
  return id;
}
