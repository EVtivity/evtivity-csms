// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

const { mockExecute, mockGetSystemTimezone } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSystemTimezone: vi.fn().mockResolvedValue('America/New_York'),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: mockExecute,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  reports: {},
  reportSchedules: {},
  users: {},
  cronjobs: {},
  getSystemTimezone: mockGetSystemTimezone,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  lte: vi.fn(),
  ne: vi.fn(),
  gte: vi.fn(),
}));

const { generatorMocks, mockLogError } = vi.hoisted(() => ({
  generatorMocks: {
    nevi: vi.fn(),
    revenue: vi.fn(),
    energy: vi.fn(),
    sessions: vi.fn(),
    utilization: vi.fn(),
    stationHealth: vi.fn(),
    sustainability: vi.fn(),
    driverActivity: vi.fn(),
  },
  mockLogError: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: mockLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../report-generators/nevi-report.js', () => ({
  generateNeviReport: generatorMocks.nevi,
}));
vi.mock('../report-generators/revenue-report.js', () => ({
  generateRevenueReport: generatorMocks.revenue,
}));
vi.mock('../report-generators/energy-report.js', () => ({
  generateEnergyReport: generatorMocks.energy,
}));
vi.mock('../report-generators/sessions-report.js', () => ({
  generateSessionsReport: generatorMocks.sessions,
}));
vi.mock('../report-generators/utilization-report.js', () => ({
  generateUtilizationReport: generatorMocks.utilization,
}));
vi.mock('../report-generators/station-health-report.js', () => ({
  generateStationHealthReport: generatorMocks.stationHealth,
}));
vi.mock('../report-generators/sustainability-report.js', () => ({
  generateSustainabilityReport: generatorMocks.sustainability,
}));
vi.mock('../report-generators/driver-activity-report.js', () => ({
  generateDriverActivityReport: generatorMocks.driverActivity,
}));

import {
  queueReport,
  generateReport,
  computeNextRunAtInTz,
  operatorReportLanguage,
  renderReport,
  REPORT_TYPES,
} from '../report.service.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
  mockGetSystemTimezone.mockResolvedValue('America/New_York');
});

