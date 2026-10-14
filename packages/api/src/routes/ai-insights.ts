// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Automatic insight routes.
 * Reads need
 * `aiInsights:read`, regenerate, dismiss, feedback and the action decisions
 * `aiInsights:write`.
 * Feedback is one vote per user and insight (`ai_insight_feedback`); votes
 * and their notes never feed any prompt.
 * Actions: a background worker suggestion is an insight that carries an
 * action (`action` on every item). It runs only when an operator confirms it
 * (`POST /ai/insights/:id/action/confirm`), in an interactive session, as
 * that operator (`executeConfirmedToolCall`): the route the action names
 * applies its own RBAC and site scope at confirm time. API keys can read
 * actions but never confirm or reject one (decision D8). Dismissing an
 * insight with a pending action rejects the action.
 * Site scope: a list holds the user's sites only (unsited insights for
 * all-site users only); a detail outside the user's sites answers the same
 * 404 `AI_INSIGHT_NOT_FOUND` as a missing one. Scope counts are the
 * subject site's only. Not cached (per-user scope, `response-cache.md`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  authorizeAttempts,
  chargingStations,
  checkAiBudgets,
  drivers,
  driverTokens,
  getAiInsightSettings,
  isReservationEnabled,
  isOpsAiEnabled,
  reservations,
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
  INSIGHT_FEEDBACK_FILTERS,
  INSIGHT_FEEDBACK_REASON_MAX_LENGTH,
  INSIGHT_FEEDBACK_SUMMARY_DAYS,
  INSIGHT_GENERATORS,
  INSIGHT_KINDS,
  INSIGHT_LIVE_STATUSES,
  INSIGHT_SKIP_REASONS,
  INSIGHT_STATUSES,
  INSIGHT_TEXT_STATUSES,
  INSIGHT_VISIBLE_STATUSES,
  isReservationInsightKind,
  isVisibleInsightStatus,
  isWorkerActionInsightKind,
  RESERVATION_INSIGHT_KINDS,
  ROOT_CAUSE_CATEGORIES,
} from '@evtivity/lib/ai-insights';
import {
  AI_PROPOSAL_PRECONDITION_KINDS,
  AI_WORKER_JOBS,
  aiProposalConfirmBody,
  aiProposalPreconditionSchema,
  findAiWorkerAction,
  workerActionArgsAllowed,
} from '@evtivity/lib/ai-proposals';
import {
  aiProposalPreconditionHolds,
  claimAiProposal,
  finishAiProposal,
  getInsightActionRow,
  insightActionRows,
  rejectAiProposal,
  toAiProposalDto,
} from '@evtivity/services/ai-proposal.service';
import type { AiProposalRow } from '@evtivity/services/ai-proposal.service';
import type { InsightKind } from '@evtivity/lib/ai-insights';
import type { CheckAiBudgets } from '@evtivity/lib/ai-usage';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  clearInsightFeedback,
  dismissInsight,
  getInsightRow,
  insightFeedbackRates,
  insightFeedbackSummary,
  insightCooldownUntil,
  insightCoveredAttempts,
  insightTexts,
  listInsightRows,
  originalSummary,
  publishInsightRequest,
  publishInsightUpdated,
  regenerateInsight,
  requestInsightTranslation,
  setInsightFeedback,
  staleFlags,
  toInsightDto,
} from '@evtivity/services/ai-insight.service';
import type { AiInsightRow, InsightListFilter } from '@evtivity/services/ai-insight.service';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import { errorWith, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import type { ErrorCode } from '../lib/error-codes.generated.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { insightRowVisible } from '../lib/ai-insight-scope.js';
import { supportCaseSiteCondition } from '../lib/support-case-scope.js';
import { sessionIdsInSites } from '../lib/support-case-redaction.js';
import { getAuditActor } from '../lib/audit-actor.js';
import type { JwtPayload } from '../plugins/auth.js';
import { callerAuthorization } from '../services/ai/engine/route-support.js';
import { executeConfirmedToolCall } from '../services/ai/tools/execute.js';
import type { ConfirmedToolCallResult } from '../services/ai/tools/execute.js';

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

const actionSchema = z
  .object({
    id: z.string().describe('Action ID'),
    job: z.enum(AI_WORKER_JOBS).nullable().describe('The background worker job that suggested it'),
    insightId: z.string().describe('The insight that carries the action'),
    siteId: z.string().nullable().describe('Site of the target'),
    stationId: z.string().nullable().describe('Target station ID'),
    sessionId: z.string().nullable().describe('Target session ID'),
    operationId: z.string().describe('The API operation the action runs'),
    method: z.string().describe('HTTP method of the operation'),
    path: z.string().describe('Path of the operation'),
    args: z.record(z.unknown()).describe('The arguments the operation runs with'),
    argsHash: z.string().describe('Hash of the arguments; send it back to confirm'),
    summary: z.record(z.unknown()).describe('Structured fields for the confirmation card'),
    precondition: z
      .object({
        kind: z.enum(AI_PROPOSAL_PRECONDITION_KINDS).describe('What must still hold at confirm'),
        params: z.record(z.unknown()).describe('Parameters of the check'),
      })
      .passthrough()
      .nullable()
      .describe('Checked again at confirm; an action whose precondition fails ends stale'),
    expiresAt: z.string().describe('ISO datetime after which it can no longer be confirmed'),
    decidedBy: z.string().nullable().describe('User who confirmed or rejected it'),
    decidedByName: z
      .string()
      .nullable()
      .describe('Name of the user who confirmed or rejected it; null while undecided'),
    decidedAt: z.string().nullable().describe('ISO datetime of the decision'),
    executedAt: z.string().nullable().describe('ISO datetime the operation ran'),
    result: z
      .object({
        httpStatus: z.number().int().describe('HTTP status the operation answered; 0 when refused'),
        body: z.unknown().optional().describe('Redacted excerpt of the answer, or the refusal'),
      })
      .passthrough()
      .nullable()
      .describe('The operation result, once it ran'),
    createdAt: z.string().describe('ISO datetime'),
  })
  .passthrough();

const insightSchema = z
  .object({
    id: z.string().describe('Insight id'),
    kind: z.enum(INSIGHT_KINDS).describe('What raised the insight'),
    status: z
      .enum(INSIGHT_STATUSES)
      .describe(
        'The one status of the insight and its action: open, pending (the action waits for a decision), done (the action ran), rejected (the action was rejected), resolved, dismissed or expired (the action expired). Lists never return the internal generation states (analyzing, skipped, failed, superseded); a single insight read can (after a regeneration). Localize aiInsights.status.<value>',
      ),
    skipReason: z.enum(INSIGHT_SKIP_REASONS).nullable().describe('Why it ended skipped'),
    siteId: z.string().nullable().describe('Site of the subject; null for an unsited station'),
    stationId: z.string().nullable().describe('Station of the subject'),
    sessionId: z.string().nullable().describe('Session of a session insight'),
    authorizeAttemptId: z
      .number()
      .int()
      .nullable()
      .describe('First refused attempt of an authorization insight'),
    reservationId: z.string().nullable().describe('Reservation of a reservation insight'),
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
    action: actionSchema
      .nullable()
      .describe(
        'The action the insight carries (a background worker suggestion), or null; it runs only when an operator confirms it',
      ),
    stationName: z
      .string()
      .nullable()
      .describe('OCPP identity of the station, for display; null without a station'),
    siteName: z.string().nullable().describe('Name of the site, for display; null without a site'),
    reservationNumber: z
      .number()
      .int()
      .nullable()
      .describe('OCPP reservation id of the reservation, for display; null without a reservation'),
    driverId: z
      .string()
      .nullable()
      .describe(
        'Driver the insight names: the driver of a reservation insight, or the driver matched by the refused token of an authorization insight; null when none',
      ),
    driverName: z
      .string()
      .nullable()
      .describe(
        'Name (else email) of the driver, for display; null without drivers:read or when the driver no longer exists',
      ),
    tokenId: z
      .string()
      .nullable()
      .describe('Driver token matched by the refused attempt of an authorization insight'),
    tokenLabel: z
      .string()
      .nullable()
      .describe(
        'idToken of that token, for display; null without drivers:read or when the token no longer exists',
      ),
    feedback: z
      .object({
        helpfulCount: z.number().int().describe('Users who marked the insight helpful'),
        wrongCount: z.number().int().describe('Users who marked the insight wrong'),
        mine: z.boolean().nullable().describe('Your vote: true helpful, false wrong, null none'),
      })
      .optional()
      .describe(
        'Detail with feedback=true only: the votes on the insight (one per user) and yours; notes are never returned',
      ),
  })
  .passthrough();

const languageField = z
  .enum(UI_LANGUAGES)
  .optional()
  .describe("Language of the summary (en, de, es, ko, zh, zh-TW); default the user's language");

/** One shown status, or several comma-separated (`open,pending`). */
const STATUS_FILTER_PATTERN = new RegExp(
  `^(${INSIGHT_VISIBLE_STATUSES.join('|')})(,(${INSIGHT_VISIBLE_STATUSES.join('|')}))*$`,
);

const listQuery = paginationQuery.extend({
  stationId: z
    .string()
    .optional()
    .describe(
      'Insights of a station and its sessions; reservation insights only with kind or reservationId',
    ),
  sessionId: z.string().optional().describe('Insights of a session'),
  reservationId: z.string().optional().describe('Insights of a reservation'),
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
  status: z
    .string()
    .regex(STATUS_FILTER_PATTERN)
    .optional()
    .describe(
      'Filter by status, one or several comma-separated: open, pending, done, rejected, resolved, dismissed, expired',
    ),
  category: z.enum(ROOT_CAUSE_CATEGORIES).optional().describe('Filter by root cause category'),
  feedback: z
    .enum(INSIGHT_FEEDBACK_FILTERS)
    .optional()
    .describe('helpful or wrong: insights at least one user marked so'),
  language: languageField,
});

const idParams = z.object({ id: z.string().describe('Insight id') });
const detailQuery = z.object({
  language: languageField,
  feedback: z
    .enum(['true', 'false'])
    .optional()
    .describe('true: also return the vote counts and your vote (feedback)'),
});
const feedbackBody = z
  .object({
    helpful: z.boolean().describe('true: the insight was helpful; false: it was wrong'),
    reason: z
      .string()
      .max(INSIGHT_FEEDBACK_REASON_MAX_LENGTH)
      .nullable()
      .optional()
      .describe(
        'Wrong votes only: a short note on what is wrong (stored only, never sent to a model); omitted keeps the stored note, null or empty removes it',
      ),
  })
  .refine((b) => !b.helpful || b.reason == null || b.reason.trim() === '', {
    message: 'A reason is only taken with a wrong vote',
    path: ['reason'],
  });

/** The insight kinds an operator can regenerate (the scan's kinds). */
const REGENERATABLE: ReadonlySet<InsightKind> = new Set([
  'station_offline',
  'station_faulted',
  'station_alert',
  'session_failed',
  'authorization_refused',
  'site_incident',
  ...RESERVATION_INSIGHT_KINDS,
]);

function kindSwitch(kind: InsightKind, settings: AiInsightSettings): boolean {
  // Worker suggestions follow their job's switch and are never regenerated.
  if (isWorkerActionInsightKind(kind)) return false;
  if (isReservationInsightKind(kind)) return settings.reservationEnabled;
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

/**
 * The insight when the caller may see it (`insightRowVisible`: in their
 * sites, a reservation insight only while reservations are on). Every
 * `/ai/insights/:id` route resolves its insight here; the neighbors route
 * applies the same gate in SQL (ai-insight-scope.test.ts guards both).
 */
async function insightInScope(id: string, siteIds: string[] | null): Promise<AiInsightRow | null> {
  const row = await getInsightRow(id);
  if (row == null || !(await insightRowVisible(row, siteIds))) return null;
  return row;
}

interface RecordNames {
  stations: Map<string, string>;
  sites: Map<string, string>;
  reservations: Map<string, { number: number; driverId: string | null }>;
  attempts: Map<number, { tokenId: string | null; driverId: string | null }>;
  /** Filled only for callers with `drivers:read`. */
  drivers: Map<string, string>;
  tokens: Map<string, string>;
}

function distinct<T>(values: readonly (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

/**
 * Display labels of the records the insights name: station (OCPP identity),
 * site, reservation (OCPP reservation id), and the driver and token of a
 * reservation or authorization insight. Driver names and idTokens are
 * personal data, so they are read only for callers with `drivers:read`; a
 * record that no longer exists has no label and the CSMS shows its plain id.
 */
async function recordNames(
  rows: readonly AiInsightRow[],
  canReadDrivers: boolean,
): Promise<RecordNames> {
  const stationIds = distinct(rows.map((r) => r.stationId));
  const siteIds = distinct(rows.map((r) => r.siteId));
  const reservationIds = distinct(rows.map((r) => r.reservationId));
  const attemptIds = distinct(rows.map((r) => r.authorizeAttemptId));
  const [stationRows, siteRows, reservationRows, attemptRows] = await Promise.all([
    stationIds.length === 0
      ? []
      : db
          .select({ id: chargingStations.id, name: chargingStations.stationId })
          .from(chargingStations)
          .where(inArray(chargingStations.id, stationIds)),
    siteIds.length === 0
      ? []
      : db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds)),
    reservationIds.length === 0
      ? []
      : db
          .select({
            id: reservations.id,
            number: reservations.reservationId,
            driverId: reservations.driverId,
          })
          .from(reservations)
          .where(inArray(reservations.id, reservationIds)),
    attemptIds.length === 0
      ? []
      : db
          .select({
            id: authorizeAttempts.id,
            tokenId: authorizeAttempts.matchedTokenId,
            driverId: authorizeAttempts.matchedDriverId,
          })
          .from(authorizeAttempts)
          .where(inArray(authorizeAttempts.id, attemptIds)),
  ]);
  const driverIds = canReadDrivers
    ? distinct([...reservationRows.map((r) => r.driverId), ...attemptRows.map((r) => r.driverId)])
    : [];
  const tokenIds = canReadDrivers ? distinct(attemptRows.map((r) => r.tokenId)) : [];
  const [driverRows, tokenRows] = await Promise.all([
    driverIds.length === 0
      ? []
      : db
          .select({
            id: drivers.id,
            firstName: drivers.firstName,
            lastName: drivers.lastName,
            email: drivers.email,
          })
          .from(drivers)
          .where(inArray(drivers.id, driverIds)),
    tokenIds.length === 0
      ? []
      : db
          .select({ id: driverTokens.id, idToken: driverTokens.idToken })
          .from(driverTokens)
          .where(inArray(driverTokens.id, tokenIds)),
  ]);
  const driverNames = new Map<string, string>();
  for (const d of driverRows) {
    const label = userName(d) ?? d.email;
    if (label != null && label !== '') driverNames.set(d.id, label);
  }
  return {
    stations: new Map(stationRows.map((r) => [r.id, r.name])),
    sites: new Map(siteRows.map((r) => [r.id, r.name])),
    reservations: new Map(
      reservationRows.map((r) => [r.id, { number: r.number, driverId: r.driverId }]),
    ),
    attempts: new Map(attemptRows.map((r) => [r.id, { tokenId: r.tokenId, driverId: r.driverId }])),
    drivers: driverNames,
    tokens: new Map(tokenRows.map((r) => [r.id, r.idToken])),
  };
}

/** The labelled records of one insight (`recordNames`), as view fields. */
function recordFields(row: AiInsightRow, names: RecordNames): Record<string, unknown> {
  const reservation = row.reservationId != null ? names.reservations.get(row.reservationId) : null;
  const attempt =
    row.authorizeAttemptId != null ? names.attempts.get(row.authorizeAttemptId) : null;
  const driverId = reservation?.driverId ?? attempt?.driverId ?? null;
  const tokenId = attempt?.tokenId ?? null;
  return {
    stationName: row.stationId != null ? (names.stations.get(row.stationId) ?? null) : null,
    siteName: row.siteId != null ? (names.sites.get(row.siteId) ?? null) : null,
    reservationNumber: reservation?.number ?? null,
    driverId,
    driverName: driverId != null ? (names.drivers.get(driverId) ?? null) : null,
    tokenId,
    tokenLabel: tokenId != null ? (names.tokens.get(tokenId) ?? null) : null,
  };
}

/** The user's name, never the email: insight readers need not see other operators' addresses. */
function userName(u: { firstName: string | null; lastName: string | null }): string | null {
  const name = [u.firstName, u.lastName].filter((p) => p != null && p !== '').join(' ');
  return name !== '' ? name : null;
}

/** The actions of the insights, as DTOs with the deciding user's name. */
async function actionViews(
  rows: readonly AiInsightRow[],
): Promise<Map<string, Record<string, unknown> & ReturnType<typeof toAiProposalDto>>> {
  const actions = await insightActionRows(rows.map((r) => r.id));
  const deciders = [
    ...new Set([...actions.values()].map((a) => a.decidedBy).filter((id) => id != null)),
  ];
  const userRows =
    deciders.length === 0
      ? []
      : await db
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(inArray(users.id, deciders));
  const names = new Map(userRows.map((u) => [u.id, userName(u)]));
  const out = new Map<string, Record<string, unknown> & ReturnType<typeof toAiProposalDto>>();
  for (const [insightId, action] of actions) {
    out.set(insightId, {
      ...toAiProposalDto(action),
      decidedByName: action.decidedBy != null ? (names.get(action.decidedBy) ?? null) : null,
    });
  }
  return out;
}

async function toView(
  rows: AiInsightRow[],
  language: string,
  request: FastifyRequest,
): Promise<Record<string, unknown>[]> {
  const canReadDrivers = await requestHasPermission(request, 'drivers:read');
  const [texts, stale, names, actions] = await Promise.all([
    insightTexts(rows, language),
    staleFlags(rows),
    recordNames(rows, canReadDrivers),
    actionViews(rows),
  ]);
  return rows.map((row) => {
    const t = texts.get(row.id);
    const action = actions.get(row.id) ?? null;
    return {
      ...toInsightDto(row, t, { language, stale: stale.get(row.id) ?? false, action }),
      // The action again with its display name (the DTO schema keeps known fields only).
      action,
      originalSummary: originalSummary(t),
      ...recordFields(row, names),
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
        description:
          'Newest first. Lists and totals hold the shown statuses only (open, pending, done, rejected, resolved, dismissed, expired), never the internal generation states.',
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
      // Reservation insights only while reservations are on (cached reader, P6).
      if (!(await isReservationEnabled())) filter.excludeReservations = true;
      if (query.stationId != null) filter.stationId = query.stationId;
      if (query.sessionId != null) filter.sessionId = query.sessionId;
      if (query.reservationId != null) filter.reservationId = query.reservationId;
      if (query.siteId != null) filter.siteId = query.siteId;
      if (query.kind != null) filter.kind = query.kind;
      if (query.status != null) {
        filter.statuses = [
          ...new Set(query.status.split(',').filter((v) => isVisibleInsightStatus(v))),
        ];
      }
      if (query.category != null) filter.category = query.category;
      if (query.feedback != null) filter.feedback = query.feedback;
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
      const data = await toView(rows, language, request);
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
    '/ai/insights/feedback-summary',
    {
      onRequest: [authorize('aiInsights:read')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Helpful and wrong votes on automatic insights by kind, last 30 days',
        operationId: 'getAiInsightFeedbackSummary',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                days: z
                  .number()
                  .int()
                  .describe('Window in days, counted by when the vote was given'),
                data: z
                  .array(
                    z
                      .object({
                        kind: z.enum(INSIGHT_KINDS).describe('Insight kind'),
                        helpful: z.number().int().describe('Helpful votes'),
                        wrong: z.number().int().describe('Wrong votes'),
                      })
                      .passthrough(),
                  )
                  .describe('Kinds with at least one vote, insights in your sites only'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const data = await insightFeedbackRates(siteIds, {
        days: INSIGHT_FEEDBACK_SUMMARY_DAYS,
        excludeReservations: !(await isReservationEnabled()),
      });
      return { days: INSIGHT_FEEDBACK_SUMMARY_DAYS, data };
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
      const { language: requested, feedback: wantFeedback } = parseZodRequest(
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
        (INSIGHT_LIVE_STATUSES as readonly string[]).includes(row.status) &&
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
      const [rendered] = await toView([row], language, request);
      // Counts and the viewer's vote in one aggregate query, only when asked.
      return wantFeedback === 'true'
        ? { ...rendered, feedback: await insightFeedbackSummary(row.id, userId) }
        : rendered;
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
            z
              .object({
                id: z.string().describe('Id of the new insight, analyzing until generated'),
              })
              .passthrough(),
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
        description:
          'Closes the insight (status dismissed). A pending action it carries is rejected with it; an action a confirm is running answers 409 AI_PROPOSAL_ALREADY_DECIDED.',
        response: {
          200: itemResponse(insightSchema),
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
          409: errorWith('The action is being confirmed', [
            ERROR_CODES.AI_PROPOSAL_ALREADY_DECIDED,
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
      const action = await getInsightActionRow(row.id);
      // The pending action is rejected first (compare-and-set): a confirm that
      // claimed it meanwhile wins, and the insight stays as it is. A won
      // rejection closes the insight dismissed, its one status.
      if (action?.status === 'pending') {
        const rejection = await rejectAiProposal(
          action.id,
          { ...getAuditActor(request), actorUserId: userId },
          request.log,
          { dismissInsight: true },
        );
        if (rejection.kind === 'decided') {
          return sendActionError(reply, 409, 'AI_PROPOSAL_ALREADY_DECIDED');
        }
      }
      // No action pending, or the rejection's insight close failed (fail-open):
      // dismiss the insight itself. A no-op when the rejection closed it.
      if (await dismissInsight(row.id, getAuditActor(request))) {
        await publishInsightUpdated(getPubSub(), { ...row, status: 'dismissed' });
      }
      const fresh = (await getInsightRow(row.id)) ?? row;
      const language = await viewerLanguage(userId, undefined);
      const [view] = await toView([fresh], language, request);
      return view;
    },
  );

  app.post(
    '/ai/insights/:id/feedback',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Set or change your vote on an automatic insight: helpful or wrong',
        description:
          'One vote per user and insight. Voting again replaces your vote; the same vote again changes nothing. A wrong vote can carry a short note, stored only and never sent to a model.',
        operationId: 'sendAiInsightFeedback',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(feedbackBody),
        response: {
          204: { type: 'null', description: 'Vote stored' },
          404: errorWith('Insight not found', [ERROR_CODES.AI_INSIGHT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = parseZodRequest(idParams, request.params);
      const { helpful, reason } = parseZodRequest(feedbackBody, request.body);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const row = await insightInScope(id, siteIds);
      if (row == null) return reply.status(404).send(NOT_FOUND);
      await setInsightFeedback(row.id, userId, { helpful, reason }, getAuditActor(request));
      return reply.status(204).send();
    },
  );

  app.delete(
    '/ai/insights/:id/feedback',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Remove your vote on an automatic insight',
        operationId: 'clearAiInsightFeedback',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          204: { type: 'null', description: 'Vote removed, or there was none' },
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
      await clearInsightFeedback(row.id, userId, getAuditActor(request));
      return reply.status(204).send();
    },
  );

  aiInsightActionRoutes(app);
}

type ActionErrorCode =
  | 'AI_PROPOSAL_NOT_FOUND'
  | 'AI_PROPOSAL_EXPIRED'
  | 'AI_PROPOSAL_STALE'
  | 'AI_PROPOSAL_ALREADY_DECIDED'
  | 'AI_CONFIRMATION_REQUIRES_SESSION'
  | 'VALIDATION_ERROR';

async function sendActionError(
  reply: FastifyReply,
  status: number,
  code: ActionErrorCode,
): Promise<FastifyReply> {
  return reply.status(status).send({ error: ERROR_MESSAGES[code], code });
}

/** 409 for an action that is no longer open to a decision. */
async function decidedError(reply: FastifyReply, row: AiProposalRow): Promise<FastifyReply> {
  if (row.status === 'expired') return sendActionError(reply, 409, 'AI_PROPOSAL_EXPIRED');
  if (row.status === 'stale') return sendActionError(reply, 409, 'AI_PROPOSAL_STALE');
  return sendActionError(reply, 409, 'AI_PROPOSAL_ALREADY_DECIDED');
}

function isApiKeyRequest(request: FastifyRequest): boolean {
  return (request.user as JwtPayload).isApiKey === true;
}

/** Worker actions run only the closed action set, also after the OCPP version mapping. */
function workerActionAllowed(operationId: string, args: Readonly<Record<string, unknown>>) {
  const action = findAiWorkerAction(operationId);
  return action !== undefined && workerActionArgsAllowed(action, args);
}

/** The stored outcome of a confirm, from what the confirmed call did. */
function outcomeOf(result: Exclude<ConfirmedToolCallResult, { kind: 'expired' | 'stale' }>) {
  if (result.kind === 'refused') {
    return {
      status: 'failed' as const,
      // The reason code only; the CSMS localizes it (no English text stored).
      result: { httpStatus: 0, body: { refused: result.reason } },
    };
  }
  return {
    status: result.httpStatus < 400 ? ('executed' as const) : ('failed' as const),
    result: {
      httpStatus: result.httpStatus,
      body: { operationId: result.operationId, response: result.body },
    },
  };
}

/**
 * The insight in the caller's scope and the action it carries. Answers 404
 * (`AI_INSIGHT_NOT_FOUND`, then `AI_PROPOSAL_NOT_FOUND`) before anything else,
 * then 403 for an API key, so a key learns nothing about insights it cannot
 * see (decision D8).
 */
async function decidableAction(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ insight: AiInsightRow; action: AiProposalRow } | null> {
  const { id } = parseZodRequest(idParams, request.params);
  const { userId } = request.user as JwtPayload;
  const insight = await insightInScope(id, await getUserSiteIds(userId));
  if (insight == null) {
    await reply.status(404).send(NOT_FOUND);
    return null;
  }
  const action = await getInsightActionRow(insight.id);
  if (action == null) {
    await sendActionError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
    return null;
  }
  if (isApiKeyRequest(request)) {
    await sendActionError(reply, 403, 'AI_CONFIRMATION_REQUIRES_SESSION');
    return null;
  }
  if (action.status !== 'pending') {
    await decidedError(reply, action);
    return null;
  }
  // The insight's status decides: an insight resolved or dismissed while its
  // action waited no longer takes a decision.
  if (insight.status !== 'pending') {
    await sendActionError(
      reply,
      409,
      insight.status === 'resolved' ? 'AI_PROPOSAL_STALE' : 'AI_PROPOSAL_ALREADY_DECIDED',
    );
    return null;
  }
  return { insight, action };
}

async function insightView(
  request: FastifyRequest,
  insightId: string,
): Promise<Record<string, unknown> | null> {
  const row = await getInsightRow(insightId);
  if (row == null) return null;
  const { userId } = request.user as JwtPayload;
  const [view] = await toView([row], await viewerLanguage(userId, undefined), request);
  return view ?? null;
}

const actionDecisionErrors = {
  403: errorWith('Deciding needs a signed-in session', [
    ERROR_CODES.AI_CONFIRMATION_REQUIRES_SESSION,
  ]),
  404: errorWith('Insight or action not found', [
    ERROR_CODES.AI_INSIGHT_NOT_FOUND,
    ERROR_CODES.AI_PROPOSAL_NOT_FOUND,
  ]),
  409: errorWith('The action is no longer open to a decision', [
    ERROR_CODES.AI_PROPOSAL_EXPIRED,
    ERROR_CODES.AI_PROPOSAL_STALE,
    ERROR_CODES.AI_PROPOSAL_ALREADY_DECIDED,
  ]),
};

/** Confirm and reject of the action an insight carries (registered by `aiInsightRoutes`). */
function aiInsightActionRoutes(app: FastifyInstance): void {
  app.post(
    '/ai/insights/:id/action/confirm',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Confirm and run the action an insight carries',
        description:
          "Runs the action once, as the caller: the precondition and the station's OCPP version are checked again, then the operation runs with the caller's own permissions and site access. A route refusal (403, 404) is recorded and the action ends failed. The insight closes with the action. Needs a signed-in session: API keys get 403 AI_CONFIRMATION_REQUIRES_SESSION.",
        operationId: 'confirmAiInsightAction',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(
          aiProposalConfirmBody.extend({
            argsHash: z.string().min(1).max(64).describe('argsHash of the action as shown'),
          }),
        ),
        response: {
          200: itemResponse(insightSchema),
          400: errorWith('The arguments shown differ from the action', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          ...actionDecisionErrors,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { argsHash } = request.body as z.infer<typeof aiProposalConfirmBody>;
      const target = await decidableAction(request, reply);
      if (target === null) return reply;
      const { insight, action: row } = target;
      if (argsHash !== row.argsHash) return sendActionError(reply, 400, 'VALIDATION_ERROR');

      const actor = { actor: 'operator' as const, actorUserId: userId };
      const claim = await claimAiProposal(row.id, actor, request.log);
      if (claim.kind === 'not_found') return sendActionError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      if (claim.kind !== 'claimed') return decidedError(reply, claim.row);

      const claimed = claim.row;
      // A stored precondition that no longer parses fails closed: the action ends stale.
      const parsed =
        claimed.precondition == null
          ? null
          : aiProposalPreconditionSchema.safeParse(claimed.precondition);
      const precondition = parsed === null ? null : parsed.success ? parsed.data : undefined;
      let result: ConfirmedToolCallResult;
      try {
        result = await executeConfirmedToolCall(
          app,
          {
            userId,
            authorization: callerAuthorization(request),
            hasPermission: (permission) => requestHasPermission(request, permission),
          },
          {
            operationId: claimed.operationId,
            args: claimed.args as Record<string, unknown>,
            argsHash: claimed.argsHash,
            expiresAt: claimed.expiresAt,
            via: { channel: 'proposal', proposalId: claimed.id, confirmedBy: userId },
            allowAction: workerActionAllowed,
            ...(precondition === undefined
              ? { precondition: () => Promise.resolve(false) }
              : precondition !== null
                ? { precondition: () => aiProposalPreconditionHolds(precondition) }
                : {}),
          },
        );
      } catch (err) {
        // Fail loud, but never leave the claim behind: whether the route ran
        // is unknown, so the action ends failed and is never retried (P9).
        request.log.error({ err, proposalId: claimed.id }, 'AI insight action confirm failed');
        await finishAiProposal(
          claimed.id,
          actor,
          { status: 'failed', result: { httpStatus: 0, body: { error: 'confirm_error' } } },
          request.log,
        );
        throw err;
      }
      if (result.kind === 'expired' || result.kind === 'stale') {
        await finishAiProposal(claimed.id, actor, { status: result.kind }, request.log);
        return sendActionError(
          reply,
          409,
          result.kind === 'expired' ? 'AI_PROPOSAL_EXPIRED' : 'AI_PROPOSAL_STALE',
        );
      }
      if (result.kind === 'refused') {
        request.log.info(
          { proposalId: claimed.id, operationId: claimed.operationId, reason: result.reason },
          'AI insight action refused at confirm',
        );
      }
      const finished = await finishAiProposal(claimed.id, actor, outcomeOf(result), request.log);
      if (finished === null) {
        // The sweep ended the claim first (a confirm past the claim timeout).
        const current = await getInsightActionRow(insight.id);
        return decidedError(reply, current ?? claimed);
      }
      const view = await insightView(request, insight.id);
      if (view == null) return reply.status(404).send(NOT_FOUND);
      return view;
    },
  );

  app.post(
    '/ai/insights/:id/action/reject',
    {
      onRequest: [authorize('aiInsights:write')],
      schema: {
        tags: ['AI Insights'],
        summary: 'Reject the action an insight carries',
        description:
          'Records the rejection; the action never runs and the insight is dismissed. Needs a signed-in session: API keys get 403 AI_CONFIRMATION_REQUIRES_SESSION.',
        operationId: 'rejectAiInsightAction',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: itemResponse(insightSchema),
          ...actionDecisionErrors,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const target = await decidableAction(request, reply);
      if (target === null) return reply;
      const rejection = await rejectAiProposal(
        target.action.id,
        { actor: 'operator', actorUserId: userId },
        request.log,
      );
      if (rejection.kind === 'not_found') {
        return sendActionError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      }
      if (rejection.kind !== 'rejected') return decidedError(reply, rejection.row);
      const view = await insightView(request, target.insight.id);
      if (view == null) return reply.status(404).send(NOT_FOUND);
      return view;
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
