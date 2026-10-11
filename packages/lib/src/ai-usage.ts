// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI usage and budgets: the shared contract of the usage ledger (one row per
 * model call), the budget check every model call runs first, and the usage
 * routes the CSMS shows. Budgets are in tokens. Browser-safe
 * (`@evtivity/lib/ai-usage`).
 */

import { z } from 'zod';

/** The surface a ledger row is charged to. */
export const AI_USAGE_SURFACES = [
  'chatbot',
  'support',
  'insight',
  'insight_translation',
  'worker',
  'driver_support',
] as const;
export type AiUsageSurface = (typeof AI_USAGE_SURFACES)[number];

/**
 * Surfaces a person starts (an operator, or a driver for `driver_support`).
 * The others run without a person and count against site daily budgets.
 */
export const AI_INTERACTIVE_USAGE_SURFACES: readonly AiUsageSurface[] = [
  'chatbot',
  'support',
  'driver_support',
];

/** `driver`: the driver daily budget of `driver_support` (`ai.budget.driverDailyTokens`). */
export const AI_BUDGET_SCOPES = ['company', 'site', 'user', 'driver'] as const;
export type AiBudgetScope = (typeof AI_BUDGET_SCOPES)[number];

export const AI_BUDGET_PERIODS = ['day', 'month'] as const;
export type AiBudgetPeriod = (typeof AI_BUDGET_PERIODS)[number];

export interface AiBudgetCheckInput {
  surface: AiUsageSurface;
  userId?: string;
  /** The driver a `driver_support` call runs for: checked against the driver daily budget. */
  driverId?: string;
  siteId?: string | null;
  now?: Date;
}

/** Error code of a refusal: monthly (company or site), site daily, or user or driver daily. */
export type AiBudgetRefusalCode =
  | 'AI_MONTHLY_BUDGET_EXCEEDED'
  | 'AI_SITE_BUDGET_EXCEEDED'
  | 'AI_BUDGET_EXCEEDED';

export type AiBudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: AiBudgetRefusalCode;
      scope: AiBudgetScope;
      period: AiBudgetPeriod;
      retryAfterSeconds: number;
    };

/**
 * Runs before every model call. Checks, in order, the company monthly, site
 * monthly, site daily (system-initiated surfaces only), user daily
 * (interactive surfaces with a user) and driver daily (`driver_support` with a
 * driver) budgets; the first refusal wins.
 */
export type CheckAiBudgets = (input: AiBudgetCheckInput) => Promise<AiBudgetDecision>;

export const aiUsageTokensSchema = z
  .object({
    input: z.number().int().nonnegative().describe('Input tokens, cached reads included'),
    cachedRead: z.number().int().nonnegative().describe('Input tokens read from the prompt cache'),
    cacheWrite: z.number().int().nonnegative().describe('Input tokens written to the prompt cache'),
    output: z.number().int().nonnegative().describe('Output tokens, reasoning included'),
    reasoning: z.number().int().nonnegative().describe('Reasoning tokens of the output'),
  })
  .describe('Token counts by kind');
export type AiUsageTokens = z.infer<typeof aiUsageTokensSchema>;

export const aiUsageTotalsSchema = z
  .object({
    tokens: aiUsageTokensSchema,
    totalTokens: z
      .number()
      .int()
      .nonnegative()
      .describe('Input plus output tokens: the unit budgets count'),
    /** Micro-USD from the model registry prices. Shown only when the company currency is USD. */
    costMicros: z
      .number()
      .int()
      .nonnegative()
      .describe('Provider cost in micro-USD. Shown only when the company currency is USD'),
  })
  .describe('Usage totals');
export type AiUsageTotals = z.infer<typeof aiUsageTotalsSchema>;

export const aiUsageBudgetSchema = z
  .object({
    /** Null: no limit. */
    // min(1), not positive(): the OpenAPI conversion turns positive() into a boolean exclusiveMinimum.
    limitTokens: z.number().int().min(1).nullable().describe('Token budget; null: no limit'),
    usedTokens: z.number().int().nonnegative().describe('Budget tokens used in the period'),
    /** Null when there is no limit. */
    percent: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Share of the budget used, in percent; null without a limit'),
  })
  .describe('A token budget and its use');
