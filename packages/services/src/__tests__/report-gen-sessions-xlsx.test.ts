// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The sessions report XLSX past its 10000-session limit: the sessions sheet
// keeps 10000 rows, and the failed-sessions and note sheets follow. The XLSX
// builder is a recorder here, so 10000 rows stay fast (report-builders.test.ts
// covers the builder).

import { describe, expect, it, vi } from 'vitest';
import type { DbCall, FakeDb } from './helpers/fake-db.js';
import { opArgs } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  tables: [] as { name: string; headers: string[]; rows: unknown[][] }[],
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const { sql } = await import('drizzle-orm');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getSystemTimezone: () => Promise.resolve('UTC'),
    inOperatorStation: (col: unknown) => sql`in_operator(${col})`,
  });
});

vi.mock('../report-generators/xlsx-builder.js', () => ({
  buildXlsx: (tables: { name: string; headers: string[]; rows: unknown[][] }[]) => {
    h.tables.push(...tables);
    return Promise.resolve(Buffer.from('xlsx'));
  },
}));

const { generateSessionsReport } = await import('../report-generators/sessions-report.js');
const { reportLocale } = await import('../report-generators/report-locale.js');

function selects(key: string): (c: DbCall) => boolean {
  return (c) => {
    const fields = opArgs(c, 'select')?.[0] as Record<string, unknown> | undefined;
    return c.kind === 'select' && fields != null && key in fields;
  };
}

describe('sessions report XLSX truncation', () => {
  it('keeps 10000 sessions and adds the failed and note sheets', async () => {
    h.fake.queue(
      selects('transactionId'),
      Array.from({ length: 10001 }, (_, i) => ({
        sessionId: `ses_${String(i)}`,
        transactionId: `tx${String(i)}`,
        stationName: 'CS-1',
        siteName: '',
        driverFirstName: '',
        driverLastName: '',
        driverEmail: '',
        status: 'completed',
        startedAt: null,
        endedAt: null,
        durationMinutes: 0,
        energyKwh: 0,
        costCents: 0,
        costIsFinal: true,
        tariffTaxRate: null,
        costBreakdown: null,
        refundedCents: 0,
        currency: 'EUR',
        stoppedReason: '',
        paymentSource: '',
      })),
    );
    h.fake.queue(selects('reason'), [{ reason: 'PowerLoss', count: 1 }]);
    const { fileName } = await generateSessionsReport({}, 'xlsx', 'en', null, {
      driverData: true,
      money: true,
    });
    expect(fileName).toMatch(/\.xlsx$/);
    const rl = reportLocale('en', 'xlsx');
    const l = rl.labels.sessions;
    expect(h.tables.map((t) => t.name)).toEqual([
      l.sheets.sessions,
      l.sheets.failedSessions,
      l.sheets.note,
    ]);
    expect(h.tables[0]!.rows).toHaveLength(10000);
    expect(h.tables[1]!.rows).toEqual([['PowerLoss', 1]]);
    expect(h.tables[2]!.headers).toEqual([l.columns.resultTruncated]);
    expect(h.tables[2]!.rows).toEqual([[rl.fill(l.truncated, { limit: rl.number(10000) })]]);
  });

  it('lists the unit, EVSE, connector and connector type next to the station', async () => {
    h.tables.length = 0;
    const row = {
      sessionId: 'ses_1',
      transactionId: 'tx1',
      stationName: 'EM4-MASTER-01',
      unitName: 'Box 3',
      evseId: 5,
      connectorId: 1,
      connectorType: 'CCS2',
      siteName: 'Parkhaus Lindenhof',
      driverFirstName: '',
      driverLastName: '',
      driverEmail: '',
      status: 'completed',
      startedAt: null,
      endedAt: null,
      durationMinutes: 0,
      energyKwh: 0,
      costCents: 0,
      costIsFinal: true,
      tariffTaxRate: null,
      costBreakdown: null,
      refundedCents: 0,
      currency: 'EUR',
      stoppedReason: '',
      paymentSource: '',
    };
    h.fake.queue(selects('transactionId'), [
      row,
      {
        ...row,
        sessionId: 'ses_2',
        unitName: null,
        evseId: null,
        connectorId: null,
        connectorType: null,
      },
    ]);
    h.fake.queue(selects('reason'), []);
    await generateSessionsReport({}, 'xlsx', 'en', null, { driverData: true, money: true });
    const rl = reportLocale('en', 'xlsx');
    const l = rl.labels.sessions;
    const { headers, rows } = h.tables[0]!;
    const at = headers.indexOf(rl.labels.columns.station);
    expect(headers.slice(at, at + 6)).toEqual([
      rl.labels.columns.station,
      l.columns.unit,
      l.columns.evse,
      l.columns.connector,
      l.columns.connectorType,
      rl.labels.columns.site,
    ]);
    expect(rows[0]!.slice(at, at + 6)).toEqual([
      'EM4-MASTER-01',
      'Box 3',
      5,
      1,
      'CCS2',
      'Parkhaus Lindenhof',
    ]);
    // A session without a known charging point leaves the cells empty.
    expect(rows[1]!.slice(at + 1, at + 5)).toEqual(['', '', '', '']);
  });
});
