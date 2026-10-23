// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A report leaves out the columns its reader cannot see:
// driver identity without drivers:read, money without payments:read. The
// reader is the requesting user, or the schedule owner for a scheduled run.

import { describe, it, expect, vi } from 'vitest';

/** Every query builder, table and column: chainable and awaitable to no rows. */
function anything(): unknown {
  const target = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve([]);
      if (typeof prop === 'symbol') return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('@evtivity/database', () => {
  return new Proxy(
    { client: vi.fn(() => Promise.resolve([])) },
    {
      get: (target, prop) => {
        if (prop === 'client') return target.client;
        if (prop === 'getSystemTimezone') return () => Promise.resolve('UTC');
        if (prop === 'getCompanyCurrency') return () => Promise.resolve('EUR');
        if (prop === 'operatorStationSql' || prop === 'operatorStationIdSql') {
          return (name: string) => `operator(${name})`;
        }
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return anything();
      },
      has: () => true,
    },
  );
});

import { generateSessionsReport } from '../report-generators/sessions-report.js';
import { generateDriverActivityReport } from '../report-generators/driver-activity-report.js';
import { reportLocale } from '../report-generators/report-locale.js';
import { reportRequiredPermissions } from '../report.service.js';

const FULL = { driverData: true, money: true };

async function headerLine(
  generate: typeof generateSessionsReport,
  access: { driverData: boolean; money: boolean },
): Promise<string[]> {
  const { data } = await generate({}, 'csv', 'en', null, access);
  const first =
    data
      .toString('utf-8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)[0] ?? '';
  return first.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
}

describe('report columns follow the reader', () => {
  const { columns } = reportLocale('en', 'csv').labels;
  const s = reportLocale('en', 'csv').labels.sessions.columns;

  it('gives a full-permission reader every sessions column', async () => {
    const headers = await headerLine(generateSessionsReport, FULL);
    expect(headers).toContain(columns.driver);
    expect(headers).toContain(columns.email);
    expect(headers).toContain(s.refunded);
    expect(headers).toContain(s.paymentSource);
  });

  it('leaves the driver columns out of the sessions report without drivers:read', async () => {
    const headers = await headerLine(generateSessionsReport, { driverData: false, money: true });
    expect(headers).not.toContain(columns.driver);
    expect(headers).not.toContain(columns.email);
    expect(headers).toContain(s.refunded);
  });

  it('leaves the money columns out of the sessions report without payments:read', async () => {
    const headers = await headerLine(generateSessionsReport, { driverData: true, money: false });
    expect(headers).toContain(columns.driver);
    for (const money of [
      s.net,
      s.tax,
      s.taxRatePercent,
      s.refunded,
      s.paymentSource,
      s.costFinal,
    ]) {
      expect(headers).not.toContain(money);
    }
    expect(headers.some((h) => h.startsWith(s.cost))).toBe(false);
  });

  it('leaves the spend out of the driver activity report without payments:read', async () => {
    const l = reportLocale('en', 'csv').labels.driverActivity.columns;
    const full = await headerLine(generateDriverActivityReport, FULL);
    expect(full.some((h) => h.startsWith(l.totalSpend))).toBe(true);
    const noMoney = await headerLine(generateDriverActivityReport, {
      driverData: true,
      money: false,
    });
    expect(noMoney.some((h) => h.startsWith(l.totalSpend))).toBe(false);
    expect(noMoney).toContain(columns.driver);
  });

  it('registers NEVI (payment method, cost tabs in a fixed template) behind payments:read', () => {
    expect(reportRequiredPermissions('nevi')).toEqual(['payments:read']);
  });
});
