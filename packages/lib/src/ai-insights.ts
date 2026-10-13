// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Automatic insights: the shared contract between the worker that generates
 * them, the API that serves them and the CSMS that shows them. Browser-safe
 * (`@evtivity/lib/ai-insights`).
 *
 * A model answers in `InsightModelOutput`: a category and fix codes from the
 * closed lists below, a confidence, a short plain-text summary and the ids of
 * the evidence it used. The CSMS renders category, confidence, fixes and scope
 * through locale keys (`aiInsights.category.<category>`,
 * `aiInsights.fix.<code>`), so only the summary is model text.
 *
 * A background worker suggestion is an insight that carries an action
 * (`WORKER_ACTION_INSIGHT_KINDS`, `action` on the DTO): a write that runs only
 * when an operator confirms it (`@evtivity/lib/ai-proposals`).
 */
import { z } from 'zod';
import { aiProposalDtoSchema } from './ai-proposals.js';

/** Insight kinds raised from `reservation_audit_log` rows (v0.1.45). */
export const RESERVATION_INSIGHT_KINDS = [
  'reservation_rejected',
  'reservation_no_show',
  'reservation_cancel_failed',
  'reservation_fee_failed',
  'reservation_station_faulted',
] as const;
export type ReservationInsightKind = (typeof RESERVATION_INSIGHT_KINDS)[number];

export const INSIGHT_KINDS = [
  'station_offline',
  'station_faulted',
  'station_alert',
  'session_failed',
  'authorization_refused',
  'site_incident',
  'site_summary',
  'company_summary',
  'tariff_anomaly',
  'stuck_session',
  'station_long_faulted',
  ...RESERVATION_INSIGHT_KINDS,
] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/**
 * Insights a background worker writes with an action to confirm: a stop for
 * a stuck session (job `stuck_sessions`), a soft reset for a station faulted
 * for hours (job `network_summary`). Their lifecycle follows the action: an
 * executed, failed, stale or expired action resolves the insight, a rejected
 * one dismisses it.
 */
export const WORKER_ACTION_INSIGHT_KINDS = ['stuck_session', 'station_long_faulted'] as const;
export type WorkerActionInsightKind = (typeof WORKER_ACTION_INSIGHT_KINDS)[number];

export function isWorkerActionInsightKind(kind: string): kind is WorkerActionInsightKind {
  return (WORKER_ACTION_INSIGHT_KINDS as readonly string[]).includes(kind);
}

/**
 * The one status of an insight and the action it carries
 * (`ai_insights.status`), shown as one badge. Lists, filters, counts and
 * badges read only it:
 * - `open`: the problem stands and no action waits;
 * - `pending`: its action waits for a decision;
 * - `done`: the action ran;
 * - `rejected`: the action was rejected;
 * - `resolved`: the condition cleared (or the action no longer applied);
 * - `dismissed`: an operator dismissed it;
 * - `expired`: the action expired undecided.
 * `done`, `rejected`, `resolved`, `dismissed` and `expired` are terminal.
 */
export const INSIGHT_VISIBLE_STATUSES = [
  'open',
  'pending',
  'done',
  'rejected',
  'resolved',
  'dismissed',
  'expired',
] as const;
export type InsightVisibleStatus = (typeof INSIGHT_VISIBLE_STATUSES)[number];

/**
 * Generation states, internal: `analyzing` (the generation runs), `skipped`,
 * `failed` and `superseded` (a regenerated insight, or a site incident member).
 * Never listed, filtered, counted or shown as a badge.
 */
export const INSIGHT_INTERNAL_STATUSES = ['analyzing', 'skipped', 'failed', 'superseded'] as const;

