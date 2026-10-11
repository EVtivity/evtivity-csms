// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Automatic insight routes.
 * Reads need
 * `aiInsights:read`, regenerate, dismiss and feedback `aiInsights:write`.
 * Site scope: a list holds the user's sites only (unsited insights for
 * all-site users only); a detail outside the user's sites answers the same
 * 404 `AI_INSIGHT_NOT_FOUND` as a missing one; `scope.network` is returned to
 * all-site users only. Not cached (per-user scope, `response-cache.md`).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  chargingStations,
  checkAiBudgets,
  getAiInsightSettings,
  isOpsAiEnabled,
  sites,
  supportCases,
  supportCaseSessions,
  users,
} from '@evtivity/database';
import { UI_LANGUAGES, isUiLanguage } from '@evtivity/lib/languages';
import type { AiInsightSettings } from '@evtivity/lib/ai-config';
import {
  FIX_CODES,
  INSIGHT_CONFIDENCES,
  INSIGHT_GENERATORS,
  INSIGHT_KINDS,
  INSIGHT_SKIP_REASONS,
  INSIGHT_STATUSES,
  INSIGHT_TEXT_STATUSES,
  ROOT_CAUSE_CATEGORIES,
} from '@evtivity/lib/ai-insights';
import type { InsightKind, InsightScope } from '@evtivity/lib/ai-insights';
import { computeLiveInsightScope, scopeForViewer } from '@evtivity/services/ai-evidence';
import type { CheckAiBudgets } from '@evtivity/lib/ai-usage';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  dismissInsight,
  getInsightRow,
  insightCooldownUntil,
  insightCoveredAttempts,
  insightTexts,
  listInsightRows,
  originalSummary,
  publishInsightRequest,
  publishInsightUpdated,
  recordInsightFeedback,
  regenerateInsight,
  requestInsightTranslation,
  staleFlags,
  toInsightDto,
} from '@evtivity/services/ai-insight.service';
import type { AiInsightRow, InsightListFilter } from '@evtivity/services/ai-insight.service';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import { errorWith, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import type { ErrorCode } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { supportCaseSiteCondition } from '../lib/support-case-scope.js';
import { sessionIdsInSites } from '../lib/support-case-redaction.js';
import { getAuditActor } from '../lib/audit-actor.js';
import type { JwtPayload } from '../plugins/auth.js';

const NOT_FOUND = {
  error: ERROR_MESSAGES.AI_INSIGHT_NOT_FOUND,
  code: ERROR_CODES.AI_INSIGHT_NOT_FOUND,
} as const;

const countsSchema = z
  .object({
    stations: z.number().int().optional().describe('Stations'),
    stationsOffline: z.number().int().optional().describe('Stations offline'),
    stationsFaulted: z.number().int().optional().describe('Stations faulted'),
    sameErrorCode: z
      .number()
      .int()
      .optional()
      .describe('Stations that reported the same error code in 24 hours'),
    sessionsInterrupted: z
      .number()
      .int()
      .optional()
      .describe('Sessions that ended failed or faulted in 24 hours'),
    sessionsFailedSameReason24h: z
      .number()
      .int()
      .optional()
      .describe('Sessions that failed with the same stop reason in 24 hours'),
    tokenRefusals: z.number().int().optional().describe('Refused authorizations in 24 hours'),
  })
  .passthrough();

const insightSchema = z
  .object({
    id: z.string().describe('Insight id'),
    kind: z.enum(INSIGHT_KINDS).describe('What raised the insight'),
    status: z
      .enum(INSIGHT_STATUSES)
      .describe('pending, active, resolved, superseded, skipped, failed or dismissed'),
    skipReason: z.enum(INSIGHT_SKIP_REASONS).nullable().describe('Why it ended skipped'),
    siteId: z.string().nullable().describe('Site of the subject; null for an unsited station'),
    stationId: z.string().nullable().describe('Station of the subject'),
    sessionId: z.string().nullable().describe('Session of a session insight'),
    authorizeAttemptId: z
      .number()
      .int()
      .nullable()
      .describe('First refused attempt of an authorization insight'),
    parentInsightId: z.string().nullable().describe('The site incident this insight belongs to'),
    category: z
      .enum(ROOT_CAUSE_CATEGORIES)
      .nullable()
      .describe('Root-cause category (localize aiInsights.category.<value>)'),
    confidence: z.enum(INSIGHT_CONFIDENCES).nullable().describe('Confidence of the analysis'),
    fixes: z
      .array(
        z
          .object({
            code: z.enum(FIX_CODES).describe('Suggested fix (localize aiInsights.fix.<code>)'),
            note: z.string().optional().describe('Short model note on the fix'),
          })
          .passthrough(),
      )
      .describe('Suggested fixes, at most three'),
    scope: z
      .object({
        site: countsSchema.optional().describe('Counts at the subject site'),
        network: countsSchema.optional().describe('Counts across every site; all-site users only'),
      })
      .passthrough()
      .describe(
        'Counts at detection, stored with the insight; computed by the server, never by the model',
      ),
    generatedBy: z.enum(INSIGHT_GENERATORS).nullable().describe('model or rule'),
    language: z.string().describe('Language of summary'),
    summary: z
      .string()
      .nullable()
      .describe('Plain-text summary in the requested language when ready'),
    textStatus: z
      .enum(INSIGHT_TEXT_STATUSES)
      .describe('ready, pending (being translated) or unavailable'),
    matchedAttemptIds: z
      .array(z.number().int())
      .optional()
      .describe('With the authorizeAttemptIds filter: the listed attempts this insight covers'),
    originalSummary: z
      .string()
      .nullable()
      .describe('The summary in the primary language, shown as the original'),
    stale: z.boolean().describe('The subject changed since the evidence was read'),
    basisAt: z.string().nullable().describe('When the evidence was read'),
    createdAt: z.string().describe('Creation time'),
    resolvedAt: z.string().nullable().describe('When the condition cleared'),
    dismissedAt: z.string().nullable().describe('When an operator dismissed it'),
    stationName: z
      .string()
      .nullable()
      .describe('OCPP identity of the station, for display; null without a station'),
    siteName: z.string().nullable().describe('Name of the site, for display; null without a site'),
    scopeNow: z
      .object({
        site: countsSchema.optional().describe('Counts at the subject site now'),
        network: countsSchema
          .optional()
          .describe('Counts across every site now (users with access to every site only)'),
      })
      .passthrough()
      .nullable()
      .optional()
      .describe(
        'Detail with scopeNow=true only: the same counts as scope, computed at request time with the same SQL (no model call); null for kinds without a scope or when the counts could not be read',
      ),
    scopeNowAt: z
      .string()
      .nullable()
      .optional()
      .describe('Detail with scopeNow=true only: ISO time scopeNow was computed'),
  })
  .passthrough();

const languageField = z
  .enum(UI_LANGUAGES)
  .optional()
  .describe("Language of the summary (en, de, es, ko, zh, zh-TW); default the user's language");

const listQuery = paginationQuery.extend({
  stationId: z.string().optional().describe('Insights of a station'),
  sessionId: z.string().optional().describe('Insights of a session'),
  siteId: z.string().optional().describe('Insights of a site'),
  supportCaseId: z
    .string()
    .optional()
    .describe('Insights of a support case: its station and its linked sessions you can access'),
  authorizeAttemptIds: z
    .string()
    .regex(/^\d+(,\d+){0,99}$/)
    .optional()
    .describe(
      'Comma-separated authorize attempt ids (at most 100): the authorization insights covering any of them, grouped refusals included; each item then lists matchedAttemptIds',
    ),
  kind: z.enum(INSIGHT_KINDS).optional().describe('Filter by kind'),
  status: z.enum(INSIGHT_STATUSES).optional().describe('Filter by status'),
  category: z.enum(ROOT_CAUSE_CATEGORIES).optional().describe('Filter by root cause category'),
  language: languageField,
});

const idParams = z.object({ id: z.string().describe('Insight id') });
const detailQuery = z.object({
  language: languageField,
  scopeNow: z
    .enum(['true', 'false'])
    .optional()
    .describe('true: also count the scope now (scopeNow, scopeNowAt); SQL only, no model call'),
});
const feedbackBody = z.object({
  helpful: z.boolean().describe('true: the insight was helpful; false: it was wrong'),
});

/** The insight kinds an operator can regenerate (the scan's kinds). */
const REGENERATABLE: ReadonlySet<InsightKind> = new Set([
  'station_offline',
  'station_faulted',
  'station_alert',
  'session_failed',
  'authorization_refused',
  'site_incident',
]);

function kindSwitch(kind: InsightKind, settings: AiInsightSettings): boolean {
  if (kind === 'session_failed') return settings.sessionEnabled;
  if (kind === 'authorization_refused') return settings.authorizationEnabled;
  return settings.stationEnabled;
}

async function viewerLanguage(userId: string, requested: string | undefined): Promise<string> {
  if (requested != null) return requested;
  const [user] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const language = user?.language;
  return isUiLanguage(language) ? language : 'en';
}

async function insightInScope(id: string, siteIds: string[] | null): Promise<AiInsightRow | null> {
  const row = await getInsightRow(id);
  return row != null && siteInScope(siteIds, row.siteId) ? row : null;
}

/** Display names of the insights' stations (OCPP identity) and sites. */
async function recordNames(
  rows: readonly AiInsightRow[],
): Promise<{ stations: Map<string, string>; sites: Map<string, string> }> {
  const stationIds = [...new Set(rows.map((r) => r.stationId).filter((id) => id != null))];
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((id) => id != null))];
  const [stationRows, siteRows] = await Promise.all([
    stationIds.length === 0
      ? []
      : db
          .select({ id: chargingStations.id, name: chargingStations.stationId })
          .from(chargingStations)
          .where(inArray(chargingStations.id, stationIds)),
    siteIds.length === 0
      ? []
      : db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds)),
  ]);
  return {
    stations: new Map(stationRows.map((r) => [r.id, r.name])),
    sites: new Map(siteRows.map((r) => [r.id, r.name])),
  };
}