export type AiUsageBudget = z.infer<typeof aiUsageBudgetSchema>;

export const aiUsageSiteRowSchema = z
  .object({
    siteId: z.string().describe('Site identifier'),
    siteName: z.string().describe('Site name'),
    totals: aiUsageTotalsSchema,
    budget: aiUsageBudgetSchema,
  })
  .describe("A site's usage and monthly budget");
export type AiUsageSiteRow = z.infer<typeof aiUsageSiteRowSchema>;

export const aiUsageSurfaceRowSchema = z
  .object({
    surface: z.enum(AI_USAGE_SURFACES).describe('The AI surface the usage is charged to'),
    totals: aiUsageTotalsSchema,
  })
  .describe("A surface's usage");

export const aiUsageUserRowSchema = z
  .object({
    userId: z.string().describe('User identifier'),
    totals: aiUsageTotalsSchema,
  })
  .describe("A user's usage");

const aiUsagePeriodSchema = z
  .object({
    start: z.string().describe('Start of the period (ISO 8601, inclusive)'),
    end: z.string().describe('End of the period (ISO 8601, exclusive)'),
  })
  .describe('The calendar month in the system timezone');

const aiUsageMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe('The month, YYYY-MM');

/**
 * `GET /v1/ai/usage?month=YYYY-MM`. Company totals, the usage that belongs to
 * no site and the per-user rows are null for a user restricted to some sites.
 */
export const aiUsageDtoSchema = z.object({
  month: aiUsageMonthSchema,
  period: aiUsagePeriodSchema,
  company: z
    .object({ totals: aiUsageTotalsSchema, budget: aiUsageBudgetSchema })
    .nullable()
    .describe('Company totals and monthly budget; null for a user restricted to some sites'),
  unattributed: aiUsageTotalsSchema
    .nullable()
    .describe(
      'Usage charged to no site: the assistant, and usage of sites deleted since. Null for a restricted user',
    ),
  sites: z.array(aiUsageSiteRowSchema).describe("The usage of every site in the user's scope"),
  surfaces: z.array(aiUsageSurfaceRowSchema).describe("Usage per surface, within the user's scope"),
  topUsers: z
    .array(aiUsageUserRowSchema)
    .nullable()
    .describe('The users with the most usage; null for a restricted user'),
});
export type AiUsageDto = z.infer<typeof aiUsageDtoSchema>;

/** `GET /v1/ai/usage/sites/:siteId?month=YYYY-MM`: one site in the user's scope. */
export const aiSiteUsageDtoSchema = z.object({
  month: aiUsageMonthSchema,
  period: aiUsagePeriodSchema,
  site: aiUsageSiteRowSchema,
  surfaces: z.array(aiUsageSurfaceRowSchema).describe('Usage per surface at the site'),
});
export type AiSiteUsageDto = z.infer<typeof aiSiteUsageDtoSchema>;

/** `GET /v1/users/me/ai-usage`: today against the daily budget, and this month. */
export const aiMyUsageDtoSchema = z.object({
  today: aiUsageBudgetSchema.describe('Today (UTC) against the daily budget'),
  month: aiUsageTotalsSchema.describe('This calendar month in the system timezone'),
});
export type AiMyUsageDto = z.infer<typeof aiMyUsageDtoSchema>;

/** Budget keys added next to the existing `ai.budget.userDailyTokens`. 0 means no limit. */
export const AI_BUDGET_SETTING_KEYS = {
  companyMonthlyTokens: 'ai.budget.companyMonthlyTokens',
  siteMonthlyTokens: 'ai.budget.siteMonthlyTokens',
  siteDailyTokens: 'ai.budget.siteDailyTokens',
  warnPercent: 'ai.budget.warnPercent',
} as const;

/** Error codes of the budget checks, with their HTTP status. */
export const AI_USAGE_ERROR_CODES = {
  AI_SITE_BUDGET_EXCEEDED: 429,
  AI_MONTHLY_BUDGET_EXCEEDED: 429,
} as const;
export type AiUsageErrorCode = keyof typeof AI_USAGE_ERROR_CODES;