/** Every stored status. */
export const INSIGHT_STATUSES = [
  ...INSIGHT_INTERNAL_STATUSES,
  ...INSIGHT_VISIBLE_STATUSES,
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/** Shown and not terminal: the insight still asks for attention. */
export const INSIGHT_LIVE_STATUSES = [
  'open',
  'pending',
] as const satisfies readonly InsightStatus[];

export function isVisibleInsightStatus(status: string): status is InsightVisibleStatus {
  return (INSIGHT_VISIBLE_STATUSES as readonly string[]).includes(status);
}

/** Why an insight ended `skipped` without a model call. */
export const INSIGHT_SKIP_REASONS = [
  'resolved_before_analysis',
  'cooldown',
  'site_daily_cap',
  'site_disabled',
  'budget_exceeded',
  /** `opsAi.enabled` or the kind's switch was turned off before the job ran. */
  'disabled',
] as const;
export type InsightSkipReason = (typeof INSIGHT_SKIP_REASONS)[number];

export const INSIGHT_GENERATORS = ['model', 'rule'] as const;
export type InsightGenerator = (typeof INSIGHT_GENERATORS)[number];

export const INSIGHT_TEXT_SOURCES = ['generated', 'translated'] as const;
export type InsightTextSource = (typeof INSIGHT_TEXT_SOURCES)[number];

/** `pending`: the translation into the viewer's language is not ready yet. */
export const INSIGHT_TEXT_STATUSES = ['ready', 'pending', 'unavailable'] as const;
export type InsightTextStatus = (typeof INSIGHT_TEXT_STATUSES)[number];

export const ROOT_CAUSE_CATEGORIES = [
  'connectivity',
  'power_supply',
  'hardware',
  'firmware',
  'configuration',
  'token',
  'payment',
  'tariff',
  'vehicle',
  'backend',
  'unknown',
] as const;
export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

export const INSIGHT_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type InsightConfidence = (typeof INSIGHT_CONFIDENCES)[number];

/** Suggested operator actions of reservation insights (localize `aiInsights.fix.<code>`). */
export const RESERVATION_FIX_CODES = [
  'reservation_check_evse_status',
  'reservation_check_station_connectivity',
  'reservation_retry_cancel',
  'reservation_review_fee_payment',
  'reservation_review_holding_settings',
] as const;
export type ReservationFixCode = (typeof RESERVATION_FIX_CODES)[number];

/** Suggested operator actions. A model can only pick from this list. */
export const FIX_CODES = [
  'check_network_connection',
  'check_power_supply',
  'reboot_station',
  'inspect_connector',
  'update_firmware',
  'review_station_configuration',
  'contact_station_vendor',
  'review_token_status',
  'push_local_auth_list',
  'check_roaming_partner',
  'ask_driver_to_add_payment_method',
  'review_payment_settings',
  'review_fleet_credit_limit',
  'review_tariff_assignment',
  'ask_driver_to_retry',
  'check_vehicle_compatibility',
  'end_concurrent_session',
  'check_csms_status',
  'monitor',
  ...RESERVATION_FIX_CODES,
] as const;
export type FixCode = (typeof FIX_CODES)[number];

export const INSIGHT_SUMMARY_MAX_LENGTH = 600;
/**
 * Cap of a stored translation. A faithful translation of a summary at the
 * limit runs longer (German about a fifth), and a character limit in the
 * translation prompt made DeepSeek reason until its output budget ran out.
 */
export const INSIGHT_TRANSLATION_MAX_LENGTH = 2 * INSIGHT_SUMMARY_MAX_LENGTH;
export const INSIGHT_FIX_NOTE_MAX_LENGTH = 200;
export const INSIGHT_MAX_FIXES = 3;

export const insightFixSchema = z.object({
  code: z.enum(FIX_CODES),
  note: z.string().max(INSIGHT_FIX_NOTE_MAX_LENGTH).optional(),
});
export type InsightFix = z.infer<typeof insightFixSchema>;

/** The stored model answer, after `sanitizeInsightModelOutput`. */
export const insightModelOutputSchema = z.object({
  category: z.enum(ROOT_CAUSE_CATEGORIES),
  confidence: z.enum(INSIGHT_CONFIDENCES),
  summary: z.string().trim().min(1).max(INSIGHT_SUMMARY_MAX_LENGTH),
  fixes: z.array(insightFixSchema).max(INSIGHT_MAX_FIXES),
  evidenceRefs: z.array(z.string()),
});
export type InsightModelOutput = z.infer<typeof insightModelOutputSchema>;

/**
 * What a model may send: fix codes and evidence ids are free strings here, so
 * one unknown value is dropped instead of failing the whole answer.
 */
const insightModelAnswerSchema = z.object({
  category: z.enum(ROOT_CAUSE_CATEGORIES),
  confidence: z.enum(INSIGHT_CONFIDENCES),
  summary: z.string().trim().min(1).max(INSIGHT_SUMMARY_MAX_LENGTH),
  fixes: z.array(z.object({ code: z.string(), note: z.string().optional() })),
  evidenceRefs: z.array(z.string()),
});

function isFixCode(value: string): value is FixCode {
  return (FIX_CODES as readonly string[]).includes(value);
}

/**
 * Validates a model answer against the closed lists. Unknown fix codes and
 * evidence ids that are not in the evidence pack are dropped, notes are cut
 * to their limit and at most three fixes are kept. Returns null when the
 * answer does not have the required shape (the caller retries once, then
 * falls back to the rule insight). An `unknown` category gets `low` confidence.
 */
export function sanitizeInsightModelOutput(
  answer: unknown,
  evidenceIds: ReadonlySet<string>,
): InsightModelOutput | null {
  const parsed = insightModelAnswerSchema.safeParse(answer);
  if (!parsed.success) return null;
  const fixes: InsightFix[] = [];
  for (const fix of parsed.data.fixes) {
    if (!isFixCode(fix.code) || fixes.some((f) => f.code === fix.code)) continue;
    const note = fix.note?.trim().slice(0, INSIGHT_FIX_NOTE_MAX_LENGTH);
    fixes.push(note != null && note !== '' ? { code: fix.code, note } : { code: fix.code });
    if (fixes.length === INSIGHT_MAX_FIXES) break;
  }
  // An unknown root cause is never more than low confidence: the confidence
  // the list shows next to it is about the cause, not the summary.
  const { category } = parsed.data;
  return {
    category,
    confidence: category === 'unknown' ? 'low' : parsed.data.confidence,
    summary: parsed.data.summary,
    fixes,
    evidenceRefs: [...new Set(parsed.data.evidenceRefs)].filter((id) => evidenceIds.has(id)),
  };
}

function valueAt(answer: unknown, path: readonly (string | number)[]): unknown {
  let value = answer;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/**
 * Why an answer fails `sanitizeInsightModelOutput`, without any of its text:
 * the field, the issue and, for a text over its limit, its length and the
 * limit. Null when the answer passes. The worker logs it at debug level and
 * names it in the repair request.
 */
export function insightAnswerProblem(answer: unknown): string | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return 'the answer is not a JSON object';
  }
  const parsed = insightModelAnswerSchema.safeParse(answer);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'answer';
      const value = valueAt(answer, issue.path);
      if (issue.code === 'too_big' && issue.type === 'string' && typeof value === 'string') {
        return `${field} has ${String(value.trim().length)} characters, at most ${String(issue.maximum)} are allowed`;
      }
      return `${field}: ${issue.code}`;
    })
    .join('; ');
}

