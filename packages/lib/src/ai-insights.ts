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
 */

import { z } from 'zod';

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
] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const INSIGHT_STATUSES = [
  'pending',
  'active',
  'resolved',
  'superseded',
  'skipped',
  'failed',
  'dismissed',
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

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
 * falls back to the rule insight).
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
  return {
    category: parsed.data.category,
    confidence: parsed.data.confidence,
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

/** `network` is returned only to users with access to every site. */
export const insightScopeSchema = z.object({
  site: insightScopeCountsSchema.optional(),
  network: insightScopeCountsSchema.optional(),
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
});
export type AiInsightDto = z.infer<typeof aiInsightDtoSchema>;

export interface RuleInsight {
  category: RootCauseCategory;
  fixes: readonly FixCode[];
}

/**
 * Known causes that get a rule insight (`generated_by='rule'`) without a
 * model call: session stop reasons and refused authorization outcomes.
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
};

export function ruleInsightFor(reason: string | null | undefined): RuleInsight | undefined {
  return reason != null && Object.hasOwn(RULE_INSIGHTS, reason) ? RULE_INSIGHTS[reason] : undefined;
}

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
 * `charging_sessions.id`, or `authorize_attempts.id` as a decimal string.
 */
export const AI_CONTEXT_KINDS = ['station', 'session', 'authorization'] as const;
export type AiContextKind = (typeof AI_CONTEXT_KINDS)[number];
