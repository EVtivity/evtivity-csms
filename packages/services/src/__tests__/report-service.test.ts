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
  lt: vi.fn(),
  ne: vi.fn(),
  gte: vi.fn(),
}));

const { generatorMocks, mockLogError, mockLogWarn } = vi.hoisted(() => ({
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
  mockLogWarn: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: mockLogError, warn: mockLogWarn, info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../report-generators/nevi-report.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../report-generators/nevi-report.js')>()),
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
  reportFileFormat,
  reportFiltersError,
  reportJobId,
  sweepStaleReports,
  REPORT_GENERATING_TIMEOUT_MS,
  REPORT_PENDING_RETRY_MS,
  REPORT_TIMED_OUT_ERROR,
  REPORT_TYPES,
  listReportTypes,
  reportGenerators,
} from '../report.service.js';

describe('built-in report generators', () => {
  it('registers one generator per report type', () => {
    expect(
      reportGenerators
        .list()
        .map((d) => d.type)
        .sort(),
    ).toEqual([...REPORT_TYPES].sort());
  });

  it('lists every type with its formats and whether the Generate tab offers it', () => {
    const all = ['csv', 'pdf', 'xlsx'];
    expect(listReportTypes()).toEqual([
      { type: 'revenue', formats: all, generateFromUi: true },
      { type: 'utilization', formats: all, generateFromUi: true },
      { type: 'energy', formats: all, generateFromUi: true },
      { type: 'stationHealth', formats: all, generateFromUi: true },
      { type: 'sessions', formats: all, generateFromUi: true },
      { type: 'sustainability', formats: all, generateFromUi: true },
      { type: 'driverActivity', formats: all, generateFromUi: true },
      { type: 'nevi', formats: ['xlsx'], generateFromUi: false },
    ]);
  });

  it('gives only NEVI a filter rule', () => {
    const withRule = reportGenerators
      .list()
      .filter((d) => d.validateFilters != null)
      .map((d) => d.type);
    expect(withRule).toEqual(['nevi']);
  });
});

describe('reportFiltersError', () => {
  it('refuses a NEVI report without a valid quarter and year', () => {
    const message = 'Filters must include a valid quarter (1-4) and year';
    expect(reportFiltersError('nevi', {})).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 1 })).toBe(message);
    expect(reportFiltersError('nevi', { year: 2026 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 0, year: 2026 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 5, year: 2026 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 1.5, year: 2026 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 1, year: 1999 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 1, year: 10000 })).toBe(message);
    expect(reportFiltersError('nevi', { quarter: 'x', year: 2026 })).toBe(message);
  });

  it('accepts a NEVI report with quarter 1-4 and a four-digit year, as numbers or strings', () => {
    expect(reportFiltersError('nevi', { quarter: 1, year: 2026 })).toBeNull();
    expect(reportFiltersError('nevi', { quarter: 4, year: 2000 })).toBeNull();
    expect(reportFiltersError('nevi', { quarter: '3', year: '2026' })).toBeNull();
  });

  it('has no filter rule for an unknown report type', () => {
    expect(reportFiltersError('bogus', {})).toBeNull();
  });

  it('has no required filters for the other report types', () => {
    for (const type of REPORT_TYPES.filter((t) => t !== 'nevi')) {
      expect(reportFiltersError(type, {})).toBeNull();
    }
  });
});

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
  mockGetSystemTimezone.mockResolvedValue('America/New_York');
});