/** Counts computed in SQL, never by the model. Each kind fills the counts it has. */
export const insightScopeCountsSchema = z.object({
  stations: z.number().int().nonnegative().optional(),
  stationsOffline: z.number().int().nonnegative().optional(),
  stationsFaulted: z.number().int().nonnegative().optional(),
  sameErrorCode: z.number().int().nonnegative().optional(),
  sessionsInterrupted: z.number().int().nonnegative().optional(),
  sessionsFailedSameReason24h: z.number().int().nonnegative().optional(),
  tokenRefusals: z.number().int().nonnegative().optional(),
});
export type InsightScopeCounts = z.infer<typeof insightScopeCountsSchema>;

/** The counts of the subject's site (none for an unsited subject). */
export const insightScopeSchema = z.object({
  site: insightScopeCountsSchema.optional(),
});
export type InsightScope = z.infer<typeof insightScopeSchema>;

/** One insight as the API returns it. */
export const aiInsightDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(INSIGHT_KINDS),
  status: z.enum(INSIGHT_STATUSES),
  skipReason: z.enum(INSIGHT_SKIP_REASONS).nullable(),
  siteId: z.string().nullable(),
  stationId: z.string().nullable(),
  sessionId: z.string().nullable(),
  authorizeAttemptId: z.number().int().nullable(),
  reservationId: z.string().nullable(),
  parentInsightId: z.string().nullable(),
  category: z.enum(ROOT_CAUSE_CATEGORIES).nullable(),
  confidence: z.enum(INSIGHT_CONFIDENCES).nullable(),
  fixes: z.array(insightFixSchema),
  scope: insightScopeSchema,
  generatedBy: z.enum(INSIGHT_GENERATORS).nullable(),
  language: z.string(),
  summary: z.string().nullable(),
  textStatus: z.enum(INSIGHT_TEXT_STATUSES),
  stale: z.boolean(),
  basisAt: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  /** The action the insight carries (background worker suggestions), or null. */
  action: aiProposalDtoSchema.nullable(),
});
export type AiInsightDto = z.infer<typeof aiInsightDtoSchema>;