async function toView(
  rows: AiInsightRow[],
  language: string,
  allSites: boolean,
): Promise<Record<string, unknown>[]> {
  const [texts, stale, names] = await Promise.all([
    insightTexts(rows, language),
    staleFlags(rows),
    recordNames(rows),
  ]);
  return rows.map((row) => {
    const t = texts.get(row.id);
    return {
      ...toInsightDto(row, t, { language, allSites, stale: stale.get(row.id) ?? false }),
      originalSummary: originalSummary(t),
      stationName: row.stationId != null ? (names.stations.get(row.stationId) ?? null) : null,
      siteName: row.siteId != null ? (names.sites.get(row.siteId) ?? null) : null,
    };
  });
}

/** The case station and the linked sessions the user can access, or null when the case is out of scope. */
async function supportCaseFilter(
  caseId: string,
  siteIds: string[] | null,
): Promise<InsightListFilter['supportCase'] | null> {
  const conditions = [eq(supportCases.id, caseId)];
  if (siteIds != null) conditions.push(supportCaseSiteCondition(siteIds));
  const [caseRow] = await db
    .select({ stationId: supportCases.stationId })
    .from(supportCases)
    .where(and(...conditions))
    .limit(1);
  if (caseRow == null) return null;
  const linked = (
    await db
      .select({ sessionId: supportCaseSessions.sessionId })
      .from(supportCaseSessions)
      .where(eq(supportCaseSessions.caseId, caseId))
  ).map((r) => r.sessionId);
  const sessionIds = siteIds == null ? linked : [...(await sessionIdsInSites(linked, siteIds))];
  return { stationId: caseRow.stationId, sessionIds };
}

