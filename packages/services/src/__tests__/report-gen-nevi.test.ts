// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The NEVI EV-ChART workbook (`nevi-report.ts`): filter validation, the nine
// tabs and the values each tab derives from its rows (one row per station on
// the location tab, kWh and peak kW, error codes only for failed sessions,
// uptime with excluded downtime capped at the outage, outage durations,
// program lists) and the operator-local quarter bounds sent to SQL.

import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbCall, FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlString } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({ fake: undefined as unknown as FakeDb }));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const { sql } = await import('drizzle-orm');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSystemTimezone: () => Promise.resolve('America/New_York'),
    isOperatorStation: () => sql`is_operator`,
    operatorStationSql: (alias: string) => `${alias}.is_operator`,
  });
});

const { generateNeviReport, neviFiltersError, NEVI_FILTERS_ERROR } =
  await import('../report-generators/nevi-report.js');

/** A select whose field list has `key`. */
function selects(key: string): (c: DbCall) => boolean {
  return (c) => {
    if (c.kind !== 'select') return false;
    const fields = opArgs(c, 'select')?.[0] as Record<string, unknown> | undefined;
    return fields != null && key in fields;
  };
}

async function sheetRows(data: Buffer, name: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet(name);
  const out: unknown[][] = [];
  sheet.eachRow((row) => {
    out.push((row.values as unknown[]).slice(1));
  });
  return out;
}

beforeEach(() => {
  h.fake.reset();
});

