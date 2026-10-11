// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import {
  aiBudgetLevel,
  aiUsageMonth,
  aiUsageMonthOf,
  aiUsageUtcDay,
  evaluateAiBudgets,
} from '../lib/ai-usage.js';
import type { AiBudgetContext, AiBudgetSumKey, AiUsagePeriod } from '../lib/ai-usage.js';
import type { AiUsageSurface } from '@evtivity/lib/ai-usage';

describe('AI usage periods', () => {
  it('TC-AI-US-10 bounds a month at local midnight in the system timezone, DST months included', () => {
    // US spring forward on 2026-03-08: March starts at UTC-5 and ends at UTC-4.
    const march = aiUsageMonth('2026-03', 'America/New_York');
    expect(march.start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(march.end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
    // US fall back on 2026-11-01 at 02:00: midnight is still UTC-4.
    const november = aiUsageMonth('2026-11', 'America/New_York');
    expect(november.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(november.end.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    // EU fall back on 2026-10-25.
    const october = aiUsageMonth('2026-10', 'Europe/Berlin');
    expect(october.start.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    // December rolls into the next year.
    expect(aiUsageMonth('2026-12', 'UTC').end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('TC-AI-US-10 finds the month of an instant in the system timezone, UTC for an invalid zone', () => {
    const at = new Date('2026-10-31T23:30:00Z');
    expect(aiUsageMonthOf(at, 'Europe/Berlin')).toBe('2026-11');
    expect(aiUsageMonthOf(at, 'America/Los_Angeles')).toBe('2026-10');
    expect(aiUsageMonthOf(at, 'Not/AZone')).toBe('2026-10');
    expect(aiUsageMonth('2026-10', 'Not/AZone').start.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('refuses a malformed month', () => {
    expect(() => aiUsageMonth('2026-13', 'UTC')).toThrow('Invalid month');
    expect(() => aiUsageMonth('26-10', 'UTC')).toThrow('Invalid month');
  });

  it('a daily period is the UTC day', () => {
    const day = aiUsageUtcDay(new Date('2026-10-10T18:00:00Z'));
    expect(day.start.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });
});

const NOW = new Date('2026-10-10T12:00:00Z');

/** A context with fixed sums: company, per site (month and day) and per user (day). */
function context(
  over: Partial<Omit<AiBudgetContext['limits'], 'userDailyTokens' | 'driverDailyTokens'>> & {
    userDaily?: number;
    driverDaily?: number;
    siteBudgets?: Record<string, number>;
    used?: {
      company?: number;
      siteMonth?: Record<string, number>;
      siteDay?: Record<string, number>;
      userDay?: Record<string, number>;
      driverDay?: Record<string, number>;
    };
  } = {},
): AiBudgetContext & { calls: string[] } {
  const calls: string[] = [];
  const isDay = (p: AiUsagePeriod): boolean => p.end.getTime() - p.start.getTime() === 86_400_000;
  return {
    calls,
    limits: {
      companyMonthlyTokens: over.companyMonthlyTokens ?? 0,
      siteMonthlyTokens: over.siteMonthlyTokens ?? 0,
      siteDailyTokens: over.siteDailyTokens ?? 0,
      budgetWarnPercent: over.budgetWarnPercent ?? 80,
      userDailyTokens: over.userDaily ?? 0,
      driverDailyTokens: over.driverDaily ?? 0,
    },
    timeZone: 'UTC',
    siteMonthlyBudget: (siteId) =>
      Promise.resolve(over.siteBudgets?.[siteId] ?? over.siteMonthlyTokens ?? 0),
    tokens: (key: AiBudgetSumKey, period: AiUsagePeriod) => {
      const day = isDay(period);
      calls.push(`${key.kind}:${day ? 'day' : 'month'}`);
      const used = over.used ?? {};
      if (key.kind === 'company') return Promise.resolve(used.company ?? 0);
      if (key.kind === 'site' || key.kind === 'siteSystem') {
        return Promise.resolve(
          (day ? used.siteDay?.[key.siteId] : used.siteMonth?.[key.siteId]) ?? 0,
        );
      }
      if (key.kind === 'driver') return Promise.resolve(used.driverDay?.[key.driverId] ?? 0);
      return Promise.resolve(used.userDay?.[key.userId] ?? 0);
    },
  };
}

const ALL_SURFACES: AiUsageSurface[] = [
  'chatbot',
  'support',
  'insight',
  'insight_translation',
  'worker',
  'driver_support',
];

describe('evaluateAiBudgets', () => {
  it('TC-AI-US-04 the company monthly budget refuses every surface, until the month ends', async () => {
    const ctx = context({ companyMonthlyTokens: 1_000, used: { company: 1_000 } });
    for (const surface of ALL_SURFACES) {
      expect(
        await evaluateAiBudgets({ surface, userId: 'usr_1', siteId: 'sit_1', now: NOW }, ctx),
        surface,
      ).toEqual({
        allowed: false,
        code: 'AI_MONTHLY_BUDGET_EXCEEDED',
        scope: 'company',
        period: 'month',
        retryAfterSeconds: 21 * 86_400 + 12 * 3_600,
      });
    }
    expect(
      await evaluateAiBudgets(
        { surface: 'chatbot', userId: 'usr_1', now: NOW },
        context({ companyMonthlyTokens: 1_000, used: { company: 999 } }),
      ),
    ).toEqual({ allowed: true });
  });

  it('the company refusal wins over a site and a user refusal', async () => {
    const ctx = context({
      companyMonthlyTokens: 10,
      siteMonthlyTokens: 10,
      userDaily: 10,
      used: { company: 10, siteMonth: { sit_1: 10 }, userDay: { usr_1: 10 } },
    });
    const decision = await evaluateAiBudgets(
      { surface: 'support', userId: 'usr_1', siteId: 'sit_1', now: NOW },
      ctx,
    );
    expect(decision).toMatchObject({ code: 'AI_MONTHLY_BUDGET_EXCEEDED', scope: 'company' });
    expect(ctx.calls).toEqual(['company:month']);
  });

  it('TC-AI-US-05 the site monthly budget refuses only usage charged to that site', async () => {
    const ctx = context({ siteBudgets: { sit_a: 500 }, used: { siteMonth: { sit_a: 600 } } });
    expect(
      await evaluateAiBudgets({ surface: 'support', userId: 'u', siteId: 'sit_a', now: NOW }, ctx),
    ).toMatchObject({ allowed: false, code: 'AI_MONTHLY_BUDGET_EXCEEDED', scope: 'site' });
    expect(
      await evaluateAiBudgets({ surface: 'insight', siteId: 'sit_a', now: NOW }, ctx),
    ).toMatchObject({ allowed: false, scope: 'site', period: 'month' });
    // Another site, and the chatbot (charged to no site), still run.
    expect(
      await evaluateAiBudgets({ surface: 'support', userId: 'u', siteId: 'sit_b', now: NOW }, ctx),
    ).toEqual({ allowed: true });
    expect(
      await evaluateAiBudgets({ surface: 'chatbot', userId: 'u', siteId: null, now: NOW }, ctx),
    ).toEqual({ allowed: true });
  });

  it('a site override of 0 means no limit for that site', async () => {
    const ctx = context({
      siteMonthlyTokens: 100,
      siteBudgets: { sit_a: 0 },
      used: { siteMonth: { sit_a: 10_000 } },
    });
    expect(await evaluateAiBudgets({ surface: 'worker', siteId: 'sit_a', now: NOW }, ctx)).toEqual({
      allowed: true,
    });
  });

  it('the site daily budget applies to system-initiated surfaces only', async () => {
    const ctx = context({ siteDailyTokens: 300, used: { siteDay: { sit_a: 300 } } });
    for (const surface of ['insight', 'insight_translation', 'worker'] as const) {
      expect(await evaluateAiBudgets({ surface, siteId: 'sit_a', now: NOW }, ctx), surface).toEqual(
        {
          allowed: false,
          code: 'AI_SITE_BUDGET_EXCEEDED',
          scope: 'site',
          period: 'day',
          retryAfterSeconds: 12 * 3_600,
        },
      );
    }
    expect(
      await evaluateAiBudgets({ surface: 'support', userId: 'u', siteId: 'sit_a', now: NOW }, ctx),
    ).toEqual({ allowed: true });
    // TC-AI-DR-02: driver support is interactive, so the site daily budget does not apply (E10).
    expect(
      await evaluateAiBudgets(
        { surface: 'driver_support', driverId: 'drv_1', siteId: 'sit_a', now: NOW },
        ctx,
      ),
    ).toEqual({ allowed: true });
  });

  it('TC-AI-US-03 the user daily budget applies to interactive surfaces, counting from midnight UTC', async () => {
    const ctx = context({ userDaily: 1_000, used: { userDay: { usr_1: 1_000 } } });
    expect(await evaluateAiBudgets({ surface: 'chatbot', userId: 'usr_1', now: NOW }, ctx)).toEqual(
      {
        allowed: false,
        code: 'AI_BUDGET_EXCEEDED',
        scope: 'user',
        period: 'day',
        retryAfterSeconds: 12 * 3_600,
      },
    );
    expect(await evaluateAiBudgets({ surface: 'chatbot', userId: 'usr_2', now: NOW }, ctx)).toEqual(
      { allowed: true },
    );
    expect(
      await evaluateAiBudgets({ surface: 'worker', userId: 'usr_1', siteId: 's', now: NOW }, ctx),
    ).toEqual({ allowed: true });
  });

  it('TC-AI-DR-16 the driver daily budget applies to driver support only, per driver', async () => {
    const ctx = context({ driverDaily: 40_000, used: { driverDay: { drv_1: 40_000 } } });
    expect(
      await evaluateAiBudgets(
        { surface: 'driver_support', driverId: 'drv_1', siteId: 'sit_a', now: NOW },
        ctx,
      ),
    ).toEqual({
      allowed: false,
      code: 'AI_BUDGET_EXCEEDED',
      scope: 'driver',
      period: 'day',
      retryAfterSeconds: 12 * 3_600,
    });
    expect(
      await evaluateAiBudgets({ surface: 'driver_support', driverId: 'drv_2', now: NOW }, ctx),
    ).toEqual({ allowed: true });
    // Another surface never reads the driver scope.
    expect(
      await evaluateAiBudgets(
        { surface: 'support', userId: 'u', driverId: 'drv_1', now: NOW },
        ctx,
      ),
    ).toEqual({ allowed: true });
    expect(ctx.calls.filter((c) => c.startsWith('driver'))).toEqual(['driver:day', 'driver:day']);
  });

  it('TC-AI-DR-16 company and case site monthly budgets refuse driver support before the driver scope', async () => {
    const ctx = context({
      companyMonthlyTokens: 100,
      siteMonthlyTokens: 50,
      driverDaily: 10,
      used: { company: 100, siteMonth: { sit_a: 50 }, driverDay: { drv_1: 10 } },
    });
    const company = await evaluateAiBudgets(
      { surface: 'driver_support', driverId: 'drv_1', siteId: 'sit_a', now: NOW },
      ctx,
    );
    expect(company).toMatchObject({ allowed: false, scope: 'company', period: 'month' });
    const siteOnly = context({
      siteMonthlyTokens: 50,
      driverDaily: 10,
      used: { siteMonth: { sit_a: 50 }, driverDay: { drv_1: 10 } },
    });
    expect(
      await evaluateAiBudgets(
        { surface: 'driver_support', driverId: 'drv_1', siteId: 'sit_a', now: NOW },
        siteOnly,
      ),
    ).toMatchObject({ allowed: false, scope: 'site', period: 'month' });
  });

  it('budgets of 0 read nothing and allow', async () => {
    const ctx = context({ used: { company: 1e12 } });
    expect(
      await evaluateAiBudgets({ surface: 'support', userId: 'u', siteId: 's', now: NOW }, ctx),
    ).toEqual({ allowed: true });
    expect(ctx.calls).toEqual([]);
  });

  it('fails closed: a sum that cannot be read rejects the check', async () => {
    const ctx = context({ companyMonthlyTokens: 10 });
    ctx.tokens = () => Promise.reject(new Error('db down'));
    await expect(
      evaluateAiBudgets({ surface: 'chatbot', userId: 'u', now: NOW }, ctx),
    ).rejects.toThrow('db down');
  });
});

describe('aiBudgetLevel', () => {
  it('warns at warnPercent, reports exceeded at 100%, and nothing without a limit', () => {
    expect(aiBudgetLevel(79, 100, 80)).toBeNull();
    expect(aiBudgetLevel(80, 100, 80)).toBe('warn');
    expect(aiBudgetLevel(99, 100, 80)).toBe('warn');
    expect(aiBudgetLevel(100, 100, 80)).toBe('exceeded');
    expect(aiBudgetLevel(1e9, 0, 80)).toBeNull();
  });
});