async function siteSwitchOn(row: AiInsightRow): Promise<boolean> {
  if (row.siteId == null) return true;
  const [site] = await db
    .select({ enabled: sites.aiInsightsEnabled })
    .from(sites)
    .where(eq(sites.id, row.siteId))
    .limit(1);
  return site?.enabled ?? true;
}

export interface AiInsightRouteOptions {
  /** The budget check run before a regeneration; tests pass a refusal. */
  checkBudgets?: CheckAiBudgets;
}

export function aiInsightRoutes(app: FastifyInstance, options: AiInsightRouteOptions = {}): void {
  const checkBudgets = options.checkBudgets ?? checkAiBudgets;

  app.get(
    '/ai/insights',
    {
      onRequest: [authorize('aiInsights:read')],
      schema: {
        tags: ['AI Insights'],
        summary: 'List automatic insights in your sites',
        operationId: 'listAiInsights',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 200: paginatedResponse(insightSchema) },
      },
    },
    async (request) => {
      const query = parseZodRequest(listQuery, request.query);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const filter: InsightListFilter = {};
      if (query.stationId != null) filter.stationId = query.stationId;
      if (query.sessionId != null) filter.sessionId = query.sessionId;
      if (query.siteId != null) filter.siteId = query.siteId;
      if (query.kind != null) filter.kind = query.kind;
      if (query.status != null) filter.status = query.status;
      if (query.category != null) filter.category = query.category;
      const attemptIds = query.authorizeAttemptIds?.split(',').map((id) => Number(id)) ?? null;
      if (attemptIds != null) filter.authorizeAttemptIds = attemptIds;
      if (query.supportCaseId != null) {
        const supportCase = await supportCaseFilter(query.supportCaseId, siteIds);
        if (supportCase == null) return { data: [], total: 0 };
        filter.supportCase = supportCase;
      }
      const { rows, total } = await listInsightRows(filter, siteIds, {
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      });
      const language = await viewerLanguage(userId, query.language);
      const data = await toView(rows, language, siteIds == null);
      if (attemptIds != null) {
        const covered = await insightCoveredAttempts(
          rows.map((r) => r.id),
          attemptIds,
        );
        for (const item of data) item['matchedAttemptIds'] = covered.get(String(item['id'])) ?? [];
      }
      return { data, total };
    },
  );

  app.get(
    '/ai/insights/:id',
    {
      onRequest: [authorize('aiInsights:read')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Get an automatic insight; asks for a translation into your language when missing',
        operationId: 'getAiInsight',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        querystring: zodSchema(detailQuery),
        response: {
          200: itemResponse(insightSchema),
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = parseZodRequest(idParams, request.params);
      const { language: requested, scopeNow: wantScopeNow } = parseZodRequest(
        detailQuery,
        request.query,
      );
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const row = await insightInScope(id, siteIds);
      if (row == null) return reply.status(404).send(NOT_FOUND);
      const language = await viewerLanguage(userId, requested);
      // A model summary is translated once per language and kept (decision D2).
      if (
        row.status === 'active' &&
        row.generatedBy === 'model' &&
        language !== row.primaryLanguage &&
        (await requestInsightTranslation(row.id, language))
      ) {
        await publishInsightRequest(getPubSub(), {
          kind: 'translate',
          insightId: row.id,
          language,
        });
      }
      const [view] = await toView([row], language, siteIds == null);
      if (wantScopeNow !== 'true') return view;
      // The live counts beside the snapshot: SQL only, fail-open (the snapshot still shows).
      const scopeNowAt = new Date().toISOString();
      let scopeNow: InsightScope | null = null;
      try {
        const live = await computeLiveInsightScope(row);
        scopeNow = live == null ? null : scopeForViewer(live, siteIds == null);
      } catch (err) {
        request.log.warn({ err, insightId: row.id }, 'Live insight scope failed');
      }
      return { ...view, scopeNow, scopeNowAt: scopeNow == null ? null : scopeNowAt };
    },
  );

  app.post(
    '/ai/insights/:id/regenerate',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Generate an automatic insight again from fresh evidence',
        operationId: 'regenerateAiInsight',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          202: itemResponse(
            z.object({ id: z.string().describe('Id of the new pending insight') }).passthrough(),
          ),
          400: errorWith('Insights are off for this insight, or it cannot be regenerated', [
            ERROR_CODES.AI_INSIGHTS_DISABLED,
          ]),
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
          429: errorWith('Cooldown or budget', [
            ERROR_CODES.AI_INSIGHT_COOLDOWN,
            ERROR_CODES.AI_SITE_BUDGET_EXCEEDED,
            ERROR_CODES.AI_MONTHLY_BUDGET_EXCEEDED,
            ERROR_CODES.AI_BUDGET_EXCEEDED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = parseZodRequest(idParams, request.params);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const row = await insightInScope(id, siteIds);
      if (row == null) return reply.status(404).send(NOT_FOUND);
      const kind = row.kind as InsightKind;
      const [opsEnabled, settings] = await Promise.all([isOpsAiEnabled(), getAiInsightSettings()]);
      if (
        !opsEnabled ||
        !REGENERATABLE.has(kind) ||
        !kindSwitch(kind, settings) ||
        !(await siteSwitchOn(row))
      ) {
        return reply.status(400).send({
          error: ERROR_MESSAGES.AI_INSIGHTS_DISABLED,
          code: ERROR_CODES.AI_INSIGHTS_DISABLED,
        });
      }
      const until = await insightCooldownUntil({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        kind: row.kind,
      });
      if (until != null) {
        return tooMany(reply, ERROR_CODES.AI_INSIGHT_COOLDOWN, until);
      }
      const budget = await checkBudgets({ surface: 'insight', userId, siteId: row.siteId });
      if (!budget.allowed) {
        return tooMany(reply, budget.code, new Date(Date.now() + budget.retryAfterSeconds * 1000));
      }
      const result = await regenerateInsight(row.id, {
        ...getAuditActor(request),
        actorUserId: userId,
      });
      if (result.status === 'not_allowed') {
        return reply.status(400).send({
          error: ERROR_MESSAGES.AI_INSIGHTS_DISABLED,
          code: ERROR_CODES.AI_INSIGHTS_DISABLED,
        });
      }
      if (result.status === 'busy') {
        return tooMany(reply, ERROR_CODES.AI_INSIGHT_COOLDOWN, new Date(Date.now() + 60_000));
      }
      const newId = result.insightId;
      await publishInsightRequest(getPubSub(), { kind: 'generate', insightId: newId });
      return reply.status(202).send({ id: newId });
    },
  );

  app.post(
    '/ai/insights/:id/dismiss',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Dismiss an automatic insight',
        operationId: 'dismissAiInsight',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: itemResponse(insightSchema),
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = parseZodRequest(idParams, request.params);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const row = await insightInScope(id, siteIds);
      if (row == null) return reply.status(404).send(NOT_FOUND);
      if (await dismissInsight(row.id, getAuditActor(request))) {
        await publishInsightUpdated(getPubSub(), { ...row, status: 'dismissed' });
      }
      const fresh = (await getInsightRow(row.id)) ?? row;
      const language = await viewerLanguage(userId, undefined);
      const [view] = await toView([fresh], language, siteIds == null);
      return view;
    },
  );

  app.post(
    '/ai/insights/:id/feedback',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Mark an automatic insight helpful or wrong',
        operationId: 'sendAiInsightFeedback',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(feedbackBody),
        response: {
          204: { type: 'null', description: 'Feedback recorded' },
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = parseZodRequest(idParams, request.params);
      const { helpful } = parseZodRequest(feedbackBody, request.body);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const row = await insightInScope(id, siteIds);
      if (row == null) return reply.status(404).send(NOT_FOUND);
      await recordInsightFeedback(row.id, helpful, getAuditActor(request));
      return reply.status(204).send();
    },
  );
}

async function tooMany(reply: FastifyReply, code: ErrorCode, until: Date): Promise<FastifyReply> {
  const seconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
  return reply
    .status(429)
    .header('Retry-After', String(seconds))
    .send({ error: ERROR_MESSAGES[code], code });
}
