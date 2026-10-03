// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
const mockGetCompanyCurrency = vi.fn();
const mockQueryRevenueTotal = vi.fn();

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

vi.mock('../lib/session-revenue.js', () => ({
  queryRevenueTotal: (input: unknown) => mockQueryRevenueTotal(input),
}));

const { collectBusinessMetrics } = await import('../services/metrics-collector.service.js');
const { revenueCentsTotal } = await import('../plugins/metrics.js');

function revenue(grossCents: number): Record<string, number> {
  return {
    grossCents,
    netCents: grossCents,
    taxCents: 0,
    sessionCount: 1,
    sessionGrossCents: grossCents,
    itemCount: 1,
  };
}

describe('collectBusinessMetrics revenue', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([]);
    mockGetCompanyCurrency.mockReset();
    mockQueryRevenueTotal.mockReset();
  });

  it('reports the shared revenue (incl. tax) in the company currency', async () => {
    mockGetCompanyCurrency.mockResolvedValue('EUR');
    mockQueryRevenueTotal.mockResolvedValue(revenue(125000));

    await collectBusinessMetrics();

    // The one revenue definition: ended sessions and fees minus refunds.
    expect(mockQueryRevenueTotal).toHaveBeenCalledWith({ companyCurrency: 'EUR' });
    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => [v.labels.currency, v.value])).toEqual([['EUR', 125000]]);
  });

  it('drops the previous series when the company currency changes', async () => {
    mockGetCompanyCurrency.mockResolvedValue('USD');
    mockQueryRevenueTotal.mockResolvedValue(revenue(10));
    await collectBusinessMetrics();

    mockGetCompanyCurrency.mockResolvedValue('GBP');
    mockQueryRevenueTotal.mockResolvedValue(revenue(20));
    await collectBusinessMetrics();

    const { values } = await revenueCentsTotal.get();
    expect(values.map((v) => [v.labels.currency, v.value])).toEqual([['GBP', 20]]);
  });
});
