// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI usage ledger and budgets (plan v0.1.44, 2.3 and 7). `recordAiUsage()` is
 * the only writer of `ai_usage_ledger` and `ai_budget_notices`; the API and
 * the worker call it after every model call. `checkAiBudgets()` runs before
 * every model call and reads only the ledger.
 *
 * Budget tokens are input plus output tokens, as the v0.1.43 daily budget
 * counted them. Monthly periods are calendar months in the system timezone;
 * daily periods are UTC days (the v0.1.43 daily budget's convention).
 *
 * Sums are cached 60 seconds per scope and period (P6). A ledger write adds
 * its tokens to this process's cached sums; other processes see it within 60
 * seconds. Budgets are checked before every model call, so the overshoot past
 * a budget is bounded by the calls that pass the check before their own usage
 * lands: one call per request in flight, plus up to 60 seconds of calls on
 * other processes. The site daily budget counts the system-initiated surfaces
 * only (insights, translations, workers), the surfaces it applies to.
 */

import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { createLogger, isValidTimezone, zonedMidnight } from '@evtivity/lib';
import type { AiLimits } from '@evtivity/lib';

/** The budget settings a check reads (`ai.budget.*`, in `AiLimits`). 0 means no limit. */
export type AiBudgetLimits = Pick<
  AiLimits,
  | 'companyMonthlyTokens'
  | 'siteMonthlyTokens'
  | 'siteDailyTokens'
  | 'budgetWarnPercent'
  | 'userDailyTokens'
  | 'driverDailyTokens'
>;
import { AI_INTERACTIVE_USAGE_SURFACES, AI_USAGE_SURFACES } from '@evtivity/lib/ai-usage';
import type {
  AiBudgetCheckInput,
  AiBudgetDecision,
  AiBudgetRefusalCode,
  AiBudgetScope,
  AiUsageSurface,
} from '@evtivity/lib/ai-usage';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { db } from '../config.js';
import { aiBudgetNotices, aiUsageLedger } from '../schema/ai-usage.js';
import { sites } from '../schema/assets.js';
import { getAiSettings } from './ai-settings.js';
import { getSystemTimezone } from './system-settings.js';

const logger = createLogger('ai-usage');

const TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The SSE event type of a budget threshold notice on `csms_events`. */
export const AI_USAGE_THRESHOLD_EVENT = 'ai.usage.threshold';

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** A usage period: [start, end). */
export interface AiUsagePeriod {
  start: Date;
  end: Date;
}

/** A calendar month in the system timezone. */
export interface AiUsageMonth extends AiUsagePeriod {
  /** YYYY-MM. */
  month: string;
}

function zoneOrUtc(timeZone: string): string {
  return isValidTimezone(timeZone) ? timeZone : 'UTC';
}

/** True for a `YYYY-MM` month. */
export function isAiUsageMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** The calendar month (`YYYY-MM`) of an instant in a timezone (UTC when the zone is invalid). */
export function aiUsageMonthOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOrUtc(timeZone),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? String(at.getUTCFullYear());
  const month =
    parts.find((p) => p.type === 'month')?.value ?? String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * The bounds of a `YYYY-MM` month in a timezone: midnight of the first day to
 * midnight of the first day of the next month, DST included. Throws on a
 * malformed month (callers validate input first).
 */
export function aiUsageMonth(month: string, timeZone: string): AiUsageMonth {
  if (!isAiUsageMonth(month)) throw new Error(`Invalid month ${month}`);
  const zone = zoneOrUtc(timeZone);
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  return {
    month,
    start: zonedMidnight(year, m, 1, zone),
    end: zonedMidnight(nextYear, nextMonth, 1, zone),
  };
}

/** The UTC day of an instant. */
export function aiUsageUtcDay(at: Date): AiUsagePeriod {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function secondsUntil(end: Date, now: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------------
// Cached sums
// ---------------------------------------------------------------------------

/**
 * A budget scope: the company, a site (every surface), a site's
 * system-initiated surfaces only (the site daily budget), or a user.
 */
type SumKey =
  | { kind: 'company' }
  | { kind: 'site'; siteId: string }
  | { kind: 'siteSystem'; siteId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'driver'; driverId: string };

interface CachedSum {
  key: SumKey;
  period: AiUsagePeriod;
  value: number;
  at: number;
}

const sumCache = new Map<string, CachedSum>();
const siteBudgetCache = new Map<string, { value: number | null; at: number }>();

/** Clears the cached sums and site budgets of this process (tests, a site budget change). */
export function clearAiUsageCache(): void {
  sumCache.clear();
  siteBudgetCache.clear();
}

const SYSTEM_SURFACES = AI_USAGE_SURFACES.filter((s) => !AI_INTERACTIVE_USAGE_SURFACES.includes(s));

function scopeCondition(key: SumKey): SQL | undefined {
  if (key.kind === 'site') return eq(aiUsageLedger.siteId, key.siteId);
  if (key.kind === 'siteSystem') {
    return and(
      eq(aiUsageLedger.siteId, key.siteId),
      inArray(aiUsageLedger.surface, SYSTEM_SURFACES),
    );
  }
  if (key.kind === 'user') return eq(aiUsageLedger.userId, key.userId);
  if (key.kind === 'driver') return eq(aiUsageLedger.driverId, key.driverId);
  return undefined;
}

function scopeId(key: SumKey): string {
  switch (key.kind) {
    case 'company':
      return '';
    case 'user':
      return key.userId;
    case 'driver':
      return key.driverId;
    default:
      return key.siteId;
  }
}

function cacheKey(key: SumKey, period: AiUsagePeriod): string {
  return `${key.kind}:${scopeId(key)}:${String(period.start.getTime())}:${String(period.end.getTime())}`;
}

/** The ledger fields that decide which scopes a row counts in. */
interface AiUsageRowScope {
  surface: AiUsageSurface;
  userId: string | null;
  siteId: string | null;
  driverId: string | null;
}

/** Whether a ledger row counts in a scope. */
function rowInScope(key: SumKey, row: AiUsageRowScope): boolean {
  switch (key.kind) {
    case 'company':
      return true;
    case 'site':
      return row.siteId === key.siteId;
    case 'siteSystem':
      return row.siteId === key.siteId && SYSTEM_SURFACES.includes(row.surface);
    case 'user':
      return row.userId === key.userId;
    case 'driver':
      return row.driverId === key.driverId;
  }
}

/**
 * Adds a row this process just wrote to every cached sum it counts in, so the
 * next check and the threshold notice read the cache instead of the database.
 */
function addToCachedSums(row: AiUsageRowScope, occurredAt: Date, tokens: number): void {
  const t = occurredAt.getTime();
  for (const entry of sumCache.values()) {
    if (t < entry.period.start.getTime() || t >= entry.period.end.getTime()) continue;
    if (rowInScope(entry.key, row)) entry.value += tokens;
  }
}

/** Budget tokens (input plus output) of a scope in a period, from the ledger. */
async function queryTokens(key: SumKey, period: AiUsagePeriod): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${aiUsageLedger.inputTokens}::bigint + ${aiUsageLedger.outputTokens}::bigint), 0)`,
    })
    .from(aiUsageLedger)
    .where(
      and(
        scopeCondition(key),
        gte(aiUsageLedger.occurredAt, period.start),
        lt(aiUsageLedger.occurredAt, period.end),
      ),
    );
  return Number(row?.total ?? 0);
}

async function cachedTokens(key: SumKey, period: AiUsagePeriod): Promise<number> {
  const k = cacheKey(key, period);
  const hit = sumCache.get(k);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.value;
  const value = await queryTokens(key, period);
  sumCache.set(k, { key, period, value, at: now });
  return value;
}

/**
 * The monthly token budget of a site: its own `ai_monthly_token_budget`, else
 * `ai.budget.siteMonthlyTokens`. 0 means no limit. Cached 60 seconds.
 */
export async function getSiteMonthlyTokenBudget(
  siteId: string,
  limits: Pick<AiLimits, 'siteMonthlyTokens'>,
): Promise<number> {
  const now = Date.now();
  const hit = siteBudgetCache.get(siteId);
  let own: number | null;
  if (hit !== undefined && now - hit.at < TTL_MS) {
    own = hit.value;
  } else {
    const [row] = await db
      .select({ budget: sites.aiMonthlyTokenBudget })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    own = row?.budget ?? null;
    siteBudgetCache.set(siteId, { value: own, at: now });
  }
  return own ?? limits.siteMonthlyTokens;
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/** What a budget decision needs, injected so the order of checks is testable without a database. */
export interface AiBudgetContext {
  limits: AiBudgetLimits;
  timeZone: string;
  siteMonthlyBudget: (siteId: string) => Promise<number>;
  tokens: (key: SumKey, period: AiUsagePeriod) => Promise<number>;
}

export type AiBudgetSumKey = SumKey;

function refuse(
  code: AiBudgetRefusalCode,
  scope: AiBudgetScope,
  period: 'day' | 'month',
  end: Date,
  now: Date,
): AiBudgetDecision {
  return { allowed: false, code, scope, period, retryAfterSeconds: secondsUntil(end, now) };
}

/**
 * The budget decision for one model call. In order: company monthly, site
 * monthly, site daily (system-initiated surfaces only), user daily
 * (interactive surfaces only), driver daily (`driver_support` only, the
 * driver of the case). The first refusal wins; a budget of 0 is no limit.
 */
export async function evaluateAiBudgets(
  input: AiBudgetCheckInput,
  ctx: AiBudgetContext,
): Promise<AiBudgetDecision> {
  const now = input.now ?? new Date();
  const interactive = AI_INTERACTIVE_USAGE_SURFACES.includes(input.surface);
  const month = aiUsageMonth(aiUsageMonthOf(now, ctx.timeZone), ctx.timeZone);
  const day = aiUsageUtcDay(now);

  const company = ctx.limits.companyMonthlyTokens;
  if (company > 0 && (await ctx.tokens({ kind: 'company' }, month)) >= company) {
    return refuse('AI_MONTHLY_BUDGET_EXCEEDED', 'company', 'month', month.end, now);
  }
  const siteId = input.siteId ?? null;
  if (siteId !== null) {
    const siteMonthly = await ctx.siteMonthlyBudget(siteId);
    if (siteMonthly > 0 && (await ctx.tokens({ kind: 'site', siteId }, month)) >= siteMonthly) {
      return refuse('AI_MONTHLY_BUDGET_EXCEEDED', 'site', 'month', month.end, now);
    }
    const siteDaily = ctx.limits.siteDailyTokens;
    if (
      !interactive &&
      siteDaily > 0 &&
      (await ctx.tokens({ kind: 'siteSystem', siteId }, day)) >= siteDaily
    ) {
      return refuse('AI_SITE_BUDGET_EXCEEDED', 'site', 'day', day.end, now);
    }
  }
  if (interactive && input.userId !== undefined && ctx.limits.userDailyTokens > 0) {
    const used = await ctx.tokens({ kind: 'user', userId: input.userId }, day);
    if (used >= ctx.limits.userDailyTokens) {
      return refuse('AI_BUDGET_EXCEEDED', 'user', 'day', day.end, now);
    }
  }
  if (
    input.surface === 'driver_support' &&
    input.driverId !== undefined &&
    ctx.limits.driverDailyTokens > 0
  ) {
    const used = await ctx.tokens({ kind: 'driver', driverId: input.driverId }, day);
    if (used >= ctx.limits.driverDailyTokens) {
      return refuse('AI_BUDGET_EXCEEDED', 'driver', 'day', day.end, now);
    }
  }
  return { allowed: true };
}

async function liveBudgetContext(): Promise<AiBudgetContext> {
  const [settings, timeZone] = await Promise.all([getAiSettings(), getSystemTimezone()]);
  return {
    limits: settings.limits,
    timeZone,
    siteMonthlyBudget: (siteId) => getSiteMonthlyTokenBudget(siteId, settings.limits),
    tokens: cachedTokens,
  };
}

/**
 * Runs before every model call on every surface (`CheckAiBudgets`). A read
 * failure throws: budget checks fail closed (P9).
 */
export async function checkAiBudgets(input: AiBudgetCheckInput): Promise<AiBudgetDecision> {
  return evaluateAiBudgets(input, await liveBudgetContext());
}

// ---------------------------------------------------------------------------
// Ledger writes and threshold notices
// ---------------------------------------------------------------------------

/** One model call's usage. */
export interface AiUsageRecord {
  surface: AiUsageSurface;
  /** The user the call ran for; null for system-initiated calls. */
  userId?: string | null;
  /** The site the usage is charged to; null for usage that belongs to no site. */
  siteId?: string | null;
  conversationId?: string | null;
  aiMessageId?: string | null;
  insightId?: string | null;
  workerRunId?: string | null;
  /** The driver a `driver_support` call ran for (the driver daily budget). */
  driverId?: string | null;
  /** The support case of a `driver_support` call. */
  supportCaseId?: string | null;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    cachedReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  /** Provider cost in micro-USD; null when the model has no recorded prices. */
  costMicros: number | null;
  occurredAt?: Date;
}

function count(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** A threshold notice level a budget's usage reached, or null. */
export function aiBudgetLevel(
  used: number,
  limit: number,
  warnPercent: number,
): 'warn' | 'exceeded' | null {
  if (limit <= 0) return null;
  if (used >= limit) return 'exceeded';
  if (used * 100 >= limit * warnPercent) return 'warn';
  return null;
}

async function claimNotice(
  scope: 'company' | 'site',
  scopeId: string,
  period: string,
  level: 'warn' | 'exceeded',
): Promise<boolean> {
  const rows = await db
    .insert(aiBudgetNotices)
    .values({ scope, scopeId, period, level })
    .onConflictDoNothing()
    .returning({ level: aiBudgetNotices.level });
  return rows.length > 0;
}

async function announceScope(
  scope: 'company' | 'site',
  siteId: string | null,
  used: number,
  limit: number,
  warnPercent: number,
  month: string,
): Promise<void> {
  const level = aiBudgetLevel(used, limit, warnPercent);
  if (level === null) return;
  const scopeId = siteId ?? '';
  // At 100% the warn claim is taken silently: only the process that wins the
  // exceeded claim announces, so a late warn never follows an exceeded notice.
  let announce: 'warn' | 'exceeded' | null;
  if (level === 'exceeded') {
    await claimNotice(scope, scopeId, month, 'warn');
    announce = (await claimNotice(scope, scopeId, month, 'exceeded')) ? 'exceeded' : null;
  } else {
    announce = (await claimNotice(scope, scopeId, month, 'warn')) ? 'warn' : null;
  }
  if (announce === null) return;
  await getPubSub().publish(
    'csms_events',
    JSON.stringify({
      eventType: AI_USAGE_THRESHOLD_EVENT,
      scope,
      ...(siteId !== null ? { siteId } : {}),
      period: month,
      level: announce,
      percent: Math.floor((used * 100) / limit),
    }),
  );
}

/**
 * Sends the company and site threshold notices a new ledger row may have
 * crossed, once per scope, month and level (claim rows). Fail-open: a failure
 * is logged and the caller goes on (P9).
 */
async function announceThresholds(siteId: string | null, at: Date): Promise<void> {
  try {
    const ctx = await liveBudgetContext();
    const month = aiUsageMonth(aiUsageMonthOf(at, ctx.timeZone), ctx.timeZone);
    const { budgetWarnPercent: warnPercent, companyMonthlyTokens } = ctx.limits;
    if (companyMonthlyTokens > 0) {
      const used = await ctx.tokens({ kind: 'company' }, month);
      await announceScope('company', null, used, companyMonthlyTokens, warnPercent, month.month);
    }
    if (siteId !== null) {
      const limit = await ctx.siteMonthlyBudget(siteId);
      if (limit > 0) {
        const used = await ctx.tokens({ kind: 'site', siteId }, month);
        await announceScope('site', siteId, used, limit, warnPercent, month.month);
      }
    }
  } catch (err) {
    logger.warn({ err, siteId }, 'AI budget threshold notice failed, usage was recorded');
  }
}

/**
 * Writes one ledger row for one model call (the only writer), adds it to
 * this process's cached sums, and sends any threshold notice the call
 * crossed. An insert failure throws; the notice is fail-open.
 */
export async function recordAiUsage(record: AiUsageRecord): Promise<void> {
  const occurredAt = record.occurredAt ?? new Date();
  const siteId = record.siteId ?? null;
  await db.insert(aiUsageLedger).values({
    occurredAt,
    surface: record.surface,
    userId: record.userId ?? null,
    siteId,
    conversationId: record.conversationId ?? null,
    aiMessageId: record.aiMessageId ?? null,
    insightId: record.insightId ?? null,
    workerRunId: record.workerRunId ?? null,
    driverId: record.driverId ?? null,
    supportCaseId: record.supportCaseId ?? null,
    provider: record.provider,
    model: record.model,
    inputTokens: count(record.usage.inputTokens),
    cachedReadTokens: count(record.usage.cachedReadTokens),
    cacheWriteTokens: count(record.usage.cacheWriteTokens),
    outputTokens: count(record.usage.outputTokens),
    reasoningTokens: count(record.usage.reasoningTokens),
    costMicros: record.costMicros === null ? null : count(record.costMicros),
  });
  addToCachedSums(
    {
      surface: record.surface,
      userId: record.userId ?? null,
      siteId,
      driverId: record.driverId ?? null,
    },
    occurredAt,
    count(record.usage.inputTokens) + count(record.usage.outputTokens),
  );
  await announceThresholds(siteId, occurredAt);
}

// ---------------------------------------------------------------------------
// Reports (usage routes)
// ---------------------------------------------------------------------------

/** Token and cost sums of a group of ledger rows. */
export interface AiUsageSums {
  input: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costMicros: number;
}

const sumColumns = {
  input: sql<string>`COALESCE(SUM(${aiUsageLedger.inputTokens}), 0)`,
  cachedRead: sql<string>`COALESCE(SUM(${aiUsageLedger.cachedReadTokens}), 0)`,
  cacheWrite: sql<string>`COALESCE(SUM(${aiUsageLedger.cacheWriteTokens}), 0)`,
  output: sql<string>`COALESCE(SUM(${aiUsageLedger.outputTokens}), 0)`,
  reasoning: sql<string>`COALESCE(SUM(${aiUsageLedger.reasoningTokens}), 0)`,
  costMicros: sql<string>`COALESCE(SUM(${aiUsageLedger.costMicros}), 0)`,
};

function toSums(row: Record<keyof AiUsageSums, string | number>): AiUsageSums {
  return {
    input: Number(row.input),
    cachedRead: Number(row.cachedRead),
    cacheWrite: Number(row.cacheWrite),
    output: Number(row.output),
    reasoning: Number(row.reasoning),
    costMicros: Number(row.costMicros),
  };
}

/** Usage of a period grouped by site and surface; `siteId` null is usage that belongs to no site. */
export async function aiUsageBySiteAndSurface(
  period: AiUsagePeriod,
  siteId?: string,
): Promise<{ siteId: string | null; surface: AiUsageSurface; sums: AiUsageSums }[]> {
  const rows = await db
    .select({ siteId: aiUsageLedger.siteId, surface: aiUsageLedger.surface, ...sumColumns })
    .from(aiUsageLedger)
    .where(
      and(
        siteId !== undefined ? eq(aiUsageLedger.siteId, siteId) : undefined,
        gte(aiUsageLedger.occurredAt, period.start),
        lt(aiUsageLedger.occurredAt, period.end),
      ),
    )
    .groupBy(aiUsageLedger.siteId, aiUsageLedger.surface);
  return rows.map((r) => ({
    siteId: r.siteId,
    surface: r.surface as AiUsageSurface,
    sums: toSums(r),
  }));
}

/** The users with the most budget tokens in a period, most first. */
export async function aiUsageTopUsers(
  period: AiUsagePeriod,
  limit: number,
): Promise<{ userId: string; sums: AiUsageSums }[]> {
  const total = sql`SUM(${aiUsageLedger.inputTokens}::bigint + ${aiUsageLedger.outputTokens}::bigint)`;
  const rows = await db
    .select({ userId: aiUsageLedger.userId, ...sumColumns })
    .from(aiUsageLedger)
    .where(
      and(
        gte(aiUsageLedger.occurredAt, period.start),
        lt(aiUsageLedger.occurredAt, period.end),
        sql`${aiUsageLedger.userId} IS NOT NULL`,
      ),
    )
    .groupBy(aiUsageLedger.userId)
    .orderBy(desc(total))
    .limit(limit);
  return rows.map((r) => ({ userId: r.userId ?? '', sums: toSums(r) }));
}

/** A user's own usage in a period. */
export async function aiUsageOfUser(userId: string, period: AiUsagePeriod): Promise<AiUsageSums> {
  const [row] = await db
    .select(sumColumns)
    .from(aiUsageLedger)
    .where(
      and(
        eq(aiUsageLedger.userId, userId),
        gte(aiUsageLedger.occurredAt, period.start),
        lt(aiUsageLedger.occurredAt, period.end),
      ),
    );
  return row === undefined
    ? { input: 0, cachedRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costMicros: 0 }
    : toSums(row);
}
