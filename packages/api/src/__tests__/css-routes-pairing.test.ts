// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const {
  chargingStationsRef,
  cssStationsRef,
  cssEvsesRef,
  cssConfigVariablesRef,
  cssTransactionsRef,
  insertCalls,
  updateCalls,
  state,
  dbMock,
} = vi.hoisted(() => {
  const chargingStationsRef = { __name: 'chargingStations' } as const;
  const cssStationsRef = { __name: 'cssStations', id: 'id', stationId: 'stationId' } as const;
  const cssEvsesRef = { __name: 'cssEvses' } as const;
  const cssConfigVariablesRef = { __name: 'cssConfigVariables' } as const;
  const cssTransactionsRef = { __name: 'cssTransactions' } as const;

  const insertCalls: Array<{
    table: unknown;
    values: Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  }> = [];
  const updateCalls: Array<{ table: unknown; set: Record<string, unknown> | undefined }> = [];
  const state = { dbResults: [] as unknown[][], dbCallIndex: 0 };

  function takeNextResult(): unknown[] {
    const r = state.dbResults[state.dbCallIndex] ?? [];
    state.dbCallIndex++;
    return r;
  }

  // Generic chain (used for select, delete) — returns array of rows when awaited
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      'from',
      'where',
      'orderBy',
      'limit',
      'offset',
      'innerJoin',
      'leftJoin',
      'groupBy',
      'returning',
      'onConflictDoUpdate',
      'onConflictDoNothing',
      'having',
    ];
    for (const m of methods) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chain as any)[m] = () => chain;
    }
    let awaited = false;
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (!awaited) {
        awaited = true;
        return Promise.resolve(takeNextResult()).then(resolve, reject);
      }
      return Promise.resolve([]).then(resolve, reject);
    };
    chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
    return chain;
  }

  function makeInsertChain(table: unknown): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain['values'] = (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
      insertCalls.push({ table, values });
      return chain;
    };
    chain['returning'] = () => chain;
    chain['onConflictDoUpdate'] = () => chain;
    chain['onConflictDoNothing'] = () => chain;
    let awaited = false;
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (!awaited) {
        awaited = true;
        return Promise.resolve(takeNextResult()).then(resolve, reject);
      }
      return Promise.resolve([]).then(resolve, reject);
    };
    chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
    return chain;
  }

  function makeUpdateChain(table: unknown): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain['set'] = (set: Record<string, unknown>) => {
      updateCalls.push({ table, set });
      return chain;
    };
    chain['where'] = () => chain;
    chain['returning'] = () => chain;
    let awaited = false;
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (!awaited) {
        awaited = true;
        return Promise.resolve(takeNextResult()).then(resolve, reject);
      }
      return Promise.resolve([]).then(resolve, reject);
    };
    chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
    return chain;
  }

  const dbMock: Record<string, unknown> = {
    select: () => makeChain(),
    insert: (table: unknown) => makeInsertChain(table),
    update: (table: unknown) => makeUpdateChain(table),
    delete: () => makeChain(),
    execute: () => Promise.resolve([]),
  };
  // Run the callback against the same mock so writes go through the same insert/update chains.
  dbMock['transaction'] = (cb: (tx: unknown) => Promise<unknown>) => cb(dbMock);

  return {
    chargingStationsRef,
    cssStationsRef,
    cssEvsesRef,
    cssConfigVariablesRef,
    cssTransactionsRef,
    insertCalls,
    updateCalls,
    state,
    dbMock,
  };
});

function setupDbResults(...results: unknown[][]) {
  state.dbResults = results;
  state.dbCallIndex = 0;
}