describe('queueReport', () => {
  it('inserts into reports table and returns an ID', async () => {
    setupDbResults([{ id: 'report-123' }]);

    const result = await queueReport({
      name: 'Monthly Usage',
      reportType: 'usage',
      format: 'csv',
      filters: { month: 1 },
      userId: 'user-1',
    });

    expect(result).toBe('report-123');
  });

  it('returns empty string when insert returns no row', async () => {
    setupDbResults([]);

    const result = await queueReport({
      name: 'Missing Report',
      reportType: 'usage',
      format: 'csv',
      filters: {},
      userId: 'user-1',
    });

    expect(result).toBe('');
  });

  it('schedules background generation via setImmediate after a successful insert', async () => {
    vi.useFakeTimers();
    try {
      // queueReport insert returns the new id, then the deferred generateReport
      // runs its own UPDATE -> SELECT(report not found) -> early return.
      setupDbResults([{ id: 'report-bg' }], [], []);

      const result = await queueReport({
        name: 'Background',
        reportType: 'usage',
        format: 'csv',
        filters: {},
        userId: 'user-1',
      });

      expect(result).toBe('report-bg');
      // Flush the queued setImmediate callback.
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('computeNextRunAtInTz', () => {
  it('returns the Postgres-computed timestamp as a Date', async () => {
    const computed = new Date('2026-06-05T10:00:00.000Z');
    mockExecute.mockResolvedValue([{ next_run_at: computed }]);

    const result = await computeNextRunAtInTz('daily', null, null);

    expect(result).toEqual(computed);
    expect(mockGetSystemTimezone).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('coerces a string timestamp from db.execute into a Date', async () => {
    mockExecute.mockResolvedValue([{ next_run_at: '2026-06-05T10:00:00.000Z' }]);

    const result = await computeNextRunAtInTz('weekly', 3, null);

    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2026-06-05T10:00:00.000Z');
  });

  it('passes default day-of-week and day-of-month when null', async () => {
    mockExecute.mockResolvedValue([{ next_run_at: '2026-07-01T10:00:00.000Z' }]);

    const result = await computeNextRunAtInTz('monthly', null, null);

    expect(result).toBeInstanceOf(Date);
  });

  it('throws when db.execute returns no row', async () => {
    mockExecute.mockResolvedValue([]);

    await expect(computeNextRunAtInTz('daily', null, null)).rejects.toThrow(
      'Failed to compute next_run_at',
    );
  });
});

describe('generateReport', () => {
  it('sets status to generating then dispatches to the generator of the report type', async () => {
    generatorMocks.revenue.mockResolvedValue({
      data: Buffer.from('report-data'),
      fileName: 'report.csv',
    });

    const report = {
      reportType: 'revenue',
      format: 'csv',
      filters: { month: 1 },
    };
    setupDbResults([], [report], []);

    await generateReport('report-123');

    expect(generatorMocks.revenue).toHaveBeenCalledWith({ month: 1 }, 'csv', 'en');
  });

  it("generates the file in the requesting operator's language", async () => {
    generatorMocks.sessions.mockResolvedValue({ data: Buffer.from('x'), fileName: 's.pdf' });
    setupDbResults(
      [],
      [{ reportType: 'sessions', format: 'pdf', filters: {}, generatedById: 'usr_1' }],
      [{ language: 'ko' }],
      [],
    );

    await generateReport('report-ko');

    expect(generatorMocks.sessions).toHaveBeenCalledWith({}, 'pdf', 'ko');
  });

  it('falls back to English for a user language that is not a UI language', async () => {
    generatorMocks.sessions.mockResolvedValue({ data: Buffer.from('x'), fileName: 's.csv' });
    setupDbResults(
      [],
      [{ reportType: 'sessions', format: 'csv', filters: {}, generatedById: 'usr_1' }],
      [{ language: 'fr' }],
      [],
    );

    await generateReport('report-fr');

    expect(generatorMocks.sessions).toHaveBeenCalledWith({}, 'csv', 'en');
  });

  it('has a generator for every report type without startup registration', async () => {
    // The worker queues scheduled reports and generates them in-process, so no
    // report type may depend on a process registering its generator first.
    for (const reportType of REPORT_TYPES) {
      generatorMocks[reportType].mockResolvedValue({
        data: Buffer.from('x'),
        fileName: `${reportType}.csv`,
      });
      setupDbResults([], [{ reportType, format: 'csv', filters: {} }], []);

      await generateReport(`report-${reportType}`);

      expect(generatorMocks[reportType]).toHaveBeenCalledWith({}, 'csv', 'en');
    }
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('sets status to failed when no generator exists for the report type', async () => {
    const report = {
      reportType: 'unknown-type',
      format: 'csv',
      filters: {},
    };
    setupDbResults([], [report], []);

    await generateReport('report-456');

    for (const generator of Object.values(generatorMocks)) {
      expect(generator).not.toHaveBeenCalled();
    }
  });

  it('logs and sets status to failed when the generator throws', async () => {
    generatorMocks.energy.mockRejectedValue(new Error('boom'));

    const report = { reportType: 'energy', format: 'pdf', filters: {} };
    setupDbResults([], [report], []);

    await generateReport('report-logged');

    expect(generatorMocks.energy).toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'report-logged' }),
      'Report generation failed',
    );
  });

  it('handles a non-Error thrown value with the Unknown error fallback', async () => {
    generatorMocks.sessions.mockRejectedValue('a string failure');

    const report = { reportType: 'sessions', format: 'pdf', filters: {} };
    setupDbResults([], [report], []);

    await generateReport('report-string-fail');

    expect(generatorMocks.sessions).toHaveBeenCalled();
  });

  it('returns early when report not found', async () => {
    setupDbResults([], []);

    await generateReport('nonexistent');

    for (const generator of Object.values(generatorMocks)) {
      expect(generator).not.toHaveBeenCalled();
    }
  });
});

describe('renderReport', () => {
  it('builds the file in the given language without storing it', async () => {
    generatorMocks.energy.mockResolvedValue({ data: Buffer.from('e'), fileName: 'e.xlsx' });

    const result = await renderReport('energy', { siteId: 's1' }, 'xlsx', 'de');

    expect(result.fileName).toBe('e.xlsx');
    expect(generatorMocks.energy).toHaveBeenCalledWith({ siteId: 's1' }, 'xlsx', 'de');
  });

  it('throws for an unknown report type', async () => {
    await expect(renderReport('bogus', {}, 'csv', 'en')).rejects.toThrow(
      'No generator registered for report type: bogus',
    );
  });
});

describe('operatorReportLanguage', () => {
  it('returns the stored UI language of the user', async () => {
    setupDbResults([{ language: 'zh-TW' }]);
    expect(await operatorReportLanguage('usr_1')).toBe('zh-TW');
  });

  it('returns en without a user id or for an unknown user', async () => {
    expect(await operatorReportLanguage(null)).toBe('en');
    expect(await operatorReportLanguage('')).toBe('en');
    setupDbResults([]);
    expect(await operatorReportLanguage('usr_missing')).toBe('en');
  });
});