/**
 * Operator feedback on insights (v0.1.45): one vote per user and insight.
 * Votes and reasons never feed any prompt; the reason is untrusted text that
 * is stored only (never sent to a model, never in an API answer).
 */
export const INSIGHT_FEEDBACK_REASON_MAX_LENGTH = 500;
/** The window of the Settings quality summary (helpful rate by kind). */
export const INSIGHT_FEEDBACK_SUMMARY_DAYS = 30;
/** List filter: insights someone marked helpful or wrong. */
export const INSIGHT_FEEDBACK_FILTERS = ['helpful', 'wrong'] as const;
export type InsightFeedbackFilter = (typeof INSIGHT_FEEDBACK_FILTERS)[number];

export const insightFeedbackSummarySchema = z.object({
  helpfulCount: z.number().int(),
  wrongCount: z.number().int(),
  /** The viewer's own vote: true helpful, false wrong, null none. */
  mine: z.boolean().nullable(),
});
export type InsightFeedbackSummary = z.infer<typeof insightFeedbackSummarySchema>;

/** One row of the quality summary: votes on insights of a kind in the window. */
export interface InsightFeedbackRate {
  kind: InsightKind;
  helpful: number;
  wrong: number;
}

export interface RuleInsight {
  category: RootCauseCategory;
  fixes: readonly FixCode[];
}

/**
 * Known causes that get a rule insight (`generated_by='rule'`) without a
 * model call: session stop reasons, refused authorization outcomes, and
 * reservation audit rows keyed `<action>:<reason>` (`reservationRuleInsightFor`).
 * `station_rejected_other`, `station_no_response`, a cancel failure on an
 * online station, a fee provider error and `station_faulted` go to the model.
 * Every no-show (`expired:no_show`) is a rule insight (decision E17).
 */
export const RULE_INSIGHTS: Readonly<Record<string, RuleInsight>> = {
  AccountCreditLimit: { category: 'payment', fixes: ['review_fleet_credit_limit'] },
  EndRequestFailed: { category: 'connectivity', fixes: ['check_network_connection'] },
  EVConnectTimeout: { category: 'vehicle', fixes: ['ask_driver_to_retry'] },
  MissingPaymentMethod: { category: 'payment', fixes: ['ask_driver_to_add_payment_method'] },
  PaymentFailed: {
    category: 'payment',
    fixes: ['ask_driver_to_add_payment_method', 'review_payment_settings'],
  },
  PreAuthDeclined: { category: 'payment', fixes: ['ask_driver_to_add_payment_method'] },
  no_credit: { category: 'payment', fixes: ['review_fleet_credit_limit'] },
  expired: { category: 'token', fixes: ['review_token_status'] },
  blocked: { category: 'token', fixes: ['review_token_status', 'push_local_auth_list'] },
  concurrent_tx: { category: 'token', fixes: ['end_concurrent_session'] },
  'station_rejected:station_rejected_occupied': {
    category: 'configuration',
    fixes: ['reservation_check_evse_status'],
  },
  'station_rejected:evse_in_use_at_activation': {
    category: 'configuration',
    fixes: ['reservation_check_evse_status', 'reservation_review_holding_settings'],
  },
  'station_rejected:station_offline_at_activation': {
    category: 'connectivity',
    fixes: ['reservation_check_station_connectivity', 'check_network_connection'],
  },
  'station_rejected:station_faulted_at_activation': {
    category: 'hardware',
    fixes: ['reservation_check_evse_status', 'inspect_connector'],
  },
  'expired:no_show': { category: 'configuration', fixes: ['reservation_review_holding_settings'] },
  'station_cancel_failed:station_offline': {
    category: 'connectivity',
    fixes: ['reservation_check_station_connectivity', 'reservation_retry_cancel'],
  },
  'fee_failed:declined': {
    category: 'payment',
    fixes: ['ask_driver_to_add_payment_method', 'reservation_review_fee_payment'],
  },
  'fee_failed:no_payment_method': {
    category: 'payment',
    fixes: ['ask_driver_to_add_payment_method'],
  },
};

export function ruleInsightFor(reason: string | null | undefined): RuleInsight | undefined {
  return reason != null && Object.hasOwn(RULE_INSIGHTS, reason) ? RULE_INSIGHTS[reason] : undefined;
}

/**
 * The rule fallback of each kind (confidence low): stored when the model
 * answer is unusable or no model can run, and the no-show rule when its
 * audit row is gone.
 */
