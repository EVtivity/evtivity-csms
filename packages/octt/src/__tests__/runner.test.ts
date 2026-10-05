// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database config module to prevent postgres from connecting at module load
vi.mock('../../../../packages/database/src/config.ts', () => ({
  db: {},
  client: vi.fn(),
}));

// Mock database exports
vi.mock('@evtivity/database', () => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of [
      'values',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'where',
      'from',
      'innerJoin',
      'orderBy',
      'limit',
      'set',
      'returning',
    ]) {
      chain[m] = vi.fn(self);
    }
    chain['then'] = (resolve?: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  };
  const chain = makeChain();
  return {
    db: {
      insert: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      select: vi.fn(() => chain),
      update: vi.fn(() => chain),
      execute: vi.fn(() => Promise.resolve([])),
    },
    client: vi.fn(),
    chargingStations: { id: 'id', stationId: 'station_id' },
    drivers: { id: 'id', email: 'email' },
    driverTokens: { id: 'id', driverId: 'driver_id' },
    refreshTokens: { id: 'id' },
    users: { id: 'id' },
    roles: { id: 'id', name: 'name' },
    pricingGroups: { id: 'id' },
    tariffs: { id: 'id' },
    pricingGroupDrivers: { id: 'id' },
    OCTT_API_KEY_NAME: 'OCTT conformance run',
    PNC_SETTINGS_CACHE_TTL_MS: 60_000,
  };
});

vi.mock('@evtivity/database/src/lib/id.js', () => ({
  createId: vi.fn(() => 'mock_id'),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  like: vi.fn(),
  inArray: vi.fn(),
  // The query text with its parameters, so db.execute can answer per query.
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join('?'),
      values,
    })),
    { raw: vi.fn(() => '') },
  ),
}));

vi.mock('../executor.js', () => ({
  executeTest: vi.fn(async (tc: { id: string; name: string; module: string; version: string }) => ({
    testId: tc.id,
    testName: tc.name,
    module: tc.module,
    version: tc.version,
    result: {
      status: 'passed' as const,
      durationMs: 50,
      steps: [],
    },
  })),
}));

