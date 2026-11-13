// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSV, XLSX and PDF output of the sessions, utilization, sustainability,
// driver activity, energy and station health reports: the rows each one
// derives from its query rows (rounding, totals, joined names, tax splits,
// truncation notes, column access), the optional sheets and tables, and the
// site filter and scope conditions sent to SQL.

import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbCall, FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams, sqlString } from './helpers/fake-db.js';

interface PdfCall {
  language: string;
  title?: string;
  subtitles: string[];
  summary: [string, string][];
  tables: { headers: string[]; rows: unknown[][] }[];
}

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  pdfs: [] as PdfCall[],
  spend: new Map<string, { grossCents: number }>(),
  revenueArgs: [] as unknown[],
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const { sql } = await import('drizzle-orm');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSystemTimezone: () => Promise.resolve('UTC'),
    getCompanyCurrency: () => Promise.resolve('EUR'),
    isOperatorStation: () => sql`is_operator`,
    inOperatorStation: (col: unknown) => sql`in_operator(${col})`,
    operatorStationSql: (alias: string) => `${alias}.is_operator`,
  });
});

vi.mock('../report-generators/pdf-builder.js', () => ({
  PdfReportBuilder: class {
    private readonly call: PdfCall;
    constructor(language: string) {
      this.call = { language, subtitles: [], summary: [], tables: [] };
      h.pdfs.push(this.call);
    }
    addTitle(text: string) {
      this.call.title = text;
      return this;
    }
    addSubtitle(text: string) {
      this.call.subtitles.push(text);
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

vi.mock('../session-revenue.js', () => ({
  revenueItem: { driverId: 'ri.driver_id', occurredAt: 'ri.occurred_at', siteId: 'ri.site_id' },
  queryRevenue: (args: unknown) => {
    h.revenueArgs.push(args);
    return Promise.resolve(h.spend);
  },
}));

const { generateSessionsReport } = await import('../report-generators/sessions-report.js');
const { generateUtilizationReport } = await import('../report-generators/utilization-report.js');
const { generateSustainabilityReport } =
  await import('../report-generators/sustainability-report.js');
const { generateDriverActivityReport } =
  await import('../report-generators/driver-activity-report.js');
const { generateEnergyReport } = await import('../report-generators/energy-report.js');
const { generateStationHealthReport } =
  await import('../report-generators/station-health-report.js');
const { reportLocale } = await import('../report-generators/report-locale.js');

const FULL = { driverData: true, money: true };

function selects(...keys: string[]): (c: DbCall) => boolean {
  return (c) => {
    if (c.kind !== 'select') return false;
    const fields = opArgs(c, 'select')?.[0] as Record<string, unknown> | undefined;
    return fields != null && keys.every((k) => k in fields);
  };
}

/** A minimal CSV reader: quoted cells, doubled quotes, a leading BOM. */
function csv(data: Buffer): string[][] {
  const text = data.toString('utf-8').replace(/^\uFEFF/, '');
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '' && out.length > 0 && text.endsWith(line)) continue;
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

async function xlsxSheets(data: Buffer): Promise<Map<string, unknown[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const out = new Map<string, unknown[][]>();
  for (const sheet of wb.worksheets) {
    const rows: unknown[][] = [];
    sheet.eachRow((row) => {
      rows.push((row.values as unknown[]).slice(1));
    });
    out.set(sheet.name, rows);
  }
  return out;
}

async function whereOf(
  match: (c: DbCall) => boolean,
): Promise<{ text: string; params: unknown[] }> {
  const call = h.fake.calls.find(match);
  const where = opArgs(call, 'where')?.[0];
  return { text: await sqlString(where), params: await sqlParams(where) };
}

beforeEach(() => {
  h.fake.reset();
  h.pdfs.length = 0;
  h.spend.clear();
  h.revenueArgs.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('sessions report', () => {
  const rl = reportLocale('en', 'csv');
  const l = rl.labels.sessions;
  const sessionRow = (over: Record<string, unknown> = {}) => ({
    sessionId: 'ses_1',
    transactionId: 'tx-12345678-abcd',
    stationName: 'CS-1',
    siteName: 'Depot',
    driverFirstName: 'Ana',
    driverLastName: 'Lee',
    driverEmail: 'ana@example.com',
    status: 'completed',
    startedAt: '2026-11-01 10:00:00',
    endedAt: '2026-11-01 11:00:00',
    durationMinutes: 60.04,
    energyKwh: 12.345,
    costCents: 1190,
    costIsFinal: true,
    tariffTaxRate: '0.19',
    costBreakdown: null,
    refundedCents: 100,
    currency: 'EUR',
    stoppedReason: 'EVDisconnected',
    paymentSource: 'card',
    ...over,
  });

  it('writes CSV rows with the tax split, the failed summary and the filters', async () => {
    h.fake.queue(selects('transactionId'), [
      sessionRow(),
      sessionRow({
        driverFirstName: '',
        driverLastName: 'Solo',
        costIsFinal: false,
        tariffTaxRate: null,
        costCents: 500,
      }),
    ]);
    h.fake.queue(selects('reason'), [{ reason: 'PowerLoss', count: 3 }]);
    const { data, fileName } = await generateSessionsReport(
      {
        dateFrom: '2026-11-01',
        dateTo: 'not-a-date',
        siteId: 'sit_1',
        stationId: 'sta_1',
        status: 'completed',
      },
      'csv',
      'en',
      ['sit_1'],
      FULL,
    );
    expect(fileName).toMatch(/^sessions-report-\d+\.csv$/);
    const rows = csv(data);
    const header = rows[0]!;
    const col = (name: string) => header.indexOf(name);
    const first = rows[1]!;
    expect(first[col(rl.labels.columns.driver)]).toBe('Ana Lee');
    expect(first[col(rl.labels.columns.durationMin)]).toBe('60');
    expect(first[col(rl.labels.columns.energyKwh)]).toBe('12.35');
    expect(first[col(l.columns.net)]).toBe('10.00');
    expect(first[col(l.columns.tax)]).toBe('1.90');
    expect(first[col(l.columns.taxRatePercent)]).toBe('19');
    expect(first[col(l.columns.refunded)]).toBe('1.00');
    expect(first[col(l.columns.costFinal)]).toBe(rl.labels.common.yes);
    const second = rows[2]!;
    expect(second[col(rl.labels.columns.driver)]).toBe('Solo');
    expect(second[col(l.columns.costFinal)]).toBe(rl.labels.common.no);
    expect(second[col(l.columns.tax)]).toBe('0.00');
    expect(rows.some((r) => r[0] === l.failedAnalysis)).toBe(true);
    expect(rows.some((r) => r[0] === 'PowerLoss' && r[1] === '3')).toBe(true);

    // A bad dateTo is dropped; the site filter and scope go on both queries.
    const log = await whereOf(selects('transactionId'));
    expect(log.params).toEqual(
      expect.arrayContaining(['2026-11-01', 'sit_1', 'sta_1', 'completed']),
    );
    expect(log.params).not.toContain('not-a-date');
    const failed = h.fake.calls.find(selects('reason'));
    expect(failed!.ops.some((o) => o.name === 'innerJoin')).toBe(true);
    expect((await whereOf(selects('reason'))).params).toContain('sit_1');
  });

  it('queries the failed summary without the station join for an all-site report', async () => {
    await generateSessionsReport({}, 'csv', 'en', null, FULL);
    const failed = h.fake.calls.find(selects('reason'));
    expect(failed!.ops.some((o) => o.name === 'innerJoin')).toBe(false);
    const rows = csv((await generateSessionsReport({}, 'csv', 'en', null, FULL)).data);
    // Headers only: no failed section, no truncation note.
    expect(rows.filter((r) => r.join('') !== '')).toHaveLength(1);
  });

  it('notes the truncation past 10000 sessions in CSV', async () => {
    const many = Array.from({ length: 10001 }, (_, i) =>
      sessionRow({ transactionId: `tx${String(i)}` }),
    );
    h.fake.queue(selects('transactionId'), many);
    const out = csv((await generateSessionsReport({}, 'csv', 'en', null, FULL)).data);
    expect(out.filter((r) => r[0]?.startsWith('tx'))).toHaveLength(10000);
    const note = rl.fill(l.truncated, { limit: rl.number(10000) });
    expect(out.some((r) => r[0] === note)).toBe(true);
  });

  it('writes one XLSX sheet when nothing failed', async () => {
    h.fake.queue(selects('transactionId'), [sessionRow()]);
    const sheets = await xlsxSheets(
      (await generateSessionsReport({}, 'xlsx', 'en', null, FULL)).data,
    );
    expect(sheets.size).toBe(1);
  });

  it('builds the PDF with the short transaction id and leaves hidden columns out', async () => {
    h.fake.queue(selects('transactionId'), [sessionRow()]);
    h.fake.queue(selects('reason'), [{ reason: 'PowerLoss', count: 2 }]);
    const { fileName } = await generateSessionsReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-30' },
      'pdf',
      'en',
      null,
      { driverData: false, money: false },
    );
    expect(fileName).toMatch(/\.pdf$/);
    const pdf = h.pdfs[0]!;
    const pl = reportLocale('en', 'pdf');
    expect(pdf.title).toBe(pl.labels.sessions.title);
    expect(pdf.summary[0]![1]).toBe('1');
    const [log, failed] = pdf.tables;
    expect(log!.headers).not.toContain(pl.labels.columns.driver);
    expect(log!.rows[0]![0]).toBe('tx-12345');
    expect(failed!.headers).toEqual([
      pl.labels.sessions.columns.failedReason,
      pl.labels.columns.count,
    ]);
  });

  it('adds the truncation subtitle to the PDF', async () => {
    h.fake.queue(
      selects('transactionId'),
      Array.from({ length: 10001 }, () => sessionRow()),
    );
    await generateSessionsReport({}, 'pdf', 'en', null, FULL);
    const pdf = h.pdfs[0]!;
    expect(pdf.subtitles).toHaveLength(2);
    expect(pdf.tables).toHaveLength(1);
    expect(pdf.tables[0]!.rows).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------

describe('utilization report', () => {
  const site = { siteName: 'Depot', stationCount: 2, sessionHours: 48.04 };
  const empty = { siteName: 'Empty', stationCount: 0, sessionHours: 0 };
  const station = { stationName: 'CS-1', siteName: 'Depot', sessionHours: 5000, sessionCount: 4 };

  it('computes utilization over the date range and writes the CSV sections', async () => {
    h.fake.queue(selects('value'), [{ value: 'Europe/Berlin' }]);
    h.fake.queue(selects('stationCount'), [site, empty]);
    h.fake.queue(selects('sessionCount', 'stationName'), [station]);
    h.fake.queue(selects('dayOfWeek'), [{ hour: 7, dayOfWeek: 1, count: 9 }]);
    const filters = { dateFrom: '2026-11-01', dateTo: '2026-11-10', siteId: 'sit_1' };
    const { data } = await generateUtilizationReport(filters, 'csv', 'en', ['sit_1']);
    const until = new Date('2026-11-10');
    until.setHours(23, 59, 59, 999);
    const totalHours = (until.getTime() - new Date('2026-11-01').getTime()) / 3600000;
    const rows = csv(data);
    expect(rows[1]).toEqual([
      'Depot',
      '2',
      '48',
      String(Math.round((48.04 / (2 * totalHours)) * 1000) / 10),
    ]);
    expect(rows[2]).toEqual(['Empty', '0', '0', '0']);
    const rl = reportLocale('en', 'csv');
    // The station utilization is capped at 100%.
    expect(rows.find((r) => r[0] === 'CS-1')).toEqual(['CS-1', 'Depot', '5000', '4', '100']);
    expect(rows.find((r) => r[1] === '07:00')).toEqual([rl.weekday(1), '07:00', '9']);
    // The timezone is read for the peak hours, the site filter on every query.
    expect((await whereOf(selects('dayOfWeek'))).params).toEqual(expect.arrayContaining(['sit_1']));
    const peak = h.fake.calls.find(selects('dayOfWeek'));
    const hourSql = (opArgs(peak, 'select')![0] as Record<string, unknown>)['hour'];
    expect(await sqlParams(hourSql)).toContain('Europe/Berlin');
  });

  it('falls back to the New York timezone and a 30-day window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    h.fake.queue(selects('stationCount'), [{ siteName: 'A', stationCount: 1, sessionHours: 72 }]);
    const { data } = await generateUtilizationReport({}, 'csv', 'en', null);
    // 72 hours over 30 days on one station.
    expect(csv(data)[1]).toEqual(['A', '1', '72', '10']);
    const peak = h.fake.calls.find(selects('dayOfWeek'));
    const hourSql = (opArgs(peak, 'select')![0] as Record<string, unknown>)['hour'];
    expect(await sqlParams(hourSql)).toContain('America/New_York');
  });

  it('writes three XLSX sheets', async () => {
    h.fake.queue(selects('stationCount'), [site]);
    const xl = reportLocale('en', 'xlsx').labels.utilization;
    const sheets = await xlsxSheets((await generateUtilizationReport({}, 'xlsx', 'en', null)).data);
    expect([...sheets.keys()]).toEqual([
      xl.sheets.bySite,
      xl.sheets.byStation,
      xl.sheets.peakHours,
    ]);
  });

  it('builds the PDF with the average utilization, or 0 without sites', async () => {
    h.fake.queue(selects('stationCount'), [
      { siteName: 'A', stationCount: 1, sessionHours: 0 },
      { siteName: 'B', stationCount: 0, sessionHours: 0 },
    ]);
    h.fake.queue(selects('sessionCount', 'stationName'), [station, station]);
    await generateUtilizationReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-02' },
      'pdf',
      'en',
      [],
    );
    const pl = reportLocale('en', 'pdf');
    expect(h.pdfs[0]!.summary).toEqual([
      [pl.summary(pl.labels.utilization.summary.averageUtilization), pl.percent(0)],
      [pl.summary(pl.labels.utilization.summary.totalStations), pl.number(2)],
    ]);
    expect(h.pdfs[0]!.tables).toHaveLength(3);
    // An empty scope matches nothing.
    expect((await whereOf(selects('stationCount'))).text).toContain('false');

    await generateUtilizationReport({}, 'pdf', 'en', null);
    expect(h.pdfs[1]!.summary[0]![1]).toBe(pl.percent(0));
  });
});

// ---------------------------------------------------------------------------

describe('sustainability report', () => {
  it('uses the stored factors and writes the CSV metrics, sites and days', async () => {
    h.fake.queue(selects('key', 'value'), [
      { key: 'sustainability.gridEmissionFactor', value: '0.5' },
      { key: 'sustainability.evEfficiency', value: 4 },
      { key: 'sustainability.gasolineEmissionFactor', value: '10' },
      { key: 'sustainability.avgMpg', value: '20' },
    ]);
    h.fake.queue(selects('siteName', 'sessionCount'), [
      { siteName: 'Depot', energyKwh: 100, sessionCount: 5 },
    ]);
    h.fake.queue(selects('date'), [{ date: '2026-11-01', energyKwh: 100 }]);
    const { data } = await generateSustainabilityReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-30', siteId: 'sit_1' },
      'csv',
      'en',
      ['sit_1'],
    );
    const l = reportLocale('en', 'csv').labels.sustainability;
    const rows = csv(data);
    const metric = (name: string) => rows.find((r) => r[0] === name)?.[1];
    // 100 kWh * 4 mi/kWh / 20 mpg * 10 kg/gal = 200 kg, minus 100 * 0.5 grid.
    expect(metric(l.metrics.totalEnergyDelivered)).toBe('100.00');
    expect(metric(l.metrics.gasolineCo2Avoided)).toBe('200.00');
    expect(metric(l.metrics.gridCo2)).toBe('50.00');
    expect(metric(l.metrics.netGhgReduction)).toBe('150.00');
    expect(metric(l.metrics.evMilesEnabled)).toBe('400.00');
    expect(metric(l.metrics.gasolineGallonsDisplaced)).toBe('20.00');
    expect(metric(l.metrics.gridEmissionFactor)).toBe('0.5');
    expect(rows.find((r) => r[0] === 'Depot')).toEqual(['Depot', '100.00', '5', '150.00']);
    expect(rows.find((r) => r[0] === '2026-11-01')).toEqual(['2026-11-01', '100.00', '150.00']);
    const day = h.fake.calls.find(selects('date'));
    expect(day!.ops.some((o) => o.name === 'innerJoin')).toBe(true);
    expect((await whereOf(selects('date'))).params).toEqual(
      expect.arrayContaining(['2026-11-01', '2026-11-30', 'sit_1']),
    );
  });

  it('falls back to the default factors and drops malformed dates', async () => {
    h.fake.queue(selects('key', 'value'), [{ key: 'sustainability.avgMpg', value: 'abc' }]);
    h.fake.queue(selects('siteName', 'sessionCount'), [
      { siteName: 'A', energyKwh: 10, sessionCount: 1 },
    ]);
    const { data } = await generateSustainabilityReport(
      { dateFrom: '11/01/2026', dateTo: 5 },
      'csv',
      'en',
      null,
    );
    const l = reportLocale('en', 'csv').labels.sustainability;
    const rows = csv(data);
    expect(rows.find((r) => r[0] === l.metrics.averageVehicleMpg)?.[1]).toBe('25.4');
    expect(rows.find((r) => r[0] === l.metrics.gridEmissionFactor)?.[1]).toBe('0.386');
    const day = h.fake.calls.find(selects('date'));
    expect(day!.ops.some((o) => o.name === 'innerJoin')).toBe(false);
    expect((await whereOf(selects('date'))).params).not.toContain('11/01/2026');
  });

  it('writes four XLSX sheets and the PDF summary', async () => {
    const xl = reportLocale('en', 'xlsx').labels.sustainability;
    const sheets = await xlsxSheets(
      (await generateSustainabilityReport({}, 'xlsx', 'en', null)).data,
    );
    expect([...sheets.keys()]).toEqual([
      xl.sheets.summary,
      xl.sheets.configuration,
      xl.sheets.bySite,
      xl.sheets.dailyEnergy,
    ]);

    h.fake.queue(selects('siteName', 'sessionCount'), [
      { siteName: 'A', energyKwh: 10, sessionCount: 1 },
    ]);
    h.fake.queue(selects('date'), [{ date: '2026-11-01', energyKwh: 10 }]);
    await generateSustainabilityReport({}, 'pdf', 'en', null);
    const pdf = h.pdfs[0]!;
    expect(pdf.summary).toHaveLength(4);
    expect(pdf.tables.map((t) => t.rows.length)).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------

describe('driver activity report', () => {
  const driverRow = {
    driverId: 'drv_1',
    driverFirstName: 'Ana',
    driverLastName: '',
    driverEmail: 'ana@example.com',
    sessionCount: 3,
    totalKwh: 12.345,
    avgDurationMinutes: 33.33,
    firstSession: '2026-11-01',
    lastSession: '2026-11-05',
  };

  it('writes each driver with the spend from the revenue rows', async () => {
    h.fake.queue(selects('driverId'), [driverRow, { ...driverRow, driverId: 'drv_2' }]);
    h.spend.set('drv_1', { grossCents: 4250 });
    const { data } = await generateDriverActivityReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-30' },
      'csv',
      'en',
      ['sit_1'],
      FULL,
    );
    const rows = csv(data);
    expect(rows[1]).toEqual([
      'Ana',
      'ana@example.com',
      '3',
      '12.35',
      '42.50',
      '33.3',
      '2026-11-01',
      '2026-11-05',
    ]);
    // A driver without revenue rows spent nothing.
    expect(rows[2]![4]).toBe('0.00');
    const args = h.revenueArgs[0] as { companyCurrency: string; where: unknown[] };
    expect(args.companyCurrency).toBe('EUR');
    expect(args.where).toHaveLength(4);
    const params = (await Promise.all(args.where.map((w) => sqlParams(w)))).flat();
    expect(params).toEqual(expect.arrayContaining(['drv_1', 'drv_2', 'sit_1']));
  });

  it('asks the revenue for no driver when there are none', async () => {
    const { data } = await generateDriverActivityReport({}, 'xlsx', 'en', null, FULL);
    const args = h.revenueArgs[0] as { where: unknown[] };
    expect(args.where).toHaveLength(1);
    expect(await sqlString(args.where[0])).toContain('NULL');
    const xl = reportLocale('en', 'xlsx').labels.driverActivity;
    expect([...(await xlsxSheets(data)).keys()]).toEqual([xl.sheets.driverActivity]);
  });

  it('builds the PDF totals and hides the spend without payments:read', async () => {
    h.fake.queue(selects('driverId'), [
      driverRow,
      { ...driverRow, driverId: 'drv_2', totalKwh: 1 },
    ]);
    await generateDriverActivityReport({}, 'pdf', 'en', null, { driverData: true, money: false });
    const pl = reportLocale('en', 'pdf');
    const pdf = h.pdfs[0]!;
    expect(pdf.summary.map(([, v]) => v)).toEqual([
      pl.number(2),
      pl.number(6),
      pl.fill(pl.labels.common.kwh, { value: pl.number(13.35, 2) }),
    ]);
    expect(pdf.tables[0]!.headers).toHaveLength(5);
    expect(pdf.tables[0]!.rows[0]![0]).toBe('Ana');
  });
});

// ---------------------------------------------------------------------------

describe('energy report', () => {
  it('writes the day, station and site sections with two-decimal kWh', async () => {
    h.fake.queue(selects('date'), [{ date: '2026-11-01', energyKwh: '10.456', sessionCount: 2 }]);
    h.fake.queue(selects('stationName'), [
      { stationName: 'CS-1', siteName: 'Depot', energyKwh: 10.456, sessionCount: 2 },
    ]);
    h.fake.queue(selects('avgKwhPerSession'), [
      { siteName: 'Depot', energyKwh: '10.456', sessionCount: 2, avgKwhPerSession: '5.228' },
    ]);
    const { data } = await generateEnergyReport(
      { dateFrom: '2026-11-01', dateTo: '2026-11-30', siteId: 'sit_1' },
      'csv',
      'en',
      ['sit_1'],
    );
    const rows = csv(data);
    expect(rows[1]).toEqual(['2026-11-01', '10.46', '2']);
    expect(rows.find((r) => r[0] === 'CS-1')).toEqual(['CS-1', 'Depot', '10.46', '2']);
    expect(rows.find((r) => r[0] === 'Depot')).toEqual(['Depot', '10.46', '2', '5.23']);
    const day = h.fake.calls.find(selects('date'));
    expect(day!.ops.some((o) => o.name === 'innerJoin')).toBe(true);
    expect((await whereOf(selects('date'))).params).toContain('sit_1');
  });

  it('reads the days without the station join for an all-site report', async () => {
    await generateEnergyReport({}, 'xlsx', 'en', null);
    const day = h.fake.calls.find(selects('date'));
    expect(day!.ops.some((o) => o.name === 'innerJoin')).toBe(false);
  });

  it('totals the sites in the PDF summary', async () => {
    h.fake.queue(selects('avgKwhPerSession'), [
      { siteName: 'A', energyKwh: '10.5', sessionCount: '2', avgKwhPerSession: '5.25' },
      { siteName: 'B', energyKwh: 4.5, sessionCount: 1, avgKwhPerSession: 4.5 },
    ]);
    await generateEnergyReport({}, 'pdf', 'en', null);
    const pl = reportLocale('en', 'pdf');
    expect(h.pdfs[0]!.summary).toEqual([
      [
        pl.summary(pl.labels.energy.summary.totalEnergy),
        pl.fill(pl.labels.common.kwh, { value: pl.number(15, 2) }),
      ],
      [pl.summary(pl.labels.energy.summary.totalSessions), pl.number(3)],
    ]);
    expect(h.pdfs[0]!.tables).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe('station health report', () => {
  const uptime = [
    {
      station_name: 'CS-1',
      site_name: 'Depot',
      port_count: '2',
      uptime_pct: '97.456',
      total_down_minutes: '120.4',
    },
    {
      station_name: 'CS-2',
      site_name: '',
      port_count: '1',
      uptime_pct: '100',
      total_down_minutes: '0',
    },
  ];
  const incidents = [
    {
      station_name: 'CS-1',
      evse_id: 1,
      status: 'faulted',
      started_at: '2026-11-02 08:00:00',
      duration_minutes: '45.6',
    },
  ];

  it('writes the CSV sections with rounded values and the site condition', async () => {
    h.fake.queue(selects('value'), [{ value: 'Europe/Berlin' }]);
    h.fake.queue('execute:uptime_pct', uptime);
    h.fake.queue('execute:fault_count', [{ station_name: 'CS-1', fault_count: '4' }]);
    h.fake.queue('execute:LIMIT 500', incidents);
    const { data } = await generateStationHealthReport(
      { dateFrom: '2026-11-01', siteId: 'sit_1' },
      'csv',
      'en',
      ['sit_1'],
    );
    const rows = csv(data);
    expect(rows[1]).toEqual(['CS-1', 'Depot', '2', '97.46', '120']);
    expect(rows[2]).toEqual(['CS-2', '', '1', '100', '0']);
    expect(rows.find((r) => r[0] === 'CS-1' && r.length === 2)).toEqual(['CS-1', '4']);
    expect(rows.find((r) => r[2] === 'faulted')).toEqual([
      'CS-1',
      '1',
      'faulted',
      '2026-11-02 08:00:00',
      '46',
    ]);
    const call = h.fake.find('execute', 'fault_count')[0];
    const q = opArgs(call, 'execute')?.[0];
    expect(await sqlString(q)).toContain('cs.site_id =');
    expect(await sqlParams(q)).toEqual(
      expect.arrayContaining(['2026-11-01T00:00:00.000Z', 'sit_1']),
    );
    const inc = h.fake.find('execute', 'LIMIT 500')[0];
    expect(await sqlParams(opArgs(inc, 'execute')?.[0])).toContain('Europe/Berlin');
  });

  it('defaults to the last 30 days and the New York timezone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    await generateStationHealthReport({}, 'csv', 'en', null);
    const inc = h.fake.find('execute', 'LIMIT 500')[0];
    const params = await sqlParams(opArgs(inc, 'execute')?.[0]);
    expect(params).toEqual(
      expect.arrayContaining(['America/New_York', '2026-10-13T00:00:00.000Z']),
    );
  });

  it('writes the fault sheet only when there are faults', async () => {
    const xl = reportLocale('en', 'xlsx').labels.stationHealth;
    let sheets = await xlsxSheets((await generateStationHealthReport({}, 'xlsx', 'en', null)).data);
    expect([...sheets.keys()]).toEqual([xl.sheets.uptime, xl.sheets.downtimeIncidents]);
    h.fake.queue('execute:fault_count', [{ station_name: 'CS-1', fault_count: '1' }]);
    sheets = await xlsxSheets((await generateStationHealthReport({}, 'xlsx', 'en', null)).data);
    expect([...sheets.keys()]).toEqual([
      xl.sheets.uptime,
      xl.sheets.faultFrequency,
      xl.sheets.downtimeIncidents,
    ]);
  });

  it('builds the PDF with the average uptime, 100 without stations', async () => {
    const pl = reportLocale('en', 'pdf');
    await generateStationHealthReport({}, 'pdf', 'en', null);
    expect(h.pdfs[0]!.summary[0]![1]).toBe(pl.percent(100));
    expect(h.pdfs[0]!.tables).toHaveLength(2);

    h.fake.queue('execute:uptime_pct', uptime);
    h.fake.queue('execute:fault_count', [{ station_name: 'CS-1', fault_count: '1' }]);
    await generateStationHealthReport({}, 'pdf', 'en', []);
    expect(h.pdfs[1]!.summary).toEqual([
      [pl.summary(pl.labels.stationHealth.summary.averageUptime), pl.percent(98.73)],
      [pl.summary(pl.labels.stationHealth.summary.stationsReported), pl.number(2)],
    ]);
    expect(h.pdfs[1]!.tables).toHaveLength(3);
  });
});