export const INSIGHT_KIND_FALLBACKS: Readonly<Record<InsightKind, RuleInsight>> = {
  station_offline: {
    category: 'connectivity',
    fixes: ['check_network_connection', 'check_power_supply'],
  },
  station_faulted: { category: 'hardware', fixes: ['inspect_connector', 'reboot_station'] },
  station_alert: { category: 'hardware', fixes: ['contact_station_vendor'] },
  session_failed: { category: 'unknown', fixes: ['monitor'] },
  authorization_refused: { category: 'token', fixes: ['review_token_status'] },
  site_incident: {
    category: 'connectivity',
    fixes: ['check_network_connection', 'check_power_supply'],
  },
  site_summary: { category: 'unknown', fixes: ['monitor'] },
  company_summary: { category: 'unknown', fixes: ['monitor'] },
  tariff_anomaly: { category: 'tariff', fixes: ['review_tariff_assignment'] },
  // The stop action the insight carries is its recommendation: a fix code
  // here would be a second one ("Keep monitoring" next to "Stop the session").
  stuck_session: { category: 'unknown', fixes: [] },
  station_long_faulted: { category: 'hardware', fixes: ['reboot_station', 'inspect_connector'] },
  reservation_rejected: {
    category: 'configuration',
    fixes: ['reservation_check_evse_status', 'reservation_check_station_connectivity'],
  },
  reservation_no_show: {
    category: 'configuration',
    fixes: ['reservation_review_holding_settings'],
  },
  reservation_cancel_failed: {
    category: 'connectivity',
    fixes: ['reservation_check_station_connectivity', 'reservation_retry_cancel'],
  },
  reservation_fee_failed: {
    category: 'payment',
    fixes: ['reservation_review_fee_payment', 'review_payment_settings'],
  },
  reservation_station_faulted: {
    category: 'hardware',
    fixes: ['reservation_check_evse_status', 'inspect_connector'],
  },
};

/** System-initiated AI runs (insights and background workers) use this surface. */
export const OPS_AI_SETTING_KEYS = {
  enabled: 'opsAi.enabled',
  provider: 'opsAi.provider',
  model: 'opsAi.model',
  effort: 'opsAi.effort',
  systemPrompt: 'opsAi.systemPrompt',
} as const;

export const AI_INSIGHT_SETTING_KEYS = {
  stationEnabled: 'aiInsights.station.enabled',
  sessionEnabled: 'aiInsights.session.enabled',
  authorizationEnabled: 'aiInsights.authorization.enabled',
  /** Reservation insights (default on, used only while `opsAi.enabled`). */
  reservationEnabled: 'aiInsights.reservation.enabled',
  debounceSeconds: 'aiInsights.debounceSeconds',
  cooldownMinutes: 'aiInsights.cooldownMinutes',
  siteIncidentThreshold: 'aiInsights.siteIncidentThreshold',
  maxPerSitePerDay: 'aiInsights.maxPerSitePerDay',
  primaryLanguage: 'aiInsights.primaryLanguage',
  retentionDays: 'aiInsights.retentionDays',
} as const;

/** Error codes of the insight and Explain routes, with their HTTP status. */
export const AI_INSIGHT_ERROR_CODES = {
  AI_INSIGHT_NOT_FOUND: 404,
  AI_INSIGHT_COOLDOWN: 429,
  AI_INSIGHTS_DISABLED: 400,
  AI_CONTEXT_NOT_FOUND: 404,
} as const;
export type AiInsightErrorCode = keyof typeof AI_INSIGHT_ERROR_CODES;

/**
 * Records an Explain conversation can be about (`ai_conversations.context_kind`).
 * The context id is the record's id: `charging_stations.id`,
 * `charging_sessions.id`, `authorize_attempts.id` as a decimal string,
 * `reservations.id`, or `ai_insights.id` (Explain and "Ask a follow-up" on an
 * insight).
 */
export const AI_CONTEXT_KINDS = [
  'station',
  'session',
  'authorization',
  'reservation',
  'insight',
] as const;
export type AiContextKind = (typeof AI_CONTEXT_KINDS)[number];
/** The context kinds of an operational record (every kind but an insight). */
export type AiRecordContextKind = Exclude<AiContextKind, 'insight'>;

// ---------------------------------------------------------------------------
// Reservation insights (v0.1.45): raised from `reservation_audit_log` by the
// insight scan. Subject type and Explain context kind `reservation`
// (`reservations.id`); the reason of a trigger row is `after.reason`.
// ---------------------------------------------------------------------------