vi.mock('../registry.js', () => ({
  getRegistry: vi.fn(() => [
    {
      id: 'TC_B_01_CSMS',
      name: 'Boot Notification',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
    {
      id: 'TC_B_02_CSMS',
      name: 'Boot Notification Rejected',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
    {
      id: 'TC_E_01_CSMS',
      name: 'Transaction Start',
      module: 'E-transactions',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
  ]),
}));

vi.mock('../pics/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pics/index.js')>();
  return { ...actual, getNotApplicable: vi.fn(actual.getNotApplicable) };
});

vi.mock('../ocsp-test-service.js', () => ({
  startOcspTestService: vi.fn(() =>
    Promise.resolve({
      pki: {},
      responder: { stop: vi.fn(() => Promise.resolve()) },
      installedMoRootId: null,
    }),
  ),
}));

vi.mock('../api-client.js', () => ({
  createApiClient: vi.fn(() => ({
    createApiKey: vi.fn().mockResolvedValue({ id: 1, key: 'test-key' }),
    deleteApiKey: vi.fn().mockResolvedValue(undefined),
    triggerCommand: vi.fn().mockResolvedValue({ status: 'Accepted' }),
  })),
}));

import { eq } from 'drizzle-orm';
import { db, PNC_SETTINGS_CACHE_TTL_MS } from '@evtivity/database';
import { runTests } from '../runner.js';
import { executeTest } from '../executor.js';
import { getRegistry } from '../registry.js';
import { getNotApplicable } from '../pics/index.js';
import type { TestCase, TestCaseResult } from '../types.js';

describe('runTests', () => {
  const config = {
    serverUrl: 'ws://localhost:3003',
    version: 'ocpp2.1' as const,
    concurrency: 2,
    provisionStations: false,
    logLevel: 'silent' as const,
  };

  it('runs all matching tests and returns summary', async () => {
    const results: Array<{ testId: string }> = [];
    const summary = await runTests(config, (r) => results.push(r));

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(results).toHaveLength(3);
  });

  it('filters by module when specified', async () => {
    const results: Array<{ module: string }> = [];
    const summary = await runTests({ ...config, module: 'B-provisioning' }, (r) => results.push(r));

    expect(summary.total).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.module === 'B-provisioning')).toBe(true);
  });

  it('calls onResult callback for each test', async () => {
    const onResult = vi.fn();
    await runTests(config, onResult);
    expect(onResult).toHaveBeenCalledTimes(3);
  });

  it('creates the API key for an active admin-role user', async () => {
    // The key is verified against the API; no request leaves the test.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await runTests({ ...config, apiUrl: 'http://localhost:7102' }, vi.fn());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(eq).toHaveBeenCalledWith('name', 'admin');
  });

  it('runs the ISO 15118 contract certificate tests the CSMS PICS declares supported', async () => {
    const testCase = (id: string): TestCase => ({
      id,
      name: id,
      module: 'M-certificate-management',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    });
    vi.mocked(getRegistry).mockReturnValueOnce([
      testCase('TC_M_24_CSMS'),
      testCase('TC_M_26_CSMS'),
      testCase('TC_M_28_CSMS'),
      testCase('TC_M_100_CSMS'),
    ]);
    vi.mocked(executeTest).mockClear();

    const summary = await runTests(config, vi.fn());

    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(4);
    expect(summary.notApplicable).toBe(0);
    expect(
      vi
        .mocked(executeTest)
        .mock.calls.map((c) => c[0].id)
        .sort(),
    ).toEqual(['TC_M_100_CSMS', 'TC_M_24_CSMS', 'TC_M_26_CSMS', 'TC_M_28_CSMS']);
  });

  it('reports tests the CSMS PICS excludes as notApplicable without executing them', async () => {
    const actual = await vi.importActual<typeof import('../pics/index.js')>('../pics/index.js');
    const excluded = {
      item: 'ExampleFeature',
      reason: 'PICS ExampleFeature not supported: no example feature',
    };
    vi.mocked(getNotApplicable).mockImplementation((id, version, sut) =>
      id === 'TC_E_01_CSMS' ? excluded : actual.getNotApplicable(id, version, sut),
    );
    vi.mocked(executeTest).mockClear();

    const results: TestCaseResult[] = [];
    try {
      const summary = await runTests(config, (r) => results.push(r));

      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(2);
      expect(summary.notApplicable).toBe(1);
    } finally {
      vi.mocked(getNotApplicable).mockImplementation(actual.getNotApplicable);
    }
    expect(vi.mocked(executeTest)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeTest).mock.calls.map((c) => c[0].id)).not.toContain('TC_E_01_CSMS');

    const na = results.find((r) => r.testId === 'TC_E_01_CSMS');
    expect(na?.result.status).toBe('notApplicable');
    expect(na?.result.durationMs).toBe(0);
    expect(na?.result.steps).toEqual([]);
    expect(na?.result.notApplicable).toEqual(excluded);
  });

  describe('PnC settings and the CSMS settings caches', () => {
    type Query = { text: string; values: unknown[] };
    const settingsSelect = (rows: { key: string; value: unknown }[]) =>
      vi
        .mocked(db.execute)
        .mockImplementation(((query: Query) =>
          Promise.resolve(
            query.text.includes('SELECT key, value FROM settings') ? rows : [],
          )) as never);
    const writes = (): string[] =>
      vi
        .mocked(db.execute)
        .mock.calls.map((call) => call[0] as unknown as Query)
        .filter((q) => /INSERT INTO settings|UPDATE settings|DELETE FROM settings/.test(q.text))
        .map((q) => `${q.text.split(' ')[0] ?? ''} ${String(q.values[0])}`.trim());

    beforeEach(() => {
      vi.mocked(db.execute).mockReset();
      vi.mocked(executeTest).mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts no test before the CSMS caches can have picked up PnC enabled by the run', async () => {
      // The OCPP server cached pnc.enabled = false just before the run: a
      // V2G SignCertificate sent before the cache expires is Rejected (TC_A_12).
      vi.useFakeTimers();
      settingsSelect([{ key: 'pnc.enabled', value: false }]);

      const run = runTests({ ...config, provisionStations: true }, vi.fn());
      await vi.advanceTimersByTimeAsync(PNC_SETTINGS_CACHE_TTL_MS);
      expect(vi.mocked(executeTest)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await run;
      expect(vi.mocked(executeTest)).toHaveBeenCalledTimes(3);
    });

    it('does not wait when the settings already have the run values', async () => {
      vi.useFakeTimers();
      settingsSelect([
        { key: 'pnc.enabled', value: true },
        { key: 'pnc.provider', value: 'local' },
        { key: 'pnc.local.emaidCountry', value: 'DE' },
        { key: 'pnc.local.emaidProviderId', value: 'EVT' },
      ]);

      const run = runTests({ ...config, provisionStations: true }, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      await run;
      expect(vi.mocked(executeTest)).toHaveBeenCalledTimes(3);
      expect(writes()).toEqual([]);
    });

    it('allows the OCSP responder host for the run and restores every changed setting', async () => {
      vi.useFakeTimers();
      settingsSelect([
        { key: 'pnc.enabled', value: false },
        { key: 'pnc.provider', value: 'local' },
        { key: 'pnc.local.emaidCountry', value: 'DE' },
        { key: 'pnc.local.emaidProviderId', value: 'EVT' },
        { key: 'pnc.ocsp.allowedPrivateHosts', value: ['ocsp.internal'] },
      ]);
      const run = runTests(
        { ...config, provisionStations: true, ocspResponderUrl: 'http://Worker:7110/ocsp' },
        vi.fn(),
      );
      await vi.advanceTimersByTimeAsync(PNC_SETTINGS_CACHE_TTL_MS + 1_000);
      await run;

      const inserts = vi
        .mocked(db.execute)
        .mock.calls.map((call) => call[0] as unknown as Query)
        .filter((q) => q.text.includes('INSERT INTO settings'));
      expect(inserts.map((q) => [q.values[0], q.values[1]])).toEqual([
        ['pnc.enabled', 'true'],
        ['pnc.ocsp.allowedPrivateHosts', '["ocsp.internal","worker"]'],
      ]);
      const restores = vi
        .mocked(db.execute)
        .mock.calls.map((call) => call[0] as unknown as Query)
        .filter((q) => q.text.includes('UPDATE settings'));
      expect(restores.map((q) => [q.values[1], q.values[0]])).toEqual([
        ['pnc.enabled', 'false'],
        ['pnc.ocsp.allowedPrivateHosts', '["ocsp.internal"]'],
      ]);
    });

    it('sets the local provider and the test eMAID prefix when none is set, and restores them', async () => {
      vi.useFakeTimers();
      settingsSelect([
        { key: 'pnc.enabled', value: true },
        { key: 'pnc.provider', value: 'manual' },
        { key: 'pnc.local.emaidCountry', value: '' },
      ]);
      const run = runTests({ ...config, provisionStations: true }, vi.fn());
      await vi.advanceTimersByTimeAsync(PNC_SETTINGS_CACHE_TTL_MS + 1_000);
      await run;

      const inserts = vi
        .mocked(db.execute)
        .mock.calls.map((call) => call[0] as unknown as Query)
        .filter((q) => q.text.includes('INSERT INTO settings'));
      expect(inserts.map((q) => [q.values[0], q.values[1]])).toEqual([
        ['pnc.provider', '"local"'],
        ['pnc.local.emaidCountry', '"US"'],
        ['pnc.local.emaidProviderId', '"OCT"'],
      ]);
      // Previous values come back; a setting that did not exist is deleted.
      const restores = vi
        .mocked(db.execute)
        .mock.calls.map((call) => call[0] as unknown as Query)
        .filter((q) => /UPDATE settings|DELETE FROM settings/.test(q.text));
      expect(restores.map((q) => q.values)).toEqual([
        ['"manual"', 'pnc.provider'],
        ['""', 'pnc.local.emaidCountry'],
        ['pnc.local.emaidProviderId'],
      ]);
    });
  });
});
