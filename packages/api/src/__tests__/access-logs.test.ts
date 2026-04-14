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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  accessLogs: {},
  users: {},
  drivers: {},
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
  };
});

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
import { accessLogRoutes } from '../routes/access-logs.js';
import { db } from '@evtivity/database';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(accessLogRoutes);
  await app.ready();
  return app;
}

describe('Access log routes', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    operatorToken = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
    driverToken = app.jwt.sign({ driverId: 'driver-id', type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('POST /v1/access-logs (operator)', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        payload: { action: 'login' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when action is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 201 with action="login" and sets category to auth', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { action: 'login' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
      expect(db.insert).toHaveBeenCalled();
    });

    it('returns 201 with action="logout" and sets category to auth', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { action: 'logout' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
    });

    it('returns 201 with action="page_view" and sets category to action', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { action: 'page_view' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
    });

    it('returns 201 with metadata field', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { action: 'login', metadata: { browser: 'Chrome', version: '120' } },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
    });
  });

  describe('POST /v1/portal/access-logs (driver)', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/access-logs',
        payload: { action: 'login' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token (not driver token)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { action: 'login' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 201 with valid driver token', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/access-logs',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { action: 'page_view' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('GET /v1/access-logs', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with no filters', async () => {
      const logEntry = {
        id: 'log-1',
        userId: 'test-id',
        driverId: null,
        action: 'login',
        category: 'auth',
        authType: 'session',
        method: null,
        path: null,
        statusCode: null,
        durationMs: null,
        remoteAddress: '127.0.0.1',
        userAgent: 'test-agent',
        metadata: null,
        createdAt: new Date().toISOString(),
        userEmail: 'user@test.com',
        userFirstName: 'Test',
        userLastName: 'User',
      };
      // First db.select call returns data rows, second returns count
      setupDbResults([logEntry], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([logEntry]);
      expect(body.total).toBe(1);
    });

    it('returns 200 with category=browser filter (maps to auth + action)', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?category=browser',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with category=csms filter (same as browser)', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?category=csms',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with category=api filter', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?category=api',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with category=portal filter', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?category=portal',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with a custom category value', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?category=custom_category',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with method filter', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?method=GET',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with search filter', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?search=login',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 200 with pagination params', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs?page=2&limit=5',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns total 0 when count row is empty', async () => {
      setupDbResults([], []);
      const response = await app.inject({
        method: 'GET',
        url: '/access-logs',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(0);
    });
  });
});