/**
 * `reservation_audit_log.action` values that raise an insight, with the kind
 * they raise. The trigger key is the audit row id.
 */
export const RESERVATION_INSIGHT_TRIGGERS = {
  station_rejected: 'reservation_rejected',
  expired: 'reservation_no_show',
  station_cancel_failed: 'reservation_cancel_failed',
  fee_failed: 'reservation_fee_failed',
  station_faulted: 'reservation_station_faulted',
} as const satisfies Readonly<Record<string, ReservationInsightKind>>;
export type ReservationInsightTriggerAction = keyof typeof RESERVATION_INSIGHT_TRIGGERS;

/**
 * Reasons of a `station_rejected` audit row: the `reservation_cancel_reason`
 * of the rejected hold.
 */
export const RESERVATION_REJECT_REASONS = [
  'station_rejected_occupied',
  'station_rejected_other',
  'station_no_response',
  'evse_in_use_at_activation',
  'station_offline_at_activation',
  'station_faulted_at_activation',
] as const;
export type ReservationRejectReason = (typeof RESERVATION_REJECT_REASONS)[number];

/**
 * Reasons of an `expired` audit row (lane R1). Only `no_show` is a hold the
 * driver did not use: the station accepted it, it had a driver and no
 * session, and no other driver took it. `not_on_station` (scheduled, or never
 * accepted by the station), `waived` (another driver used the EVSE) and
 * `no_driver` (an operator hold) are not no-shows: the reservation insights
 * raise `reservation_no_show` only for `expired` rows with reason `no_show`.
 */
export const RESERVATION_EXPIRY_REASONS = [
  'no_show',
  'not_on_station',
  'waived',
  'no_driver',
] as const;
export type ReservationExpiryReason = (typeof RESERVATION_EXPIRY_REASONS)[number];

/** Reasons of a `station_cancel_failed` audit row. */
export const RESERVATION_CANCEL_FAILURE_REASONS = [
  'station_offline',
  'station_rejected',
  'station_no_response',
] as const;
export type ReservationCancelFailureReason = (typeof RESERVATION_CANCEL_FAILURE_REASONS)[number];

/**
 * Reasons of a `fee_failed` audit row: the provider declined the charge, the
 * driver has no payment method, or the provider failed on its side.
 */
export const RESERVATION_FEE_FAILURE_REASONS = [
  'declined',
  'no_payment_method',
  'provider_error',
] as const;
export type ReservationFeeFailureReason = (typeof RESERVATION_FEE_FAILURE_REASONS)[number];

/** The audit action that raises each reservation kind. */
export const RESERVATION_INSIGHT_ACTIONS: Readonly<
  Record<ReservationInsightKind, ReservationInsightTriggerAction>
> = {
  reservation_rejected: 'station_rejected',
  reservation_no_show: 'expired',
  reservation_cancel_failed: 'station_cancel_failed',
  reservation_fee_failed: 'fee_failed',
  reservation_station_faulted: 'station_faulted',
};

export function isReservationInsightKind(kind: string): kind is ReservationInsightKind {
  return (RESERVATION_INSIGHT_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a reservation audit row raises an insight: a trigger action, and
 * for `expired` only the reason `no_show` (an expiry that was never on the
 * station, waived or an operator hold is not a no-show).
 */
export function reservationAuditRaisesInsight(action: string, reason: string | null): boolean {
  if (!Object.hasOwn(RESERVATION_INSIGHT_TRIGGERS, action)) return false;
  return action !== 'expired' || reason === 'no_show';
}

/**
 * The reason of a reservation audit row. The writer (`writeReservationAudit`)
 * stores it as `after.reason` on every trigger action (`station_rejected`,
 * `station_cancel_failed`, `fee_failed`, `expired`, `station_faulted`); the
 * insight scan reads it here.
 */
export function reservationAuditReason(after: unknown): string | null {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return null;
  const reason = (after as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && reason !== '' ? reason : null;
}

/**
 * The rule insight of a reservation audit row, if its cause is known: the
 * `<action>:<reason>` entry of `RULE_INSIGHTS`.
 */
export function reservationRuleInsightFor(
  action: string,
  reason: string | null | undefined,
): RuleInsight | undefined {
  if (reason == null || !Object.hasOwn(RESERVATION_INSIGHT_TRIGGERS, action)) return undefined;
  const key = `${action}:${reason}`;
  return Object.hasOwn(RULE_INSIGHTS, key) ? RULE_INSIGHTS[key] : undefined;
}