describe('neviFiltersError', () => {
  it('accepts quarters 1 to 4 and years 2000 to 9999 only', () => {
    expect(neviFiltersError({ quarter: 2, year: 2026 })).toBeNull();
    expect(neviFiltersError({ quarter: '4', year: '2000' })).toBeNull();
    for (const bad of [
      { quarter: 0, year: 2026 },
      { quarter: 5, year: 2026 },
      { quarter: 1.5, year: 2026 },
      { quarter: 1, year: 1999 },
      { quarter: 1, year: 10000 },
      { year: 2026 },
      {},
    ]) {
      expect(neviFiltersError(bad)).toBe(NEVI_FILTERS_ERROR);
    }
  });

  it('refuses to generate with bad filters and reads nothing', async () => {
    await expect(
      generateNeviReport({ quarter: 7, year: 2026 }, 'xlsx', 'en', null),
    ).rejects.toThrow(NEVI_FILTERS_ERROR);
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('generateNeviReport', () => {
  it('writes the nine EV-ChART tabs with their values', async () => {
    h.fake.queue(selects('connectorType'), [
      {
        stationId: 'CS-1',
        address: '1 Main St',
        city: 'Albany',
        state: 'NY',
        postalCode: '12207',
        latitude: '42.65',
        longitude: '-73.75',
        connectorType: 'CCS1',
        maxPowerKw: 150,
      },
      {
        stationId: 'CS-1',
        address: '1 Main St',
        city: 'Albany',
        state: 'NY',
        postalCode: '12207',
        latitude: '42.65',
        longitude: '-73.75',
        connectorType: 'CHAdeMO',
        maxPowerKw: 50,
      },
      {
        stationId: 'CS-2',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        connectorType: null,
        maxPowerKw: null,
      },
    ]);
    h.fake.queue(selects('peakPowerW'), [
      {
        stationOcppId: 'CS-1',
        evseOcppId: 1,
        sessionStart: new Date('2026-04-02T10:00:00Z'),
        sessionEnd: new Date('2026-04-02T11:00:00Z'),
        energyWh: '12345',
        sessionId: 'ses_1',
        status: 'completed',
        stoppedReason: 'EVDisconnected',
        paymentSource: 'card',
        peakPowerW: '50500',
      },
      {
        stationOcppId: 'CS-1',
        evseOcppId: null,
        sessionStart: null,
        sessionEnd: null,
        energyWh: null,
        sessionId: 'ses_2',
        status: 'faulted',
        stoppedReason: null,
        paymentSource: null,
        peakPowerW: null,
      },
      {
        stationOcppId: 'CS-2',
        evseOcppId: 2,
        sessionStart: new Date('2026-05-01T00:00:00Z'),
        sessionEnd: null,
        energyWh: '1000',
        sessionId: 'ses_3',
        status: 'invalid',
        stoppedReason: 'PowerLoss',
        paymentSource: 'guest',
        peakPowerW: '7000',
      },
    ]);
    h.fake.queue('execute:minutes_in_month', [
      {
        station_id: 'CS-1',
        evse_id: 1,
        month_number: 4,
        outage_minutes: '120',
        excluded_minutes: '500',
        minutes_in_month: '43200',
      },
      {
        station_id: 'CS-2',
        evse_id: 1,
        month_number: 4,
        outage_minutes: '432',
        excluded_minutes: '0',
        minutes_in_month: '43200',
      },
      {
        station_id: 'CS-3',
        evse_id: 1,
        month_number: 4,
        outage_minutes: '0',
        excluded_minutes: '0',
        minutes_in_month: '0',
      },
    ]);
    h.fake.queue('execute:duration_minutes', [
      {
        station_id: 'CS-1',
        evse_id: 1,
        start_time: '2026-04-03T00:00:00Z',
        end_time: '2026-04-03T01:00:00Z',
        duration_minutes: '60.456',
        new_status: 'faulted',
      },
      {
        station_id: 'CS-2',
        evse_id: 1,
        start_time: '2026-06-30T23:00:00Z',
        end_time: null,
        duration_minutes: null,
        new_status: 'unavailable',
      },
    ]);
    h.fake.queue(selects('maintenanceCostAnnual'), [
      { stationOcppId: 'CS-1', maintenanceCostAnnual: '1500.50', maintenanceCostYear: 2026 },
      { stationOcppId: 'CS-2', maintenanceCostAnnual: null, maintenanceCostYear: null },
    ]);
    h.fake.queue(selects('operatorName'), [
      {
        stationOcppId: 'CS-1',
        operatorName: 'Op',
        operatorAddress: 'Addr',
        operatorPhone: '555',
        operatorEmail: 'op@example.com',
      },
      {
        stationOcppId: 'CS-2',
        operatorName: null,
        operatorAddress: null,
        operatorPhone: null,
        operatorEmail: null,
      },
    ]);
    h.fake.queue(selects('programParticipation'), [
      { stationOcppId: 'CS-1', programParticipation: ['NEVI', 'CFI'] },
      { stationOcppId: 'CS-2', programParticipation: 'not a list' },
    ]);
    h.fake.queue(selects('derType'), [
      { stationOcppId: 'CS-1', derType: 'solar', derCapacityKw: '25', derCapacityKwh: '100' },
      { stationOcppId: 'CS-2', derType: null, derCapacityKw: null, derCapacityKwh: null },
    ]);
    h.fake.queue(selects('installationCost'), [
      { stationOcppId: 'CS-1', installationCost: '90000', gridConnectionCost: '12000' },
      { stationOcppId: 'CS-2', installationCost: null, gridConnectionCost: null },
    ]);

    const { data, fileName } = await generateNeviReport(
      { quarter: '2', year: '2026' },
      'csv',
      'de',
      ['sit_1'],
    );
    expect(fileName).toBe('NEVI_EV-ChART_Q2_2026.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Station Location',
      'Sessions',
      'Uptime',
      'Outage',
      'Maintenance Cost',
      'Station Operator Identity',
      'Station Operator Programs',
      'DER Info',
      'Capital-Installation Costs',
    ]);

    const location = await sheetRows(data, 'Station Location');
    expect(location[0]![0]).toBe('Station Name');
    expect(location.slice(1)).toEqual([
      ['CS-1', '1 Main St', 'Albany', 'NY', '12207', '42.65', '-73.75', 'CCS1, CHAdeMO', 150],
      ['CS-2', '', '', '', '', '', '', '', 0],
    ]);

    const sessions = await sheetRows(data, 'Sessions');
    expect(sessions.slice(1)).toEqual([
      ['CS-1', 1, '2026-04-02T10:00:00.000Z', '2026-04-02T11:00:00.000Z', 12.345, 50.5, 'card', ''],
      ['CS-1', '', '', '', '', '', '', ''],
      ['CS-2', 2, '2026-05-01T00:00:00.000Z', '', 1, 7, 'guest', 'PowerLoss'],
    ]);

    const uptime = await sheetRows(data, 'Uptime');
    expect(uptime.slice(1)).toEqual([
      // The excluded minutes never exceed the outage.
      ['CS-1', 1, '2026-04', 100, 120, 120],
      ['CS-2', 1, '2026-04', 99, 432, 0],
      ['CS-3', 1, '2026-04', 100, 0, 0],
    ]);

    const outage = await sheetRows(data, 'Outage');
    expect(outage.slice(1)).toEqual([
      ['CS-1', 1, '2026-04-03T00:00:00Z', '2026-04-03T01:00:00Z', 60.46, 'faulted'],
      ['CS-2', 1, '2026-06-30T23:00:00Z', '', '', 'unavailable'],
    ]);

    expect((await sheetRows(data, 'Maintenance Cost')).slice(1)).toEqual([
      ['CS-1', 1500.5, 2026],
      ['CS-2', '', ''],
    ]);
    expect((await sheetRows(data, 'Station Operator Identity')).slice(1)).toEqual([
      ['CS-1', 'Op', 'Addr', '555', 'op@example.com'],
      ['CS-2', '', '', '', ''],
    ]);
    expect((await sheetRows(data, 'Station Operator Programs')).slice(1)).toEqual([
      ['CS-1', 'NEVI, CFI'],
      ['CS-2', ''],
    ]);
    expect((await sheetRows(data, 'DER Info')).slice(1)).toEqual([
      ['CS-1', 'solar', 25, 100],
      ['CS-2', '', '', ''],
    ]);
    expect((await sheetRows(data, 'Capital-Installation Costs')).slice(1)).toEqual([
      ['CS-1', 90000, 12000],
      ['CS-2', '', ''],
    ]);
  });

  it('runs one uptime query per month with the local month bounds', async () => {
    await generateNeviReport({ quarter: 1, year: 2024 }, 'xlsx', 'en', null);
    const uptime = h.fake.find('execute', 'minutes_in_month');
    expect(uptime).toHaveLength(3);
    const outage = h.fake.find('execute', 'duration_minutes');
    expect(outage).toHaveLength(1);
    // The scope condition is the operator station check alone for an all-site scope.
    const text = await sqlString(opArgs(outage[0], 'execute')?.[0]);
    expect(text).toContain('AND cs.is_operator');
    expect(text).not.toContain('ANY(');
    expect(h.fake.find('select')).toHaveLength(7);
  });

  it('gives a quarter 4 workbook its file name', async () => {
    const { fileName, data } = await generateNeviReport(
      { quarter: 4, year: 2025 },
      'xlsx',
      'en',
      [],
    );
    expect(fileName).toBe('NEVI_EV-ChART_Q4_2025.xlsx');
    // Header rows only.
    expect(await sheetRows(data, 'Sessions')).toHaveLength(1);
    // An empty scope matches nothing.
    const outage = h.fake.find('execute', 'duration_minutes');
    expect(await sqlString(opArgs(outage[0], 'execute')?.[0])).toContain('false');
  });
});
