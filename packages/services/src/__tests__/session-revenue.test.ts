// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
vi.mock('@evtivity/database', () => ({ db: { execute: (q: unknown) => mockExecute(q) } }));

import {
  aggregateRevenueRows,
  sumRevenue,
  queryRevenue,
  queryRevenueTotal,
  EMPTY_REVENUE,
} from '../session-revenue.js';

describe('aggregateRevenueRows', () => {
  it('splits every amount at its own rate and counts sessions apart from fees', () => {
    const byKey = aggregateRevenueRows([
      { key: 'a', taxRate: '0.19', grossCents: '1190', source: 'session', count: '3' },
      { key: 'a', taxRate: '0.07', grossCents: 480, source: 'session', count: 1 },
      { key: 'a', taxRate: '0.19', grossCents: 595, source: 'fee', count: 2 },
      { key: null, taxRate: '0', grossCents: 100, source: 'session', count: 1 },
    ]);
    expect(byKey.get('a')).toEqual({
      grossCents: 3 * 1190 + 480 + 2 * 595,
      netCents: 3 * 1000 + 449 + 2 * 500,
      taxCents: 3 * 190 + 31 + 2 * 95,
      sessionCount: 4,
      sessionGrossCents: 3 * 1190 + 480,
      itemCount: 6,
    });
    expect(byKey.get(null)).toEqual({
      grossCents: 100,
      netCents: 100,
      taxCents: 0,
      sessionCount: 1,
      sessionGrossCents: 100,
      itemCount: 1,
    });
  });

  it('returns no keys without rows', () => {
    expect(aggregateRevenueRows([]).size).toBe(0);
  });
});

describe('aggregateRevenueRows with stored splits', () => {
  it('counts the stored net and tax of a session and splits the rest at its rate', () => {
    const byKey = aggregateRevenueRows([
      // A split-billed session: 1130 with a stored 1000 net and 130 tax.
      {
        key: null,
        taxRate: '0.19',
        grossCents: 1130,
        netCents: 1000,
        taxCents: 130,
        source: 'session',
        count: 2,
      },
      // A partly refunded session: no stored split for what is left.
      {
        key: null,
        taxRate: '0.19',
        grossCents: 119,
        netCents: null,
        taxCents: null,
        source: 'session',
        count: 1,
      },
    ]);
    expect(byKey.get(null)).toEqual({
      netCents: 2000 + 100,
      taxCents: 260 + 19,
      grossCents: 2260 + 119,
      sessionCount: 3,
      sessionGrossCents: 2379,
      itemCount: 3,
    });
  });
});

describe('sumRevenue', () => {
  it('adds every amount and count', () => {
    const a = { ...EMPTY_REVENUE, grossCents: 119, netCents: 100, taxCents: 19, itemCount: 1 };
    const b = {
      grossCents: 50,
      netCents: 50,
      taxCents: 0,
      sessionCount: 1,
      sessionGrossCents: 50,
      itemCount: 1,
    };
    expect(sumRevenue([a, b])).toEqual({
      grossCents: 169,
      netCents: 150,
      taxCents: 19,
      sessionCount: 1,
      sessionGrossCents: 50,
      itemCount: 2,
    });
    expect(sumRevenue([])).toEqual(EMPTY_REVENUE);
  });
});

describe('queryRevenue', () => {
  beforeEach(() => mockExecute.mockReset());

  it('maps the grouped rows of the database', async () => {
    mockExecute.mockResolvedValueOnce([
      { key: '2026-01-01', tax_rate: '0.2', gross_cents: '1200', source: 'session', count: '2' },
    ]);
    const byDay = await queryRevenue({ companyCurrency: 'EUR' });
    expect(byDay.get('2026-01-01')).toMatchObject({
      grossCents: 2400,
      netCents: 2000,
      taxCents: 400,
      sessionCount: 2,
    });
  });

  it('gives an empty total without revenue', async () => {
    mockExecute.mockResolvedValueOnce([]);
    await expect(queryRevenueTotal({ companyCurrency: 'EUR' })).resolves.toEqual(EMPTY_REVENUE);
  });
});
