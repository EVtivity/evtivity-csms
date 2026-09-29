// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
const mockGetCompanyCurrency = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { execute: mockExecute },
  getCompanyCurrency: mockGetCompanyCurrency,
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const { collectBusinessMetrics } = await import('../services/metrics-collector.service.js');
const { revenueCentsTotal } = await import('../plugins/metrics.js');

function queryText(arg: unknown): string {
  return (arg as { strings: readonly string[] }).strings.join('?');
}

function mockRevenue(total: string | number): void {
  mockExecute.mockImplementation((arg: unknown) =>
    Promise.resolve(queryText(arg).includes('SUM(final_cost_cents)') ? [{ total }] : []),
  );
}

describe('collectBusinessMetrics revenue', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockGetCompanyCurrency.mockReset();
  });

  it('reports one revenue series of company-currency sessions, labelled with that currency', async () => {
    mockGetCompanyCurrency.mockResolvedValue('EUR');
    let revenueQuery: string | undefined;
    let revenueValues: unknown[] = [];
    mockExecute.mockImplementation((arg: unknown) => {
      if (queryText(arg).includes('SUM(final_cost_cents)')) {
        revenueQuery = queryText(arg);
        revenueValues = (arg as { values: unknown[] }).values;
        return Promise.resolve([{ total: '125000' }]);
      }
      return Promise.resolve([]);
    });

    await collectBusinessMetrics();

    expect(revenueQuery).not.toContain('GROUP BY');
    expect(revenueQuery).toContain('UPPER(currency) = ?');
    expect(revenueValues).toEqual(['EUR']);
    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => [v.labels.currency, v.value])).toEqual([['EUR', 125000]]);
  });

  it('drops the previous series when the company currency changes', async () => {
    mockGetCompanyCurrency.mockResolvedValue('USD');
    mockRevenue(10);
    await collectBusinessMetrics();

    mockGetCompanyCurrency.mockResolvedValue('GBP');
    mockRevenue(20);
    await collectBusinessMetrics();

    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => [v.labels.currency, v.value])).toEqual([['GBP', 20]]);
  });
});
