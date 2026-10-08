// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectResults, queryRevenue } = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  queryRevenue: vi.fn(),
}));

/** A select chain that resolves to the next queued result whatever it is joined or filtered by. */
function chain(): unknown {
  const result = Promise.resolve(selectResults.shift() ?? []);
  const proxy: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy']) {
    proxy[method] = () => proxy;
  }
  proxy['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    result.then(resolve, reject);
  return proxy;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => chain()) },
  chargingSessions: { startedAt: 'started_at', currency: 'currency', stationId: 'station_id' },
  sites: { id: 'id', name: 'name' },
  chargingStations: { id: 'id', siteId: 'site_id' },
  paymentRecords: { sessionId: 'session_id', status: 'status' },
  getSystemTimezone: vi.fn(() => Promise.resolve('UTC')),
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
}));

vi.mock('../company-currency.js', () => ({ inCompanyCurrency: vi.fn() }));

vi.mock('../session-revenue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-revenue.js')>()),
  queryRevenue,
  paymentsKeptCentsSql: vi.fn(),
}));

const { generateRevenueReport } = await import('../report-generators/revenue-report.js');
const { EMPTY_REVENUE } = await import('../session-revenue.js');

beforeEach(() => {
  selectResults.length = 0;
  queryRevenue.mockReset();
});

describe('generateRevenueReport', () => {
  it('shows unpaid account sessions as billed on account, apart from revenue', async () => {
    // Day costs, site rows, payment breakdown.
    selectResults.push(
      [{ date: '2026-10-01', electricityCostCents: 100 }],
      [{ siteId: 'sit_1', siteName: 'Main', electricityCostCents: 100, energyKwh: 12 }],
      [],
    );
    const revenue = {
      ...EMPTY_REVENUE,
      grossCents: 1190,
      netCents: 1000,
      taxCents: 190,
      sessionCount: 1,
      sessionGrossCents: 1190,
      itemCount: 1,
      billedOnAccountCents: 2380,
      billedOnAccountCount: 2,
    };
    queryRevenue
      .mockResolvedValueOnce(new Map([['2026-10-01', revenue]]))
      .mockResolvedValueOnce(new Map([['sit_1', revenue]]));

    const { data } = await generateRevenueReport({}, 'csv', 'en');
    const lines = data.toString('utf-8').trim().split('\n');

    expect(lines[0]).toContain('Billed on Account (unpaid)');
    // Revenue 11.90, tax 1.90, net 10.00, electricity 1.00, profit 9.00, billed on account 23.80.
    expect(lines[1]).toContain('11.90,1.90,10.00,1.00,9.00,23.80,1');
  });
});
