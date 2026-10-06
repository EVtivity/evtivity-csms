// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Query = { text: string; values: unknown[] };

const h = vi.hoisted(() => {
  const state = {
    /** Results of db.select() chains, in call order. */
    selectResults: [] as unknown[][],
    updates: [] as Array<{ table: unknown; set: unknown }>,
    deletes: [] as unknown[],
    inserts: [] as unknown[],
    executes: [] as Array<{ text: string; values: unknown[] }>,
    settingsRows: [] as Array<{ key: string; value: unknown }>,
    caEncRows: [] as Array<{ value: unknown }>,
  };
  const chain = (result: () => unknown[], onSet?: (v: unknown) => void): unknown => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'values', 'returning']) {
      c[m] = () => c;
    }
    c['set'] = (v: unknown) => {
      onSet?.(v);
      return c;
    };
    c['then'] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return c;
  };
  return { state, chain };
});

vi.mock('../../../../packages/database/src/config.ts', () => ({ db: {}, client: vi.fn() }));

vi.mock('@evtivity/database', () => {
  const { state, chain } = h;
  const tables = {
    chargingStations: { name: 'charging_stations', stationId: 'station_id' },
    drivers: { name: 'drivers', id: 'id', email: 'email' },
    driverTokens: { name: 'driver_tokens', driverId: 'driver_id' },
    refreshTokens: { name: 'refresh_tokens', id: 'id' },
    users: {
      name: 'users',
      id: 'id',
      hasAllSiteAccess: 'has_all_site_access',
      isActive: 'is_active',
      roleId: 'role_id',
      createdAt: 'created_at',
    },
    roles: { name: 'roles', id: 'id' },
  };
  return {
    ...tables,
    db: {
      select: vi.fn(() => chain(() => state.selectResults.shift() ?? [])),
      insert: vi.fn((table: unknown) => {
        state.inserts.push(table);
        return chain(() => [{ id: 42 }]);
      }),
      update: vi.fn((table: unknown) =>
        chain(
          () => [],
          (v) => state.updates.push({ table, set: v }),
        ),
      ),
      delete: vi.fn((table: unknown) => {
        state.deletes.push(table);
        return chain(() => []);
      }),
      execute: vi.fn((q: { text: string; values: unknown[] }) => {
        state.executes.push(q);
        if (q.text.includes('SELECT key, value FROM settings')) {
          return Promise.resolve(state.settingsRows);
        }
        if (q.text.includes("key = 'pnc.local.caEnc'")) return Promise.resolve(state.caEncRows);
        return Promise.resolve([]);
      }),
    },
    client: vi.fn(),
    OCTT_API_KEY_NAME: 'OCTT conformance run',
    PNC_SETTINGS_CACHE_TTL_MS: 60_000,
  };
});

vi.mock('@evtivity/database/src/lib/id.js', () => ({ createId: vi.fn(() => 'new_id') }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  like: vi.fn(),
  notLike: vi.fn(),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join('?'),
      values,
    })),
    { raw: vi.fn(() => '') },
  ),
}));

const results = vi.hoisted(() => ({ statuses: [] as string[] }));

vi.mock('../executor.js', () => ({
  executeTest: vi.fn((tc: { id: string; name: string; module: string; version: string }) =>
    Promise.resolve({
      testId: tc.id,
      testName: tc.name,
      module: tc.module,
      version: tc.version,
      result: { status: results.statuses.shift() ?? 'passed', durationMs: 1, steps: [] },
    }),
  ),
}));

vi.mock('../registry.js', () => ({
  getRegistry: vi.fn(() =>
    ['TC_B_01_CSMS', 'TC_B_02_CSMS', 'TC_E_01_CSMS', 'TC_E_02_CSMS'].map((id) => ({
      id,
      name: id,
      module: 'X',
      version: 'ocpp2.1',
      sut: 'csms',
      description: '',
      purpose: '',
      execute: vi.fn(),
    })),
  ),
}));

const ocspStop = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../ocsp-test-service.js', () => ({
  startOcspTestService: vi.fn(() =>
    Promise.resolve({
      pki: { moRoot: { cert: { toString: () => 'MO-ROOT-PEM' } } },
      responder: { stop: ocspStop },
      installedMoRootId: null,
    }),
  ),
}));

const api = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown?]>,
  handler: null as
    | null
    | ((method: string, path: string) => { status: number; body: Record<string, unknown> }),
}));
const triggerCommand = vi.hoisted(() => vi.fn());

vi.mock('../api-client.js', () => ({
  createApiClient: vi.fn(() =>
    Promise.resolve({
      triggerCommand,
      callApi: vi.fn((method: string, path: string, body?: unknown) => {
        api.calls.push([method, path, body]);
        return Promise.resolve(api.handler?.(method, path) ?? { status: 200, body: {} });
      }),
    }),
  ),
}));

import { db } from '@evtivity/database';
import { runTests } from '../runner.js';
import { executeTest } from '../executor.js';

const baseConfig = {
  serverUrl: 'ws://localhost:3003',
  concurrency: 2,
  logLevel: 'silent' as const,
};

