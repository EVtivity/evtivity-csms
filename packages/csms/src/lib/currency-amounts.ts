// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Financial API responses carry one entry per currency, primary (company)
// currency first. Amounts in different currencies are never added together.

export interface CurrencyEntry {
  currency: string;
}

export interface DailyRevenue {
  date: string;
  sessionCount: number;
  revenue: { currency: string; revenueCents: number; sessionCount: number }[];
}

/** Splits API-ordered entries into the one shown large and the rest. */
export function splitPrimary<T extends CurrencyEntry>(
  entries: T[] | undefined,
): { primary: T | undefined; others: T[] } {
  const [primary, ...others] = entries ?? [];
  return { primary, others };
}

export function entryFor<T extends CurrencyEntry>(
  entries: T[] | undefined,
  currency: string | undefined,
): T | undefined {
  if (currency == null) return undefined;
  return entries?.find((e) => e.currency === currency);
}

/** Currencies in the order they first appear, so the primary one stays first. */
export function currenciesIn(days: DailyRevenue[]): string[] {
  const seen: string[] = [];
  for (const day of days) {
    for (const r of day.revenue) {
      if (!seen.includes(r.currency)) seen.push(r.currency);
    }
  }
  return seen;
}

/** Site and station metrics money for the reporting period, one per currency. */
export interface PeriodFinancial {
  currency: string;
  totalRevenueCents: number;
  avgRevenueCentsPerSession: number;
  totalTransactions: number;
  totalElectricityCostCents: number;
  totalProfitCents: number;
}
