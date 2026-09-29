// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  currencyTotals,
  groupDailyRevenue,
  orderByCurrency,
  toPeriodFinancials,
} from '../lib/currency-totals.js';

describe('orderByCurrency', () => {
  const weight = (e: { cents: number }): number => e.cents;

  it('puts the primary currency first even when it has less revenue', () => {
    const ordered = orderByCurrency(
      [
        { currency: 'USD', cents: 900 },
        { currency: 'EUR', cents: 100 },
      ],
      'EUR',
      weight,
    );
    expect(ordered.map((e) => e.currency)).toEqual(['EUR', 'USD']);
  });

  it('orders the rest by weight descending, then by code', () => {
    const ordered = orderByCurrency(
      [
        { currency: 'GBP', cents: 50 },
        { currency: 'CAD', cents: 50 },
        { currency: 'JPY', cents: 700 },
        { currency: 'USD', cents: 1 },
      ],
      'USD',
      weight,
    );
    expect(ordered.map((e) => e.currency)).toEqual(['USD', 'JPY', 'CAD', 'GBP']);
  });

  it('does not mutate the input', () => {
    const input = [
      { currency: 'USD', cents: 1 },
      { currency: 'EUR', cents: 2 },
    ];
    orderByCurrency(input, 'EUR', weight);
    expect(input.map((e) => e.currency)).toEqual(['USD', 'EUR']);
  });
});

describe('groupDailyRevenue', () => {
  it('folds currency rows into one entry per date and keeps currencies apart', () => {
    const result = groupDailyRevenue(
      [
        { date: '2026-09-01', currency: 'USD', revenueCents: '1500', sessionCount: '3' },
        { date: '2026-09-01', currency: 'EUR', revenueCents: 2000, sessionCount: 1 },
        { date: '2026-09-02', currency: 'EUR', revenueCents: 700, sessionCount: 2 },
      ],
      'EUR',
    );
    expect(result).toEqual([
      {
        date: '2026-09-01',
        sessionCount: 4,
        revenue: [
          { currency: 'EUR', revenueCents: 2000, sessionCount: 1 },
          { currency: 'USD', revenueCents: 1500, sessionCount: 3 },
        ],
      },
      {
        date: '2026-09-02',
        sessionCount: 2,
        revenue: [{ currency: 'EUR', revenueCents: 700, sessionCount: 2 }],
      },
    ]);
  });

  it('returns an empty list for no rows', () => {
    expect(groupDailyRevenue([], 'USD')).toEqual([]);
  });
});

describe('currencyTotals', () => {
  const zero = (currency: string) => ({ currency, cents: 0 });
  const weight = (e: { cents: number }): number => e.cents;

  it('returns a zero entry in the company currency when there are no entries', () => {
    expect(currencyTotals([], 'EUR', weight, zero)).toEqual([{ currency: 'EUR', cents: 0 }]);
  });

  it('does not add the company currency when other currencies have entries', () => {
    expect(currencyTotals([{ currency: 'USD', cents: 5 }], 'EUR', weight, zero)).toEqual([
      { currency: 'USD', cents: 5 },
    ]);
  });
});

describe('toPeriodFinancials', () => {
  it('converts string aggregates, computes profit per currency, and drops idle currencies', () => {
    const result = toPeriodFinancials(
      [
        {
          currency: 'USD',
          totalRevenueCents: '1000',
          avgRevenueCentsPerSession: '333.4',
          totalTransactions: '3',
          totalElectricityCostCents: '1500',
        },
        {
          currency: 'EUR',
          totalRevenueCents: '0',
          avgRevenueCentsPerSession: '0',
          totalTransactions: '0',
          totalElectricityCostCents: '0',
        },
      ],
      'EUR',
    );
    expect(result).toEqual([
      {
        currency: 'USD',
        totalRevenueCents: 1000,
        avgRevenueCentsPerSession: 333,
        totalTransactions: 3,
        totalElectricityCostCents: 1500,
        totalProfitCents: -500,
      },
    ]);
  });

  it('returns a zero entry in the company currency when there are no rows', () => {
    expect(toPeriodFinancials([], 'GBP')).toEqual([
      {
        currency: 'GBP',
        totalRevenueCents: 0,
        avgRevenueCentsPerSession: 0,
        totalTransactions: 0,
        totalElectricityCostCents: 0,
        totalProfitCents: 0,
      },
    ]);
  });
});
