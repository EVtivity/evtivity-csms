// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The revenue report merge rules (`revenue-report.ts`): days with only a cost
// or only revenue, sites with revenue but no billed session (names read
// afterwards), revenue without a site under the no-site label, profit, the
// site filter and scope joins, and the XLSX and PDF outputs.

import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbCall, FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams } from './helpers/fake-db.js';

interface PdfCall {
  summary: [string, string][];
  tables: { headers: string[]; rows: unknown[][] }[];
}

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  pdfs: [] as PdfCall[],
  byDay: new Map<string | null, Record<string, number>>(),
  bySite: new Map<string | null, Record<string, number>>(),
  revenueWhere: [] as unknown[][],
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const { sql } = await import('drizzle-orm');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSystemTimezone: () => Promise.resolve('UTC'),
    getCompanyCurrency: () => Promise.resolve('EUR'),
    inOperatorStation: (col: unknown) => sql`in_operator(${col})`,
  });
});

vi.mock('../report-generators/pdf-builder.js', () => ({
  PdfReportBuilder: class {
    private readonly call: PdfCall = { summary: [], tables: [] };
    constructor() {
      h.pdfs.push(this.call);
    }
    addTitle() {
      return this;
    }
    addSubtitle() {
      return this;
    }
    addSummaryRow(label: string, value: string) {
      this.call.summary.push([label, value]);
      return this;
    }
    addTable(headers: string[], rows: unknown[][]) {
      this.call.tables.push({ headers, rows });
      return this;
    }
    build() {
      return Promise.resolve(Buffer.from('%PDF'));
    }
  },
}));

vi.mock('../pdf-branding.js', () => ({
  loadPdfBranding: () => Promise.resolve({ logo: Buffer.alloc(0), footer: '' }),
}));

vi.mock('../session-revenue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session-revenue.js')>();
  return {
    ...real,
    queryRevenue: (input: { key: unknown; where: unknown[] }) => {
      h.revenueWhere.push(input.where);
      const totals = input.key === real.revenueItem.siteId ? h.bySite : h.byDay;
      return Promise.resolve(
        new Map([...totals].map(([k, v]) => [k, { ...real.EMPTY_REVENUE, ...v }])),
      );
    },
  };
});

const { generateRevenueReport } = await import('../report-generators/revenue-report.js');
const { reportLocale } = await import('../report-generators/report-locale.js');

function selects(...keys: string[]): (c: DbCall) => boolean {
  return (c) => {
    const fields = opArgs(c, 'select')?.[0] as Record<string, unknown> | undefined;
    return c.kind === 'select' && fields != null && keys.every((k) => k in fields);
  };
}

