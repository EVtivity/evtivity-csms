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

// A 1x1 PNG logo and no footer: pdf-branding.test.ts covers the branding.
vi.mock('../pdf-branding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf-branding.js')>()),
  loadPdfBranding: vi.fn(() =>
    Promise.resolve({
      logo: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
      isDefaultLogo: false,
      footer: '',
    }),
  ),
}));

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

    const { data } = await generateRevenueReport({}, 'csv', 'en', null);
    const lines = data.toString('utf-8').trim().split('\n');

    expect(lines[0]).toContain('Billed on Account (unpaid)');
    // Revenue 11.90, tax 1.90, net 10.00, electricity 1.00, profit 9.00, billed on account 23.80.
    expect(lines[1]).toContain('11.90,1.90,10.00,1.00,9.00,23.80,1');
  });

  it('leaves sessions without an electricity cost out of profit and counts them', async () => {
    selectResults.push(
      [{ date: '2026-10-01', electricityCostCents: 100 }],
      [{ siteId: 'sit_1', siteName: 'Main', electricityCostCents: 100, energyKwh: 12 }],
      [],
    );
    // Two sessions: one with a cost (net 10.00), one without (net 5.00).
    const revenue = {
      ...EMPTY_REVENUE,
      grossCents: 1500,
      netCents: 1500,
      sessionCount: 2,
      sessionGrossCents: 1500,
      itemCount: 2,
      costMissingCount: 1,
      costMissingGrossCents: 500,
      costMissingNetCents: 500,
    };
    queryRevenue
      .mockResolvedValueOnce(new Map([['2026-10-01', revenue]]))
      .mockResolvedValueOnce(new Map([['sit_1', revenue]]));

    const csv = (await generateRevenueReport({}, 'csv', 'en', null)).data.toString('utf-8');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('Sessions without Electricity Cost (not in profit)');
    // Revenue 15.00, tax 0, net 15.00, electricity 1.00, profit 10.00 - 1.00 = 9.00, 2 sessions, 1 without cost.
    expect(lines[1]).toContain('15.00,0.00,15.00,1.00,9.00,0.00,2,1');

    selectResults.push(
      [{ date: '2026-10-01', electricityCostCents: 100 }],
      [{ siteId: 'sit_1', siteName: 'Main', electricityCostCents: 100, energyKwh: 12 }],
      [],
    );
    queryRevenue
      .mockResolvedValueOnce(new Map([['2026-10-01', revenue]]))
      .mockResolvedValueOnce(new Map([['sit_1', revenue]]));
    const pdf = await generateRevenueReport({}, 'pdf', 'en', null);
    expect(pdf.data.length).toBeGreaterThan(0);
  });
});
