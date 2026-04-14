// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
let dbError: Error | null = null;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
  dbError = null;
}

function setupDbError(error: Error) {
  dbError = error;
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
    'values',
    'returning',
    'set',
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
      if (dbError != null) {
        return Promise.reject(dbError).then(resolve, reject);
      }
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
  },
  pricingHolidays: { id: 'id', date: 'date' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { holidayRoutes } from '../routes/holidays.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  holidayRoutes(app);
  await app.ready();
  return app;
}

describe('Holiday routes', () => {
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
    setupDbResults();
  });

  // ---------- GET /v1/pricing-holidays ----------

  describe('GET /v1/pricing-holidays', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/pricing-holidays' });
      expect(res.statusCode).toBe(401);
    });

    it('returns all holidays', async () => {
      const holidays = [
        { id: 1, name: "New Year's Day", date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
        { id: 2, name: 'Independence Day', date: '2026-07-04', createdAt: '2026-01-01T00:00:00Z' },
      ];
      setupDbResults(holidays);
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    });

    it('returns empty array when no holidays exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  // ---------- POST /v1/pricing-holidays ----------

  describe('POST /v1/pricing-holidays', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays',
        payload: { name: 'Test', date: '2026-01-01' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a holiday', async () => {
      const created = {
        id: 1,
        name: "New Year's Day",
        date: '2026-01-01',
        createdAt: '2026-01-01T00:00:00Z',
      };
      setupDbResults([created]);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "New Year's Day", date: '2026-01-01' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe("New Year's Day");
      expect(body.date).toBe('2026-01-01');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
        payload: { date: '2026-01-01' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when date format is invalid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Test', date: '01-01-2026' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 409 on duplicate date', async () => {
      const pgError = new Error('duplicate key') as Error & { code: string };
      pgError.code = '23505';
      setupDbError(pgError);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Duplicate', date: '2026-01-01' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_HOLIDAY');
    });
  });

  // ---------- DELETE /v1/pricing-holidays/:id ----------

  describe('DELETE /v1/pricing-holidays/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/pricing-holidays/1',
      });
      expect(res.statusCode).toBe(401);
    });

    it('deletes a holiday', async () => {
      const existing = {
        id: 1,
        name: "New Year's Day",
        date: '2026-01-01',
        createdAt: '2026-01-01T00:00:00Z',
      };
      setupDbResults([existing], []);
      const res = await app.inject({
        method: 'DELETE',
        url: '/pricing-holidays/1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('returns 404 when holiday not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/pricing-holidays/999',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('HOLIDAY_NOT_FOUND');
    });

    it('returns 400 when id is not a number', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/pricing-holidays/abc',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- POST /v1/pricing-holidays/bulk ----------

  describe('POST /v1/pricing-holidays/bulk', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays/bulk',
        payload: { holidays: [{ name: 'Test', date: '2026-01-01' }] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('bulk creates holidays', async () => {
      const created = [
        { id: 1, name: "New Year's Day", date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
        {
          id: 2,
          name: 'Independence Day',
          date: '2026-07-04',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      setupDbResults(created);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays/bulk',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          holidays: [
            { name: "New Year's Day", date: '2026-01-01' },
            { name: 'Independence Day', date: '2026-07-04' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    });

    it('returns 400 when holidays array is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays/bulk',
        headers: { authorization: `Bearer ${token}` },
        payload: { holidays: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when date format is invalid in bulk', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-holidays/bulk',
        headers: { authorization: `Bearer ${token}` },
        payload: { holidays: [{ name: 'Test', date: 'bad-date' }] },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
