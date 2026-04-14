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
  },
  ocpiTariffMappings: {},
  tariffs: {},
  ocpiPartners: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: () => ({
    publish: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

import { registerAuth } from '../plugins/auth.js';
import { ocpiTariffRoutes } from '../routes/ocpi-tariffs.js';

const now = new Date().toISOString();

function makeMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tariffId: 'trf_000000000001',
    partnerId: 'opr_000000000001',
    ocpiTariffId: 'TARIFF-001',
    currency: 'USD',
    createdAt: now,
    updatedAt: now,
    tariffName: 'Standard Rate',
    partnerName: 'Test Partner',
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  ocpiTariffRoutes(app);
  await app.ready();
  return app;
}

describe('OCPI tariff mapping routes', () => {
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

  // -------------------------------------------------------
  // GET /v1/ocpi/tariff-mappings/:id
  // -------------------------------------------------------

  describe('GET /v1/ocpi/tariff-mappings/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ocpi/tariff-mappings/1',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 when mapping found', async () => {
      const mapping = makeMapping();
      setupDbResults([mapping]);

      const res = await app.inject({
        method: 'GET',
        url: '/ocpi/tariff-mappings/1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(String(body.id)).toBe('1');
      expect(body.ocpiTariffId).toBe('TARIFF-001');
      expect(body.tariffName).toBe('Standard Rate');
      expect(body.partnerName).toBe('Test Partner');
    });

    it('returns 404 when mapping not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/ocpi/tariff-mappings/999',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Tariff mapping not found');
      expect(body.code).toBe('MAPPING_NOT_FOUND');
    });

    it('returns 400 for invalid id param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ocpi/tariff-mappings/abc',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for negative id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ocpi/tariff-mappings/-1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
