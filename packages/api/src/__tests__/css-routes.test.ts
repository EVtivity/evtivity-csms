// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// -- DB mock helpers --

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
    'onConflictDoNothing',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  cssStations: {},
  cssEvses: {},
  cssConfigVariables: {},
  cssTransactions: {},
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

// -- PubSub mock --

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
import { ACTION_VERSIONS, HIGH_LEVEL_ACTIONS, STATION_MESSAGE_ACTIONS } from '../routes/css.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(cssRoutes);
  await app.ready();
  return app;
}

// ===================================================================
// ACTION_VERSIONS unit tests (no HTTP needed)
// ===================================================================

describe('ACTION_VERSIONS', () => {
  it('contains all high-level actions as version "all"', () => {
    for (const action of HIGH_LEVEL_ACTIONS) {
      expect(ACTION_VERSIONS[action]).toBe('all');
    }
  });

  it('contains OCPP 2.1 only actions', () => {
    const ocpp21Actions = [
      'sendTransactionEvent',
      'sendLogStatusNotification',
      'sendSecurityEventNotification',
      'sendNotifyEvent',
      'sendNotifyReport',
      'sendSignCertificate',
    ];
    for (const action of ocpp21Actions) {
      expect(ACTION_VERSIONS[action]).toBe('ocpp2.1');
    }
  });

  it('contains OCPP 1.6 only actions', () => {
    expect(ACTION_VERSIONS['sendStartTransaction']).toBe('ocpp1.6');
    expect(ACTION_VERSIONS['sendStopTransaction']).toBe('ocpp1.6');
    expect(ACTION_VERSIONS['sendDiagnosticsStatusNotification']).toBe('ocpp1.6');
  });

  it('has no undefined version values', () => {
    for (const [, version] of Object.entries(ACTION_VERSIONS)) {
      expect(['all', 'ocpp1.6', 'ocpp2.1']).toContain(version);
    }
  });

  it('station message actions are not in ACTION_VERSIONS (registered per-version)', () => {
    // STATION_MESSAGE_ACTIONS are registered under both v16/ and v21/ prefixes,
    // not in ACTION_VERSIONS with version "all"
    for (const action of STATION_MESSAGE_ACTIONS) {
      expect(ACTION_VERSIONS[action]).toBeUndefined();
    }
  });
});

// ===================================================================
// CSS route tests
// ===================================================================

describe('CSS routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
  });

  // ===================================================================
  // POST /css/actions/:action - Action dispatch
  // ===================================================================

  describe('POST /css/actions/:action', () => {
    // Actions use body { stationId, ...params } instead of URL params
    const plugInPayload = { stationId: 'TEST-001', evseId: 1 };
    const sendTransactionEventPayload = {
      stationId: 'TEST-001',
      evseId: 1,
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionId: 'tx-1',
    };
    const sendStartTransactionPayload = {
      stationId: 'TEST-001',
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: '2024-01-01T00:00:00Z',
    };

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        payload: plugInPayload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: { authorization: `Bearer ${token}` },
        payload: { stationId: 'NONEXISTENT', evseId: 1 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for unknown action (no matching route)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/nonExistentAction',
        headers: { authorization: `Bearer ${token}` },
        payload: { stationId: 'TEST-001' },
      });
      // No route registered for nonExistentAction, Fastify returns 404
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for version mismatch (2.1 action on 1.6 station)', async () => {
      const station = { id: 'id-1', stationId: 'TEST-16', ocppProtocol: 'ocpp1.6' };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/v21/sendTransactionEvent',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...sendTransactionEventPayload, stationId: 'TEST-16' },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('OCPP_VERSION_MISMATCH');
    });

    it('returns 400 for version mismatch (1.6 action on 2.1 station)', async () => {
      const station = { id: 'id-1', stationId: 'TEST-21', ocppProtocol: 'ocpp2.1' };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/v16/sendStartTransaction',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...sendStartTransactionPayload, stationId: 'TEST-21' },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('OCPP_VERSION_MISMATCH');
    });

    it('returns 202 for valid global action', async () => {
      const station = { id: 'id-1', stationId: 'TEST-001', ocppProtocol: 'ocpp2.1' };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: { authorization: `Bearer ${token}` },
        payload: plugInPayload,
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload);
      expect(body.commandId).toBeDefined();
      expect(typeof body.commandId).toBe('string');
      expect(mockPublish).toHaveBeenCalledWith(
        'css_commands',
        expect.stringContaining('"action":"plugIn"'),
      );
    });

    it('returns 202 for version-specific action matching station protocol', async () => {
      const station = { id: 'id-1', stationId: 'TEST-21', ocppProtocol: 'ocpp2.1' };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/actions/v21/sendTransactionEvent',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...sendTransactionEventPayload, stationId: 'TEST-21' },
      });
      expect(response.statusCode).toBe(202);
    });
  });

  // ===================================================================
  // POST /css/stations - Create station
  // ===================================================================

  describe('POST /css/stations', () => {
    it('returns 409 for duplicate stationId', async () => {
      setupDbResults([{ id: 'existing-id' }]);

      const response = await app.inject({
        method: 'POST',
        url: '/css/stations',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          stationId: 'DUPLICATE',
          targetUrl: 'ws://localhost:3003',
          evses: [{ evseId: 1 }],
        },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('DUPLICATE_STATION_ID');
    });
  });

  // ===================================================================
  // GET /css/stations/:stationId - Get station
  // ===================================================================

  describe('GET /css/stations/:stationId', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/css/stations/NONEXISTENT',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ===================================================================
  // DELETE /css/stations/:stationId - Delete station
  // ===================================================================

  describe('DELETE /css/stations/:stationId', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/css/stations/NONEXISTENT',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
