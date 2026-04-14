// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
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
  transactionEvents: {},
  chargingSessions: {},
  chargingStations: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn) }),
    desc: vi.fn(),
    count: vi.fn(),
    asc: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { transactionRoutes } from '../routes/transactions.js';

const VALID_SESSION_ID = 'ses_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(transactionRoutes);
  await app.ready();
  return app;
}

describe('Transaction routes', () => {
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    app = await buildApp();
    operatorToken = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  // --------------------------------------------------------------------------
  // GET /v1/transactions
  // --------------------------------------------------------------------------
  describe('GET /v1/transactions', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/transactions' });
      expect(res.statusCode).toBe(401);
    });

    it('returns paginated transaction events with defaults', async () => {
      const events = [
        { id: '1', triggerReason: 'Authorized', createdAt: '2024-01-01' },
        { id: '2', triggerReason: 'EVConnected', createdAt: '2024-01-02' },
      ];
      // First chain: data query (wrapped in event key), second chain: count query
      setupDbResults(
        events.map((e) => ({ event: e })),
        [{ count: 2 }],
      );

      const res = await app.inject({
        method: 'GET',
        url: '/transactions',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual(events);
      expect(body.total).toBe(2);
    });

    it('returns paginated results with explicit page and limit', async () => {
      const events = [{ id: '3', triggerReason: 'EVDeparted', createdAt: '2024-02-01' }];
      setupDbResults(
        events.map((e) => ({ event: e })),
        [{ count: 11 }],
      );

      const res = await app.inject({
        method: 'GET',
        url: '/transactions?page=2&limit=5',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual(events);
      expect(body.total).toBe(11);
    });

    it('returns filtered results when search is provided', async () => {
      const events = [{ id: '4', triggerReason: 'Authorized', createdAt: '2024-03-01' }];
      setupDbResults(
        events.map((e) => ({ event: e })),
        [{ count: 1 }],
      );

      const res = await app.inject({
        method: 'GET',
        url: '/transactions?search=Authorized',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual(events);
      expect(body.total).toBe(1);
    });

    it('returns empty data and total 0 when no events exist', async () => {
      setupDbResults([], [{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('defaults total to 0 when count row is missing', async () => {
      setupDbResults([], []);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 400 for invalid page parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/transactions?page=0',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid limit parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/transactions?limit=999',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // GET /v1/transactions/by-session/:sessionId
  // --------------------------------------------------------------------------
  describe('GET /v1/transactions/by-session/:sessionId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/transactions/by-session/${VALID_SESSION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns transaction events for a valid session', async () => {
      const events = [
        { id: '1', sessionId: VALID_SESSION_ID, seqNo: 1, triggerReason: 'Authorized' },
        { id: '2', sessionId: VALID_SESSION_ID, seqNo: 2, triggerReason: 'EVConnected' },
      ];
      setupDbResults(events);

      const res = await app.inject({
        method: 'GET',
        url: `/transactions/by-session/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual(events);
    });

    it('returns empty array when session has no events', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/transactions/by-session/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 400 for invalid sessionId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-session/not-a-nanoid',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // GET /v1/transactions/by-transaction-id/:transactionId
  // --------------------------------------------------------------------------
  describe('GET /v1/transactions/by-transaction-id/:transactionId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-transaction-id/txn-001',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns session when found', async () => {
      const session = {
        id: VALID_SESSION_ID,
        transactionId: 'txn-001',
        stationId: 'station-1',
        status: 'completed',
      };
      setupDbResults([session]);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-transaction-id/txn-001',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.transactionId).toBe('txn-001');
      expect(body.status).toBe('completed');
    });

    it('returns 404 when transaction not found (empty array)', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-transaction-id/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Transaction not found');
      expect(body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('returns 404 when session is null (undefined destructure)', async () => {
      // When db returns an array with no elements, session will be undefined
      // and the ?? null check triggers the 404 path
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-transaction-id/missing-txn',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('accepts any string as transactionId param', async () => {
      const session = {
        id: VALID_SESSION_ID,
        transactionId: 'some-special-chars_123',
        status: 'active',
      };
      setupDbResults([session]);

      const res = await app.inject({
        method: 'GET',
        url: '/transactions/by-transaction-id/some-special-chars_123',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().transactionId).toBe('some-special-chars_123');
    });
  });
});
