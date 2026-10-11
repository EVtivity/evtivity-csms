// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Driver AI support: the shared contract between the portal and mobile app
 * (consent and answer UI), the API (case create, feedback, features), the
 * worker (analysis, sweeper) and the CSMS (operator view, settings).
 * Browser-safe (`@evtivity/lib/driver-ai`).
 *
 * A driver who opens a support case chooses, per request and with nothing
 * preselected, whether an AI may analyze the issue first. The model answers
 * in `DriverAiAnswer`: plain text, a support case category, action codes from
 * a closed list, and whether a person is needed. The driver then answers one
 * question: did this solve the issue.
 *
 * Setting defaults live with the other AI defaults (`ai-config.ts`), not here.
 */

import { z } from 'zod';
import { UI_LANGUAGES } from './languages.js';

/**
 * Version of the consent notice text. Bump it whenever the English notice
 * changes. The locale keys carry the version in their name
 * (`supportCases.ai.notice.v<N>.*`), so the text a version names never
 * changes after release.
 */
export const DRIVER_AI_NOTICE_VERSION = 1;

/**
 * Every notice version ever released. The worker accepts a stored consent
 * under any of them; a new consent must name the current one.
 */
export const DRIVER_AI_NOTICE_VERSIONS: readonly number[] = [1];

/** A consent sent with a new case must name the current notice. */
export function isCurrentDriverAiNoticeVersion(version: unknown): boolean {
  return version === DRIVER_AI_NOTICE_VERSION;
}

/** A stored consent must name a released notice. */
export function isKnownDriverAiNoticeVersion(version: unknown): boolean {
  return typeof version === 'number' && DRIVER_AI_NOTICE_VERSIONS.includes(version);
}

/** `support_cases.ai_consent`. Null: the driver was not asked. */
export const DRIVER_AI_CONSENT_DECISIONS = ['granted', 'declined'] as const;
export type DriverAiConsentDecision = (typeof DRIVER_AI_CONSENT_DECISIONS)[number];

/** `support_cases.ai_state`. Null: no AI step on the case. */
export const DRIVER_AI_STATES = [
  'queued',
  'analyzing',
  'awaiting_feedback',
  'resolved_by_ai',
  'escalated',
  'failed',
  'skipped',
] as const;
export type DriverAiState = (typeof DRIVER_AI_STATES)[number];

/** States the sweeper watches. Every other state is terminal (written by compare-and-set). */
export const DRIVER_AI_OPEN_STATES = ['queued', 'analyzing', 'awaiting_feedback'] as const;
export type DriverAiOpenState = (typeof DRIVER_AI_OPEN_STATES)[number];

export const DRIVER_AI_TERMINAL_STATES = [
  'resolved_by_ai',
  'escalated',
  'failed',
  'skipped',
] as const;
export type DriverAiTerminalState = (typeof DRIVER_AI_TERMINAL_STATES)[number];

export function isDriverAiTerminalState(state: unknown): state is DriverAiTerminalState {
  return (
    typeof state === 'string' && (DRIVER_AI_TERMINAL_STATES as readonly string[]).includes(state)
  );
}

/** `support_cases.ai_state_reason`: why the AI step ended without an answer, or how it was escalated. */
export const DRIVER_AI_STATE_REASONS = [
  'disabled',
  'driver_limit',
  'rate_limited',
  'budget_exceeded',
  'no_evidence',
  'provider_error',
  'invalid_output',
  'no_feedback',
  'driver_replied',
  'driver_declined_answer',
  // The driver was deactivated between consent and analysis (threat T8).
  'driver_inactive',
] as const;
export type DriverAiStateReason = (typeof DRIVER_AI_STATE_REASONS)[number];

/** `support_cases.resolution_source`. */
export const SUPPORT_CASE_RESOLUTION_SOURCES = ['operator', 'ai'] as const;
export type SupportCaseResolutionSource = (typeof SUPPORT_CASE_RESOLUTION_SOURCES)[number];

/** `support_case_status` value of a case the AI handles before operators see it. */
export const SUPPORT_CASE_AI_ASSIST_STATUS = 'ai_assist';

/** `support_case_sender` value of the stored AI answer. */
export const SUPPORT_CASE_ASSISTANT_SENDER = 'assistant';

