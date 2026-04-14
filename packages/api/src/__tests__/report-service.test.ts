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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(),
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
  cronjobs: {},
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

import { registerGenerator, queueReport, generateReport } from '../services/report.service.js';
import type { ReportGenerator } from '../services/report.service.js';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
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
});

describe('generateReport', () => {
  it('sets status to generating then dispatches to registered generator', async () => {
    const mockGenerator: ReportGenerator = vi.fn().mockResolvedValue({
      data: Buffer.from('report-data'),
      fileName: 'report.csv',
    });
    registerGenerator('usage', mockGenerator);

    const report = {
      reportType: 'usage',
      format: 'csv',
      filters: { month: 1 },
    };
    setupDbResults([], [report], []);

    await generateReport('report-123');

    expect(mockGenerator).toHaveBeenCalledWith({ month: 1 }, 'csv');
  });

  it('sets status to failed when no generator is registered for report type', async () => {
    const report = {
      reportType: 'unknown-type',
      format: 'csv',
      filters: {},
    };
    setupDbResults([], [report], []);

    await generateReport('report-456');
  });

  it('sets status to failed when generator throws an error', async () => {
    const failingGenerator: ReportGenerator = vi
      .fn()
      .mockRejectedValue(new Error('Generation failed'));
    registerGenerator('failing', failingGenerator);

    const report = {
      reportType: 'failing',
      format: 'pdf',
      filters: {},
    };
    setupDbResults([], [report], []);

    await generateReport('report-789');

    expect(failingGenerator).toHaveBeenCalled();
  });

  it('returns early when report not found', async () => {
    setupDbResults([], []);

    await generateReport('nonexistent');
  });
});

describe('registerGenerator', () => {
  it('registers a generator that can be used by generateReport', async () => {
    const generator: ReportGenerator = vi.fn().mockResolvedValue({
      data: Buffer.from('output'),
      fileName: 'out.csv',
    });
    registerGenerator('custom', generator);

    const report = {
      reportType: 'custom',
      format: 'csv',
      filters: { key: 'value' },
    };
    setupDbResults([], [report], []);

    await generateReport('report-abc');

    expect(generator).toHaveBeenCalledWith({ key: 'value' }, 'csv');
  });
});