/** Settings that already hold the run values, so the run does not wait for the caches. */
const READY_SETTINGS = [
  { key: 'pnc.enabled', value: true },
  { key: 'pnc.provider', value: 'local' },
  { key: 'pnc.local.emaidCountry', value: 'US' },
  { key: 'pnc.local.emaidProviderId', value: 'OCT' },
  { key: 'pnc.ocsp.allowedPrivateHosts', value: ['worker'] },
];

const fetchMock = vi.fn();

beforeEach(() => {
  h.state.selectResults = [];
  h.state.updates = [];
  h.state.deletes = [];
  h.state.inserts = [];
  h.state.executes = [];
  h.state.settingsRows = READY_SETTINGS;
  h.state.caEncRows = [];
  api.calls = [];
  api.handler = null;
  results.statuses = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const paths = (): string[] => api.calls.map(([m, p]) => `${m} ${p}`);
const tableNames = (list: unknown[]): string[] => list.map((t) => (t as { name: string }).name);

describe('runTests with the CSMS API', () => {
  it('creates a verified API key, sets up PnC material, and undoes it all at run end', async () => {
    // provisionTestDriver finds the driver of an earlier run; then the admin.
    h.state.selectResults = [[{ id: 'drv_old' }], [{ id: 'usr_1', hasAllSiteAccess: false }]];
    h.state.caEncRows = [{ value: 'previous-ca' }];
    const leftoverPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      subject: i === 6 ? 'CN=OCTT MO Root CA,O=OCTT' : 'CN=Other',
    }));
    api.handler = (method, path) => {
      if (method === 'GET' && path === '/pnc/settings/local-ca') {
        return { status: 200, body: { configured: false } };
      }
      if (method === 'POST' && path === '/pnc/settings/local-ca') return { status: 201, body: {} };
      if (method === 'GET' && path.includes('page=1')) {
        return { status: 200, body: { data: leftoverPage } };
      }
      if (method === 'GET' && path.includes('page=2')) {
        return { status: 200, body: { data: [{ id: 500, subject: 'CN=OCTT MO Root CA' }] } };
      }
      if (method === 'POST' && path === '/pnc/ca-certificates') {
        return { status: 201, body: { id: 99 } };
      }
      if (method === 'DELETE' && path === '/pnc/ca-certificates/500') {
        return { status: 500, body: {} };
      }
      return { status: 200, body: {} };
    };

    const summary = await runTests(
      {
        ...baseConfig,
        apiUrl: 'http://api:7102',
        provisionStations: true,
        ocspResponderUrl: 'http://worker:7110/ocsp',
      },
      vi.fn(),
    );
    expect(summary.passed).toBe(4);

    // The key is verified against an authenticated route with its bearer token.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api:7102/v1/settings/system.timezone',
      expect.objectContaining({
        headers: { Authorization: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) },
      }),
    );
    const call = vi.mocked(executeTest).mock.calls[0];
    expect(call?.[3]).toBe(triggerCommand);
    expect(call?.[4]).toEqual(expect.any(Function));
    expect(call?.[5]).toBe('drv_old');
    expect((call?.[6] as { installedMoRootId: unknown }).installedMoRootId).toBe(99);

    expect(paths()).toEqual([
      'GET /pnc/settings/local-ca',
      'POST /pnc/settings/local-ca',
      'GET /pnc/ca-certificates?certificateType=MORootCertificate&limit=100&page=1',
      'GET /pnc/ca-certificates?certificateType=MORootCertificate&limit=100&page=2',
      'DELETE /pnc/ca-certificates/7',
      'DELETE /pnc/ca-certificates/500',
      'POST /pnc/ca-certificates',
      'DELETE /pnc/ca-certificates/99',
    ]);
    expect(api.calls[6]?.[2]).toEqual({
      certificateType: 'MORootCertificate',
      certificate: 'MO-ROOT-PEM',
    });
    expect(ocspStop).toHaveBeenCalled();

    // All-site access granted for the run, then restored.
    expect(h.state.updates.map((u) => u.set)).toEqual([
      { hasAllSiteAccess: true },
      { hasAllSiteAccess: false },
    ]);
    expect(tableNames(h.state.inserts)).toContain('refresh_tokens');
    expect(tableNames(h.state.deletes)).toContain('refresh_tokens');
    // The test driver of the earlier run is reused, not inserted again.
    expect(tableNames(h.state.inserts)).not.toContain('drivers');

    // The local CA the run created is removed by restoring the previous value.
    const restores = h.state.executes.filter((q: Query) => q.text.includes('UPDATE settings'));
    expect(restores.map((q) => q.values)).toEqual([['"previous-ca"', 'pnc.local.caEnc']]);
  });

  it('runs without trigger commands when the API key does not verify', async () => {
    h.state.selectResults = [[{ id: 'usr_1', hasAllSiteAccess: true }]];
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await runTests({ ...baseConfig, apiUrl: 'http://api:7102', provisionStations: false }, vi.fn());

    const call = vi.mocked(executeTest).mock.calls[0];
    expect(call?.[3]).toBeUndefined();
    expect(call?.[4]).toBeUndefined();
    expect(call?.[5]).toBeUndefined();
    // The key row is still removed; the admin already had all-site access.
    expect(tableNames(h.state.deletes)).toEqual(['refresh_tokens']);
    expect(h.state.updates.map((u) => u.set)).toEqual([{ hasAllSiteAccess: true }]);
    expect(api.calls).toEqual([]);
  });

  it('creates no API key without an active admin', async () => {
    h.state.selectResults = [[]];
    await runTests({ ...baseConfig, apiUrl: 'http://api:7102', provisionStations: false }, vi.fn());
    expect(h.state.inserts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inserts a new test driver when none exists', async () => {
    h.state.selectResults = [[]];
    await runTests({ ...baseConfig, provisionStations: true }, vi.fn());
    expect(tableNames(h.state.inserts)).toEqual(['drivers']);
    expect(vi.mocked(executeTest).mock.calls[0]?.[5]).toBe('new_id');
  });

  it('keeps an existing local contract CA and does not create one', async () => {
    h.state.selectResults = [[{ id: 'drv' }], [{ id: 'usr_1', hasAllSiteAccess: true }]];
    api.handler = (method, path) =>
      method === 'GET' && path === '/pnc/settings/local-ca'
        ? { status: 200, body: { configured: true } }
        : { status: 200, body: {} };
    await runTests({ ...baseConfig, apiUrl: 'http://api:7102', provisionStations: true }, vi.fn());
    expect(paths()).toEqual(['GET /pnc/settings/local-ca']);
  });

  it.each([
    ['the local CA status cannot be read', 500, null, ['GET /pnc/settings/local-ca']],
    [
      'another process created the local CA first',
      200,
      'LOCAL_CA_EXISTS',
      ['GET /pnc/settings/local-ca', 'POST /pnc/settings/local-ca'],
    ],
    [
      'the local CA cannot be created',
      200,
      'INTERNAL',
      ['GET /pnc/settings/local-ca', 'POST /pnc/settings/local-ca'],
    ],
  ])('restores no CA setting when %s', async (_name, getStatus, postCode, expected) => {
    h.state.selectResults = [[{ id: 'drv' }], [{ id: 'usr_1', hasAllSiteAccess: true }]];
    api.handler = (method) =>
      method === 'GET'
        ? { status: getStatus, body: { configured: false } }
        : { status: 409, body: { code: postCode } };
    await runTests({ ...baseConfig, apiUrl: 'http://api:7102', provisionStations: true }, vi.fn());
    expect(paths()).toEqual(expected);
    expect(
      h.state.executes.filter((q: Query) => /UPDATE settings|DELETE FROM settings/.test(q.text)),
    ).toEqual([]);
  });

  it('leaves installedMoRootId null when the MO root cannot be installed', async () => {
    h.state.selectResults = [[{ id: 'usr_1', hasAllSiteAccess: true }]];
    api.handler = (method) =>
      method === 'GET' ? { status: 500, body: {} } : { status: 400, body: { error: 'bad' } };
    await runTests(
      {
        ...baseConfig,
        apiUrl: 'http://api:7102',
        provisionStations: false,
        ocspResponderUrl: 'http://worker:7110/ocsp',
      },
      vi.fn(),
    );
    // The leftover listing failed, so nothing was deleted; no root id to remove at the end.
    expect(paths()).toEqual([
      'GET /pnc/ca-certificates?certificateType=MORootCertificate&limit=100&page=1',
      'POST /pnc/ca-certificates',
    ]);
    const ocsp = vi.mocked(executeTest).mock.calls[0]?.[6] as { installedMoRootId: unknown };
    expect(ocsp.installedMoRootId).toBeNull();
  });

  it('starts the OCSP responder without the API and installs no MO root', async () => {
    await runTests(
      { ...baseConfig, provisionStations: false, ocspResponderUrl: 'http://worker:7110/ocsp' },
      vi.fn(),
    );
    const ocsp = vi.mocked(executeTest).mock.calls[0]?.[6] as { installedMoRootId: unknown };
    expect(ocsp.installedMoRootId).toBeNull();
    expect(ocspStop).toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it('counts each result status in the summary', async () => {
    results.statuses = ['failed', 'skipped', 'error', 'passed'];
    const summary = await runTests({ ...baseConfig, provisionStations: false }, vi.fn());
    expect(summary).toMatchObject({ total: 4, passed: 1, failed: 1, skipped: 1, errors: 1 });
  });

  it('filters by sut and test ids', async () => {
    const summary = await runTests(
      { ...baseConfig, provisionStations: false, sut: 'csms', testIds: ['TC_E_02_CSMS'] },
      vi.fn(),
    );
    expect(summary.total).toBe(1);
    const none = await runTests({ ...baseConfig, provisionStations: false, sut: 'cs' }, vi.fn());
    expect(none.total).toBe(0);
    expect(vi.mocked(db.execute)).not.toHaveBeenCalled();
  });
});
