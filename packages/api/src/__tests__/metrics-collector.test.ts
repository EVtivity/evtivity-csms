// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { execute: mockExecute },
  getCompanyCurrency: vi.fn().mockResolvedValue('EUR'),
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

describe('collectBusinessMetrics revenue', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('reports revenue per currency and falls back to the company currency', async () => {
    let revenueQuery: { strings: readonly string[]; values: unknown[] } | undefined;
    mockExecute.mockImplementation((arg: unknown) => {
      if (queryText(arg).includes('SUM(final_cost_cents)')) {
        revenueQuery = arg as { strings: readonly string[]; values: unknown[] };
        return Promise.resolve([
          { currency: 'EUR', total: '120000' },
          { currency: 'USD', total: '5000' },
        ]);
      }
      return Promise.resolve([]);
    });

    await collectBusinessMetrics();

    expect(revenueQuery?.values).toEqual(['EUR']);
    expect(queryText(revenueQuery)).toContain('GROUP BY 1');
    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => [v.labels.currency, v.value])).toEqual([
      ['EUR', 120000],
      ['USD', 5000],
    ]);
  });

  it('drops currencies that no longer have revenue', async () => {
    mockExecute.mockImplementation((arg: unknown) =>
      Promise.resolve(
        queryText(arg).includes('SUM(final_cost_cents)') ? [{ currency: 'EUR', total: 10 }] : [],
      ),
    );
    await collectBusinessMetrics();

    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => v.labels.currency)).toEqual(['EUR']);
  });
});