/** `support_case_audit_action` values of the driver AI flow. */
export const DRIVER_AI_AUDIT_ACTIONS = [
  'ai_consent_granted',
  'ai_consent_declined',
  'ai_answered',
  'resolved_by_ai',
  'escalated_from_ai',
  'ai_failed',
] as const;
export type DriverAiAuditAction = (typeof DRIVER_AI_AUDIT_ACTIONS)[number];

/**
 * `support_case_category`, mirrored from the database enum so browser code and
 * the answer schema can use it. A database test keeps the two equal.
 */
export const SUPPORT_CASE_CATEGORIES = [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
] as const;
export type SupportCaseCategory = (typeof SUPPORT_CASE_CATEGORIES)[number];

/** What the answer may suggest the driver do. A model can only pick from this list. */
export const DRIVER_ACTION_CODES = [
  'try_other_connector',
  'check_payment_method',
  'retry_start',
  'check_vehicle_settings',
  'contact_operator',
  'wait_and_retry',
  'check_token_active',
] as const;
export type DriverActionCode = (typeof DRIVER_ACTION_CODES)[number];

export const DRIVER_AI_ANSWER_MAX_LENGTH = 1200;

// Output checks. The answer is shown as plain text to a driver, so links,
// markup, card numbers and secret words are refused (threats T2 and T4 of the
// plan). A refused answer gets one repair retry, then the case goes to
// operators. The checks run on the NFKC form, so full-width and decomposed
// characters cannot slip past them.

const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // any scheme with //
  /\b(?:mailto|tel|sms|callto):/i,
  /\bwww\./i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4 address
  // A host name: labels and a top-level domain of 2 to 24 letters, followed by
  // a path, space, punctuation or the end. Keeps "e.g." and "21.4 kWh".
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?=[/\s.,;:!?)\]'"]|$)/i,
];

/** Dots a host name can be written with besides `.` (ideographic and full-width). */
const DOT_VARIANTS = /[。．｡]/g;