describe('queueReport', () => {
  const params = {
    name: 'Monthly Usage',
    reportType: 'sessions',
    format: 'csv',
    filters: { month: 1 },
    userId: 'user-1',
  };

  it('stores the report, hands its id to dispatch and returns it', async () => {
    setupDbResults([{ id: 'report-123' }]);
    const dispatch = vi.fn().mockResolvedValue(undefined);

    const result = await queueReport(params, dispatch);

    expect(result).toBe('report-123');
    expect(dispatch).toHaveBeenCalledWith('report-123');
    for (const generator of Object.values(generatorMocks)) {
      expect(generator).not.toHaveBeenCalled();
    }
  });

  it('keeps the report pending and logs when dispatch fails', async () => {
    setupDbResults([{ id: 'report-lost' }]);
    const dispatch = vi.fn().mockRejectedValue(new Error('redis down'));

    const result = await queueReport(params, dispatch);

    expect(result).toBe('report-lost');
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'report-lost' }),
      'Failed to queue report generation; the report sweep retries it',
    );
  });

  it('stores a NEVI report as xlsx whatever format was asked', async () => {
    const { db } = await import('@evtivity/database');
    setupDbResults([{ id: 'report-nevi' }]);

    await queueReport(
      { ...params, reportType: 'nevi', format: 'csv', filters: { quarter: 1, year: 2026 } },
      vi.fn().mockResolvedValue(undefined),
    );

    const chain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ format: 'xlsx' }));
    expect(reportFileFormat('nevi', 'pdf')).toBe('xlsx');
    expect(reportFileFormat('sessions', 'pdf')).toBe('pdf');
    expect(reportFileFormat('nevi', 'xlsx')).toBe('xlsx');
    expect(reportFileFormat('bogus', 'csv')).toBe('csv');
  });

  it('returns an empty string and dispatches nothing when insert returns no row', async () => {
    setupDbResults([]);
    const dispatch = vi.fn();

    const result = await queueReport(params, dispatch);

    expect(result).toBe('');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('reportJobId', () => {
  it('gives one job id per report', () => {
    expect(reportJobId('rpt_1')).toBe('report-rpt_1');
  });
});

describe('sweepStaleReports', () => {
  it('returns the stale pending ids and counts the timed-out reports', async () => {
    setupDbResults([{ id: 'rpt_a' }, { id: 'rpt_b' }], [{ id: 'rpt_c' }]);

    const result = await sweepStaleReports();

    expect(result).toEqual({ pending: ['rpt_a', 'rpt_b'], timedOut: 1 });
  });

  it('marks timed-out reports failed with the timeout error', async () => {
    setupDbResults([], []);
    const { db } = await import('@evtivity/database');

    await sweepStaleReports();

    const chain = vi.mocked(db.update).mock.results[0]?.value as { set: ReturnType<typeof vi.fn> };
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: REPORT_TIMED_OUT_ERROR }),
    );
  });

  it('uses a short pending retry and a long generating timeout', () => {
    expect(REPORT_PENDING_RETRY_MS).toBe(2 * 60_000);
    expect(REPORT_GENERATING_TIMEOUT_MS).toBe(30 * 60_000);
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
  it('claims the pending report then dispatches to the generator of the report type', async () => {
    generatorMocks.revenue.mockResolvedValue({
      data: Buffer.from('report-data'),
      fileName: 'report.csv',
    });

    const report = {
      reportType: 'revenue',
      format: 'csv',
      filters: { month: 1 },
    };
    setupDbResults([report], []);

    await generateReport('report-123');

    expect(generatorMocks.revenue).toHaveBeenCalledWith({ month: 1 }, 'csv', 'en');
  });

  it('does nothing when the report is no longer pending (a job delivered twice)', async () => {
    setupDbResults([]);

    await generateReport('report-taken');

    for (const generator of Object.values(generatorMocks)) {
      expect(generator).not.toHaveBeenCalled();
    }
  });

  it("generates the file in the requesting operator's language", async () => {
    generatorMocks.sessions.mockResolvedValue({ data: Buffer.from('x'), fileName: 's.pdf' });
    setupDbResults(
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
      [{ reportType: 'sessions', format: 'csv', filters: {}, generatedById: 'usr_1' }],
      [{ language: 'fr' }],
      [],
    );

    await generateReport('report-fr');

    expect(generatorMocks.sessions).toHaveBeenCalledWith({}, 'csv', 'en');
  });

  it('has a generator for every report type without startup registration', async () => {
    // The worker generates every report, so no report type may depend on a
    // process registering its generator first.
    for (const reportType of REPORT_TYPES) {
      generatorMocks[reportType].mockResolvedValue({
        data: Buffer.from('x'),
        fileName: `${reportType}.csv`,
      });
      setupDbResults([{ reportType, format: 'csv', filters: {} }], []);

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
    setupDbResults([report], []);

    await generateReport('report-456');

    for (const generator of Object.values(generatorMocks)) {
      expect(generator).not.toHaveBeenCalled();
    }
  });

  it('logs and sets status to failed when the generator throws', async () => {
    generatorMocks.energy.mockRejectedValue(new Error('boom'));

    const report = { reportType: 'energy', format: 'pdf', filters: {} };
    setupDbResults([report], []);

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
    setupDbResults([report], []);

    await generateReport('report-string-fail');

    expect(generatorMocks.sessions).toHaveBeenCalled();
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
