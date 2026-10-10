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
  profitCents,
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
      billedOnAccountCents: 0,
      billedOnAccountCount: 0,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
    });
    expect(byKey.get(null)).toEqual({
      grossCents: 100,
      netCents: 100,
      taxCents: 0,
      sessionCount: 1,
      sessionGrossCents: 100,
      itemCount: 1,
      billedOnAccountCents: 0,
      billedOnAccountCount: 0,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
    });
  });

  it('keeps unpaid account sessions out of revenue and totals them as billed on account', () => {
    const byKey = aggregateRevenueRows([
      { key: null, taxRate: '0.19', grossCents: 1190, source: 'session', count: 1 },
      {
        key: null,
        taxRate: '0.19',
        grossCents: 2380,
        netCents: 2000,
        taxCents: 380,
        source: 'account',
        count: 2,
      },
    ]);
    expect(byKey.get(null)).toEqual({
      grossCents: 1190,
      netCents: 1000,
      taxCents: 190,
      sessionCount: 1,
      sessionGrossCents: 1190,
      itemCount: 1,
      billedOnAccountCents: 4760,
      billedOnAccountCount: 2,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
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
      billedOnAccountCents: 0,
      billedOnAccountCount: 0,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
    });
  });
});

describe('sessions without an electricity cost', () => {
  it('counts them apart, with their revenue tax included and excluded', () => {
    const byKey = aggregateRevenueRows([
      {
        key: 'a',
        taxRate: '0.19',
        grossCents: '1190',
        source: 'session',
        costMissing: false,
        count: '2',
      },
      {
        key: 'a',
        taxRate: '0.19',
        grossCents: '595',
        source: 'session',
        costMissing: true,
        count: '2',
      },
      // A stored split is used as is.
      {
        key: 'a',
        taxRate: '0.2',
        grossCents: 120,
        netCents: 100,
        taxCents: 20,
        source: 'session',
        costMissing: true,
        count: 1,
      },
      // Fees and unpaid account sessions are never cost missing.
      { key: 'a', taxRate: '0', grossCents: 300, source: 'fee', costMissing: false, count: 1 },
      { key: 'a', taxRate: '0', grossCents: 900, source: 'account', costMissing: true, count: 1 },
    ]);
    const a = byKey.get('a');
    expect(a).toMatchObject({
      grossCents: 2 * 1190 + 2 * 595 + 120 + 300,
      netCents: 2 * 1000 + 2 * 500 + 100 + 300,
      sessionCount: 5,
      costMissingCount: 3,
      costMissingGrossCents: 2 * 595 + 120,
      costMissingNetCents: 2 * 500 + 100,
    });
    // Profit: net revenue of the sessions with a cost (2000) plus the fee (300), minus the cost.
    expect(profitCents(a ?? EMPTY_REVENUE, 700)).toBe(2000 + 300 - 700);
  });

  it('gives the plain net revenue minus cost when every session has a cost', () => {
    const byKey = aggregateRevenueRows([
      { key: null, taxRate: '0', grossCents: 500, source: 'session', costMissing: false, count: 2 },
    ]);
    const total = byKey.get(null) ?? EMPTY_REVENUE;
    expect(total.costMissingCount).toBe(0);
    expect(total.costMissingGrossCents).toBe(0);
    expect(profitCents(total, 400)).toBe(600);
  });

  it('marks a session with energy and no electricity cost in the query', async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValueOnce([
      {
        key: null,
        tax_rate: '0',
        gross_cents: 500,
        source: 'session',
        cost_missing: true,
        count: 1,
      },
    ]);
    const total = await queryRevenueTotal({ companyCurrency: 'EUR' });
    expect(total.costMissingCount).toBe(1);
    expect(total.costMissingGrossCents).toBe(500);
    const text = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(text).toContain('cs.electricity_cost_cents IS NULL');
    expect(text).toContain('coalesce(cs.energy_delivered_wh, 0) > 0');
    expect(text).toContain('false AS cost_missing');
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
      billedOnAccountCents: 300,
      billedOnAccountCount: 1,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
    };
    expect(sumRevenue([a, b])).toEqual({
      grossCents: 169,
      netCents: 150,
      taxCents: 19,
      sessionCount: 1,
      sessionGrossCents: 50,
      itemCount: 2,
      billedOnAccountCents: 300,
      billedOnAccountCount: 1,
      costMissingCount: 0,
      costMissingGrossCents: 0,
      costMissingNetCents: 0,
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

  it('counts an account session as revenue only once its invoice is paid', async () => {
    mockExecute.mockResolvedValueOnce([]);
    await queryRevenue({ companyCurrency: 'EUR' });
    const text = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(text).toContain("cs.billing_mode = 'account' AND pr.id IS NULL");
    expect(text).toContain("inv.status IS DISTINCT FROM 'paid'");
    expect(text).toContain('LEFT JOIN invoices inv ON inv.id = cs.invoice_id');
    // Dated by the collection date once paid; a zero-cost one is not billed on account.
    expect(text).toContain('THEN coalesce(inv.paid_at, cs.started_at) ELSE cs.started_at END');
    expect(text).toContain('cs.final_cost_cents > 0');
  });

  it('gives an empty total without revenue', async () => {
    mockExecute.mockResolvedValueOnce([]);
    await expect(queryRevenueTotal({ companyCurrency: 'EUR' })).resolves.toEqual(EMPTY_REVENUE);
  });
});