function csvLines(data: Buffer): string[][] {
  return data
    .toString('utf-8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
}

function seed(): void {
  h.fake.queue(selects('date', 'electricityCostCents'), [
    { date: '2026-11-01', electricityCostCents: 300 },
  ]);
  h.byDay.set('2026-11-02', {
    grossCents: 1190,
    netCents: 1000,
    taxCents: 190,
    sessionCount: 2,
  });
  h.byDay.set(null, { grossCents: 5 });
  h.fake.queue(selects('siteId', 'energyKwh'), [
    { siteId: 'sit_1', siteName: 'Depot', electricityCostCents: 300, energyKwh: 12.34 },
  ]);
  h.bySite.set('sit_1', { grossCents: 1190, netCents: 1000, taxCents: 190, sessionCount: 2 });
  h.bySite.set('sit_2', { grossCents: 2380, netCents: 2000, taxCents: 380, sessionCount: 0 });
  h.bySite.set(null, {
    grossCents: 500,
    netCents: 500,
    sessionCount: 1,
    costMissingCount: 1,
    costMissingNetCents: 500,
    billedOnAccountCents: 700,
  });
  h.fake.queue(selects('id', 'name'), [{ id: 'sit_2', name: 'Harbor' }]);
  h.fake.queue(selects('status', 'totalCents'), [
    { status: 'captured', count: 3, totalCents: 4070 },
  ]);
}

beforeEach(() => {
  h.fake.reset();
  h.pdfs.length = 0;
  h.byDay.clear();
  h.bySite.clear();
  h.revenueWhere.length = 0;
});

describe('generateRevenueReport', () => {
  it('merges costs and revenue by day and by site in the CSV', async () => {
    seed();
    const { data } = await generateRevenueReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-30', siteId: 'sit_1' },
      'csv',
      'en',
      ['sit_1', 'sit_2'],
    );
    const rows = csvLines(data);
    // Days sorted; a day with only a cost and a day with only revenue; null keys dropped.
    // A negative profit keeps the CSV formula guard quote.
    expect(rows[1]!.slice(0, 7)).toEqual([
      '2026-11-01',
      '0.00',
      '0.00',
      '0.00',
      '3.00',
      "'-3.00",
      '0.00',
    ]);
    expect(rows[2]!.slice(0, 7)).toEqual([
      '2026-11-02',
      '11.90',
      '1.90',
      '10.00',
      '0.00',
      '10.00',
      '0.00',
    ]);
    const noSite = reportLocale('en', 'csv').labels.common.noSite;
    const site = (name: string) => rows.find((r) => r[0] === name);
    // Biggest sites first.
    const siteNames = rows
      .filter((r) => ['Depot', 'Harbor', noSite].includes(r[0]!))
      .map((r) => r[0]);
    expect(siteNames).toEqual(['Harbor', 'Depot', noSite]);
    expect(site('Depot')!.slice(1, 7)).toEqual(['11.90', '1.90', '10.00', '3.00', '7.00', '0.00']);
    expect(site('Depot')!.at(-1)).toBe('12.3');
    expect(site('Harbor')!.slice(1, 4)).toEqual(['23.80', '3.80', '20.00']);
    // Revenue without a cost stays out of profit.
    expect(site(noSite)!.slice(5, 9)).toEqual(['0.00', '7.00', '1', '1']);
    expect(rows.find((r) => r[0] === 'captured')).toEqual(['captured', '3', '40.70']);

    // The day costs join the stations for the site filter; every revenue query gets the filters.
    const costs = h.fake.calls.find(selects('date', 'electricityCostCents'));
    expect(costs!.ops.some((o) => o.name === 'innerJoin')).toBe(true);
    const where = (await Promise.all(h.revenueWhere[0]!.map((w) => sqlParams(w)))).flat();
    expect(where).toEqual(expect.arrayContaining(['2026-11-01', '2026-11-30', 'sit_1', 'sit_2']));
    const names = h.fake.calls.find(selects('id', 'name'));
    expect(await sqlParams(opArgs(names, 'where')?.[0])).toEqual(['sites.id', 'sit_2']);
  });

  it('reads no site names when every revenue site has a billed session', async () => {
    h.bySite.set('sit_1', { grossCents: 100 });
    h.fake.queue(selects('siteId', 'energyKwh'), [
      { siteId: 'sit_1', siteName: 'Depot', electricityCostCents: 0, energyKwh: 0 },
    ]);
    await generateRevenueReport({ dateFrom: 'bad' }, 'csv', 'en', null);
    expect(h.fake.calls.find(selects('id', 'name'))).toBeUndefined();
    const costs = h.fake.calls.find(selects('date', 'electricityCostCents'));
    expect(costs!.ops.some((o) => o.name === 'innerJoin')).toBe(false);
    expect(h.revenueWhere[0]).toEqual([]);
  });

  it('writes three XLSX sheets', async () => {
    seed();
    const { data } = await generateRevenueReport({}, 'xlsx', 'en', null);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const l = reportLocale('en', 'xlsx').labels.revenue;
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      l.sheets.byDay,
      l.sheets.bySite,
      l.sheets.payments,
    ]);
    expect(wb.getWorksheet(l.sheets.bySite).rowCount).toBe(4);
  });

  it('totals the sites in the PDF summary', async () => {
    seed();
    await generateRevenueReport({}, 'pdf', 'en', null);
    const pl = reportLocale('en', 'pdf');
    const money = (c: number) => pl.money(c, 'EUR');
    expect(h.pdfs[0]!.summary.map(([, v]) => v)).toEqual([
      money(4070),
      money(570),
      money(3500),
      money(300),
      // 3500 net - 500 without a cost - 300 electricity.
      money(2700),
      pl.number(1),
      money(700),
      pl.number(3),
    ]);
    expect(h.pdfs[0]!.tables.map((t) => t.rows.length)).toEqual([2, 3, 1]);
  });
});