vi.mock('@evtivity/database', () => ({
  db: dbMock,
  cssStations: cssStationsRef,
  cssEvses: cssEvsesRef,
  cssConfigVariables: cssConfigVariablesRef,
  cssTransactions: cssTransactionsRef,
  chargingStations: chargingStationsRef,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: vi.fn(),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { cssRoutes } from '../routes/css.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(cssRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/css/stations auto-creates charging_stations row', () => {
  let app: FastifyInstance;
  let token: string;

  const STATION_ID = 'TEST-CSSPOST-001';

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.dbResults = [];
    state.dbCallIndex = 0;
    insertCalls.length = 0;
    updateCalls.length = 0;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
  });

  it('inserts a charging_stations row with isSimulator=true when none exists', async () => {
    setupDbResults(
      // 1) duplicate check on cssStations -> none
      [],
      // 2) lookup chargingStations -> none
      [],
      // 3) chargingStations insert (no returning) -> empty
      [],
      // 4) cssStations insert returning -> created station
      [
        {
          id: 'css_001',
          stationId: STATION_ID,
          targetUrl: 'ws://ocpp:8080',
          enabled: true,
          status: 'disconnected',
          availabilityState: 'Operative',
          sourceType: 'api',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/css/stations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stationId: STATION_ID,
        ocppProtocol: 'ocpp2.1',
        securityProfile: 1,
        targetUrl: 'ws://ocpp:8080',
        password: 'test-password',
        evses: [{ evseId: 1, connectorId: 1 }],
      },
    });

    expect(res.statusCode).toBe(201);

    // chargingStations insert with isSimulator=true was called
    const csInsert = insertCalls.find((c) => c.table === chargingStationsRef);
    expect(csInsert).toBeDefined();
    const csValues = csInsert?.values as Record<string, unknown>;
    expect(csValues['stationId']).toBe(STATION_ID);
    expect(csValues['isSimulator']).toBe(true);
    expect(csValues['ocppProtocol']).toBe('ocpp2.1');
    expect(csValues['securityProfile']).toBe(1);
    expect(csValues['onboardingStatus']).toBe('accepted');

    // cssStations insert was called
    const cssInsert = insertCalls.find((c) => c.table === cssStationsRef);
    expect(cssInsert).toBeDefined();
    const cssValues = cssInsert?.values as Record<string, unknown>;
    expect(cssValues['stationId']).toBe(STATION_ID);
    expect(cssValues['targetUrl']).toBe('ws://ocpp:8080');
    // Deduplicated columns are NOT on cssStations insert
    expect(cssValues['ocppProtocol']).toBeUndefined();
    expect(cssValues['securityProfile']).toBeUndefined();
    expect(cssValues['model']).toBeUndefined();
    expect(cssValues['serialNumber']).toBeUndefined();
    expect(cssValues['firmwareVersion']).toBeUndefined();
    expect(cssValues['vendorName']).toBeUndefined();
  });

  it('flips isSimulator true on existing non-simulator charging_stations row', async () => {
    const existingCsId = 'sta_existing01';
    setupDbResults(
      // 1) duplicate check on cssStations -> none
      [],
      // 2) lookup chargingStations -> existing non-simulator
      [{ id: existingCsId, isSimulator: false }],
      // 3) chargingStations update (no returning) -> empty
      [],
      // 4) cssStations insert returning -> created station
      [
        {
          id: 'css_002',
          stationId: STATION_ID,
          targetUrl: 'ws://ocpp:8080',
          enabled: true,
          status: 'disconnected',
          availabilityState: 'Operative',
          sourceType: 'api',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/css/stations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stationId: STATION_ID,
        ocppProtocol: 'ocpp2.1',
        securityProfile: 1,
        targetUrl: 'ws://ocpp:8080',
        evses: [{ evseId: 1, connectorId: 1 }],
      },
    });

    expect(res.statusCode).toBe(201);

    // chargingStations update with isSimulator=true was called
    const csUpdate = updateCalls.find((u) => u.table === chargingStationsRef);
    expect(csUpdate).toBeDefined();
    const setValues = csUpdate?.set as Record<string, unknown>;
    expect(setValues['isSimulator']).toBe(true);

    // No new chargingStations insert
    const csInsert = insertCalls.find((c) => c.table === chargingStationsRef);
    expect(csInsert).toBeUndefined();

    // cssStations insert was called
    const cssInsert = insertCalls.find((c) => c.table === cssStationsRef);
    expect(cssInsert).toBeDefined();
  });
});