const MARKDOWN_PATTERNS: readonly RegExp[] = [
  /^\s{0,3}#{1,6}\s/m, // heading
  /\*\*|__/, // bold
  /`/, // code
  /!?\[[^\]\n]*\]\([^)\n]*\)/, // link or image
  /^\s{0,3}>\s/m, // block quote
  /^\s*\*\s/m, // asterisk bullet
  /^\s*\|.*\|\s*$/m, // table row
  /<\/?[a-z][^>\n]*>/i, // HTML tag
];

/** 13 to 19 digits, optionally grouped, starting like a card network (2 to 6). */
const CARD_CANDIDATE = /(?<!\d)[2-6](?:[ -]?\d){12,18}(?!\d)/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    if (luhnValid(match[0].replace(/[ -]/g, ''))) return true;
  }
  return false;
}

/**
 * Words for secrets (passwords, PINs, card numbers, security and one-time
 * codes) in the six UI languages. Any mention is refused, not only a request:
 * telling a request from advice is not reliable across six languages, and a
 * refused answer still reaches a person (plan 2.6). German alternatives have no
 * leading word boundary, so compounds (`Kreditkartennummer`) match.
 */
const SECRET_WORD_PATTERN = new RegExp(
  [
    String.raw`\bpass(?:word|code|phrase)s?\b`,
    String.raw`\bcard\s+numbers?\b`,
    String.raw`\b(?:security|verification|one[- ]time|confirmation|login)\s+codes?\b`,
    String.raw`(?:passw(?:o|ö)rt|kennwort|kartennummer|sicherheitscode|best(?:ä|ae)tigungscode|einmalcode|prüfnummer)`,
    String.raw`\bcontraseñas?\b`,
    String.raw`\b(?:tu|su)\s+clave\b|\bclave\s+(?:de\s+acceso|secreta)\b`,
    String.raw`\bnúmero\s+de\s+(?:la\s+)?tarjeta\b`,
    String.raw`\bcódigo\s+de\s+(?:seguridad|verificación|confirmación)\b`,
    '비밀번호',
    '암호',
    '카드\\s*번호',
    '인증\\s*(?:코드|번호)',
    '보안\\s*코드',
    '密码',
    '密碼',
    '卡号',
    '卡號',
    '验证码',
    '驗證碼',
    '安全码',
    '安全碼',
  ].join('|'),
  'iu',
);

/** Acronyms that are ordinary words in lowercase (`pin`), so matched in capitals only. */
const SECRET_ACRONYM_PATTERN = /\b(?:PINs?|CV[CV]2?|OTPs?)\b/u;

/**
 * Why an answer text is not allowed, as a short reason the repair request can
 * name (never the text itself). Null when it passes.
 */
export function driverAiAnswerTextProblem(input: string): string | null {
  const text = input.normalize('NFKC');
  const dotted = text.replace(DOT_VARIANTS, '.');
  if (URL_PATTERNS.some((p) => p.test(dotted))) return 'the answer contains a link or web address';
  if (MARKDOWN_PATTERNS.some((p) => p.test(text))) return 'the answer contains markdown or HTML';
  if (hasCardNumber(text)) return 'the answer contains a card number';
  if (SECRET_WORD_PATTERN.test(text) || SECRET_ACRONYM_PATTERN.test(text)) {
    return 'the answer mentions a password, PIN, card number or code';
  }
  return null;
}

/** The model answer, validated before it is stored as an `assistant` case message. */
export const driverAiAnswerSchema = z.object({
  answer: z
    .string()
    .trim()
    .min(1)
    .max(DRIVER_AI_ANSWER_MAX_LENGTH)
    .superRefine((text, ctx) => {
      const problem = driverAiAnswerTextProblem(text);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
    })
    .describe('Plain-text answer to the driver'),
  category: z.enum(SUPPORT_CASE_CATEGORIES).describe('Support case category'),
  driverActions: z
    .array(z.enum(DRIVER_ACTION_CODES))
    .max(DRIVER_ACTION_CODES.length)
    .refine((codes) => new Set(codes).size === codes.length, 'duplicate action codes')
    .describe('Suggested driver actions (localize supportCases.ai.driverAction.<code>)'),
  needsOperator: z.boolean().describe('Whether a person from the support team is needed'),
});
export type DriverAiAnswer = z.infer<typeof driverAiAnswerSchema>;

/**
 * Why a model answer fails `driverAiAnswerSchema`, without any of its text.
 * Null when it passes. The worker names it in the one repair request.
 */
export function driverAiAnswerProblem(answer: unknown): string | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return 'the answer is not a JSON object';
  }
  const parsed = driverAiAnswerSchema.safeParse(answer);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'answer';
      return issue.code === 'custom' ? `${field}: ${issue.message}` : `${field}: ${issue.code}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// Route DTOs
// ---------------------------------------------------------------------------

/** `POST /v1/portal/support-cases` body field `aiConsent`. Sent only after the driver pressed a choice. */
export const driverAiConsentInputSchema = z
  .object({
    decision: z.enum(DRIVER_AI_CONSENT_DECISIONS).describe('The choice the driver pressed'),
    noticeVersion: z
      .number()
      .int()
      .min(1)
      .describe('Version of the notice the driver saw (DRIVER_AI_NOTICE_VERSION)'),
    language: z.enum(UI_LANGUAGES).describe('UI language the notice was shown in'),
  })
  .describe('The driver AI consent choice of this request');
export type DriverAiConsentInput = z.infer<typeof driverAiConsentInputSchema>;

/** `POST /v1/portal/support-cases/:id/ai-feedback` body. */
export const driverAiFeedbackInputSchema = z
  .object({ satisfied: z.boolean().describe('Whether the automatic answer solved the issue') })
  .describe('The driver answer to "Did this solve your issue?"');
export type DriverAiFeedbackInput = z.infer<typeof driverAiFeedbackInputSchema>;

/** `ai` of the create response. */
export const driverAiCreateStatusSchema = z
  .object({
    state: z.enum(DRIVER_AI_STATES).nullable().describe('AI step state; null without an AI step'),
    reason: z.enum(DRIVER_AI_STATE_REASONS).nullable().describe('Why the AI step was skipped'),
  })
  .describe('AI step of the new case');
export type DriverAiCreateStatus = z.infer<typeof driverAiCreateStatusSchema>;

/** `ai` of `GET /v1/portal/support-cases/:id`. */
export const driverAiCaseDetailSchema = z
  .object({
    consent: z
      .enum(DRIVER_AI_CONSENT_DECISIONS)
      .nullable()
      .describe('The consent choice; null when the driver was not asked'),
    state: z.enum(DRIVER_AI_STATES).nullable().describe('AI step state; null without an AI step'),
    reason: z.enum(DRIVER_AI_STATE_REASONS).nullable().describe('Reason of the state, when any'),
    answeredAt: z.string().nullable().describe('When the automatic answer was stored (ISO 8601)'),
    feedbackAt: z.string().nullable().describe('When the driver answered the feedback question'),
    resolutionSource: z
      .enum(SUPPORT_CASE_RESOLUTION_SOURCES)
      .nullable()
      .describe('Who resolved the case; null while it is not resolved'),
    driverActions: z
      .array(z.enum(DRIVER_ACTION_CODES))
      .describe('Driver actions of the automatic answer'),
    needsOperator: z
      .boolean()
      .nullable()
      .describe(
        'Whether the automatic answer says the support team is needed; null before an answer',
      ),
  })
  .describe('AI step of the case, as the driver sees it');
export type DriverAiCaseDetail = z.infer<typeof driverAiCaseDetailSchema>;

/** Consent block of the operator case detail. */
export const driverAiConsentRecordSchema = z
  .object({
    decision: z.enum(DRIVER_AI_CONSENT_DECISIONS).describe('The consent choice'),
    at: z.string().describe('Server time of the choice (ISO 8601)'),
    language: z.string().describe('UI language the notice was shown in'),
    noticeVersion: z.number().int().describe('Version of the notice the driver saw'),
  })
  .describe('The driver consent to the AI analysis');
export type DriverAiConsentRecord = z.infer<typeof driverAiConsentRecordSchema>;

/** Fields `GET /v1/portal/features` adds. */
export const driverAiFeaturesSchema = z.object({
  driverAiSupport: z
    .boolean()
    .describe('Whether new cases offer the AI analysis (driverAi.enabled and a provider)'),
  driverAiNoticeVersion: z.number().int().describe('Current consent notice version'),
});
export type DriverAiFeatures = z.infer<typeof driverAiFeaturesSchema>;

// ---------------------------------------------------------------------------
// Settings, transport, notifications and error codes
// ---------------------------------------------------------------------------

/**
 * Setting keys of the driver support surface. They join the AI setting
 * contract test (`ai-config.test.ts`) when their defaults land (lane K1).
 */
export const DRIVER_AI_SETTING_KEYS = {
  enabled: 'driverAi.enabled',
  provider: 'driverAi.provider',
  model: 'driverAi.model',
  effort: 'driverAi.effort',
  systemPrompt: 'driverAi.systemPrompt',
  maxCasesPerDriverPerDay: 'driverAi.maxCasesPerDriverPerDay',
  feedbackTimeoutHours: 'driverAi.feedbackTimeoutHours',
  driverDailyTokens: 'ai.budget.driverDailyTokens',
  driverPerMinute: 'ai.rateLimit.driverPerMinute',
} as const;

/** BullMQ queue of the analysis jobs. */
export const DRIVER_AI_QUEUE = 'driver-ai';

/** Job name of one case analysis. */
export const DRIVER_AI_ANALYZE_JOB = 'analyze';

/** Job id of a case analysis: one job per case, so a duplicate request is a no-op. */
export function driverAiJobId(caseId: string): string {
  return `dai.${caseId}`;
}

/**
 * Pub/sub channel of analysis requests: the API publishes, the worker bridges
 * each request to the `driver-ai` queue (the API Redis user cannot add BullMQ
 * jobs). Granted to the api, ocpp and worker users in
 * `docker/redis/acl-rules.conf`.
 */
export const DRIVER_AI_REQUESTS_CHANNEL = 'driver_ai_requests';

/** Payload the API publishes on `DRIVER_AI_REQUESTS_CHANNEL`. */
export const driverAiRequestSchema = z.object({ caseId: z.string().min(1) });
export type DriverAiRequest = z.infer<typeof driverAiRequestSchema>;

/** Notification event of a stored answer (push and email to the driver). */
export const DRIVER_AI_ANSWERED_EVENT = 'supportCase.AiAnswered';

/** Error codes of the driver AI routes, with their HTTP status. */
export const DRIVER_AI_ERROR_CODES = {
  DRIVER_AI_NOTICE_OUTDATED: 409,
  SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK: 409,
} as const;
export type DriverAiErrorCode = keyof typeof DRIVER_AI_ERROR_CODES;
