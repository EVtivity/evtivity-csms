// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Money aggregates never add amounts in different currencies. Every revenue
// and cost query groups by currency, and responses carry one entry per
// currency. There is no conversion.

import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { chargingSessions } from '@evtivity/database';

export const currencyCode = z
  .string()
  .length(3)
  .describe('ISO 4217 currency code of the amounts in this entry (e.g. USD, EUR)');

/**
 * A session's currency, upper-cased: the currency of its tariff, or the
 * company currency for sessions without one (free sessions, sessions before
 * tariff resolution). Group by position (`groupBy(sql\`1\`)`) rather than by this
 * expression: the bound fallback parameter makes a repeated expression
 * compare unequal in PostgreSQL's GROUP BY check.
 */
export function sessionCurrencySql(fallback: string): SQL<string> {
  return sql<string>`upper(coalesce(${chargingSessions.currency}, ${fallback}))`;
}

/**
 * Orders per-currency entries: the company currency first, then by `weight`
 * descending, then by code, so the order is stable between requests.
 */
export function orderByCurrency<T extends { currency: string }>(
  entries: T[],
  primary: string,
  weight: (entry: T) => number,
): T[] {
  return [...entries].sort((a, b) => {
    if (a.currency === primary) return b.currency === primary ? 0 : -1;
    if (b.currency === primary) return 1;
    const diff = weight(b) - weight(a);
    return diff !== 0 ? diff : a.currency.localeCompare(b.currency);
  });
}

/**
 * Orders per-currency totals with `orderByCurrency`. An empty result becomes a
 * single zero entry in the company currency, so clients always have an entry
 * to display.
 */
export function currencyTotals<T extends { currency: string }>(
  entries: T[],
  primary: string,
  weight: (entry: T) => number,
  zero: (currency: string) => T,
): T[] {
  return entries.length === 0 ? [zero(primary)] : orderByCurrency(entries, primary, weight);
}

export const dailyRevenueItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD format (local timezone)'),
    sessionCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of billable sessions started on this date, across all currencies'),
    revenue: z
      .array(
        z
          .object({
            currency: currencyCode,
            revenueCents: z
              .number()
              .int()
              .min(0)
              .describe('Revenue in this currency on this date, in minor units (cents)'),
            sessionCount: z
              .number()
              .int()
              .min(0)
              .describe('Number of billable sessions in this currency on this date'),
          })
          .passthrough(),
      )
      .describe(
        'Revenue per currency, company currency first. Empty on days without billable sessions.',
      ),
  })
  .passthrough();

export type DailyRevenue = z.infer<typeof dailyRevenueItem>;

export interface DailyRevenueRow {
  date: string;
  currency: string;
  revenueCents: number | string;
  sessionCount: number | string;
}

/**
 * Folds (date, currency) rows into one entry per date with a per-currency
 * list. Numeric columns may arrive as strings from aggregate SQL.
 */
export function groupDailyRevenue(rows: DailyRevenueRow[], primary: string): DailyRevenue[] {
  const byDate = new Map<string, DailyRevenue>();
  for (const row of rows) {
    const revenueCents = Number(row.revenueCents);
    const sessionCount = Number(row.sessionCount);
    let day = byDate.get(row.date);
    if (day == null) {
      day = { date: row.date, sessionCount: 0, revenue: [] };
      byDate.set(row.date, day);
    }
    day.sessionCount += sessionCount;
    day.revenue.push({ currency: row.currency, revenueCents, sessionCount });
  }
  return [...byDate.values()].map((day) => ({
    ...day,
    revenue: orderByCurrency(day.revenue, primary, (r) => r.revenueCents),
  }));
}

export const periodFinancialItem = z
  .object({
    currency: currencyCode,
    totalRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Total revenue in this currency over the period, in cents'),
    avgRevenueCentsPerSession: z
      .number()
      .min(0)
      .describe('Average revenue per billable session in this currency, in cents'),
    totalTransactions: z
      .number()
      .int()
      .min(0)
      .describe('Number of billable sessions (sessions with cost data) in this currency'),
    totalElectricityCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Wholesale electricity cost of sessions in this currency, in cents'),
    totalProfitCents: z
      .number()
      .int()
      .describe('Revenue minus electricity cost in this currency, in cents; may be negative'),
  })
  .passthrough();

export const periodFinancials = z
  .array(periodFinancialItem)
  .describe(
    'Financial totals per currency. Amounts in different currencies are never added together. The company currency comes first when it has activity. Never empty: without activity it holds one zero entry in the company currency.',
  );

export type PeriodFinancial = z.infer<typeof periodFinancialItem>;

/** Select list for per-currency period financials; group by position 1. */
export function periodFinancialsSelect(companyCurrency: string) {
  const cost = sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})`;
  return {
    currency: sessionCurrencySql(companyCurrency),
    totalRevenueCents: sql<string>`coalesce(sum(${cost}), 0)`,
    avgRevenueCentsPerSession: sql<string>`coalesce(avg(${cost}), 0)`,
    totalTransactions: sql<string>`count(*) filter (where ${cost} is not null)`,
    totalElectricityCostCents: sql<string>`coalesce(sum(${chargingSessions.electricityCostCents}), 0)`,
  };
}

export function toPeriodFinancials(
  rows: {
    currency: string;
    totalRevenueCents: string | number;
    avgRevenueCentsPerSession: string | number;
    totalTransactions: string | number;
    totalElectricityCostCents: string | number;
  }[],
  companyCurrency: string,
): PeriodFinancial[] {
  const entries = rows
    .map((r) => {
      const totalRevenueCents = Number(r.totalRevenueCents);
      const totalElectricityCostCents = Number(r.totalElectricityCostCents);
      return {
        currency: r.currency,
        totalRevenueCents,
        avgRevenueCentsPerSession: Math.round(Number(r.avgRevenueCentsPerSession)),
        totalTransactions: Number(r.totalTransactions),
        totalElectricityCostCents,
        totalProfitCents: totalRevenueCents - totalElectricityCostCents,
      };
    })
    .filter(
      (e) => e.totalTransactions > 0 || e.totalRevenueCents > 0 || e.totalElectricityCostCents > 0,
    );
  return currencyTotals(
    entries,
    companyCurrency,
    (e) => e.totalRevenueCents,
    (currency) => ({
      currency,
      totalRevenueCents: 0,
      avgRevenueCentsPerSession: 0,
      totalTransactions: 0,
      totalElectricityCostCents: 0,
      totalProfitCents: 0,
    }),
  );
}
