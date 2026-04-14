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
  client: {},
  pricingGroups: { id: 'id', pricingGroupId: 'pricingGroupId', isDefault: 'isDefault' },
  tariffs: {
    id: 'id',
    pricingGroupId: 'pricingGroupId',
    isActive: 'isActive',
    priority: 'priority',
    isDefault: 'isDefault',
    restrictions: 'restrictions',
  },
  pricingHolidays: { date: 'date' },
  chargingSessions: { tariffId: 'tariffId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ne: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { pricingRoutes } from '../routes/pricing.js';

const VALID_GROUP_ID = 'pgr_000000000001';
const VALID_TARIFF_ID = 'trf_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  pricingRoutes(app);
  await app.ready();
  return app;
}

describe('Pricing routes', () => {
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

  // ---------- GET /v1/pricing-groups ----------

  describe('GET /v1/pricing-groups', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/pricing-groups' });
      expect(res.statusCode).toBe(401);
    });

    it('returns all pricing groups', async () => {
      const groups = [
        {
          id: VALID_GROUP_ID,
          name: 'Default',
          description: null,
          isDefault: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];
      setupDbResults(groups);
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('Default');
    });

    it('returns empty array when no groups exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  // ---------- GET /v1/pricing-groups/:id ----------

  describe('GET /v1/pricing-groups/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns a pricing group by ID', async () => {
      const group = {
        id: VALID_GROUP_ID,
        name: 'Default',
        description: 'Default group',
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      setupDbResults([group]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_GROUP_ID);
      expect(body.name).toBe('Default');
    });

    it('returns 404 when pricing group not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
    });

    it('returns 400 when id is invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-groups/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- POST /v1/pricing-groups ----------

  describe('POST /v1/pricing-groups', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        payload: { name: 'Test' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a pricing group', async () => {
      const created = {
        id: VALID_GROUP_ID,
        name: 'Premium',
        description: 'Premium pricing',
        isDefault: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      setupDbResults([created]);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Premium', description: 'Premium pricing' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe('Premium');
      expect(body.description).toBe('Premium pricing');
    });

    it('creates a pricing group with isDefault flag', async () => {
      const created = {
        id: VALID_GROUP_ID,
        name: 'Default Group',
        description: null,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      setupDbResults([created]);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Default Group', isDefault: true },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().isDefault).toBe(true);
    });

    it('creates a pricing group with only required fields', async () => {
      const created = {
        id: VALID_GROUP_ID,
        name: 'Minimal',
        description: null,
        isDefault: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      setupDbResults([created]);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Minimal' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Minimal');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- GET /v1/pricing-groups/:id/tariffs ----------

  describe('GET /v1/pricing-groups/:id/tariffs', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns tariffs for a pricing group', async () => {
      const tariffList = [
        {
          id: VALID_TARIFF_ID,
          pricingGroupId: VALID_GROUP_ID,
          name: 'Standard',
          currency: 'USD',
          pricePerKwh: '0.25',
          pricePerMinute: null,
          pricePerSession: null,
          isActive: true,
          idleFeePricePerMinute: null,
          taxRate: null,
          restrictions: null,
          reservationFeePerMinute: null,
          priority: 0,
          isDefault: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];
      setupDbResults(tariffList);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('Standard');
      expect(body[0].currency).toBe('USD');
    });

    it('returns empty array when group has no tariffs', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 400 when id is invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pricing-groups/not-a-nanoid/tariffs',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- GET /v1/pricing-groups/:id/tariffs/:tariffId ----------

  describe('GET /v1/pricing-groups/:id/tariffs/:tariffId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns a single tariff', async () => {
      const tariff = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'Standard',
        currency: 'USD',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: null,
        isActive: true,
        idleFeePricePerMinute: null,
        taxRate: null,
        restrictions: null,
        reservationFeePerMinute: null,
        priority: 0,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      setupDbResults([tariff]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_TARIFF_ID);
      expect(body.name).toBe('Standard');
      expect(body.currency).toBe('USD');
    });

    it('returns 404 when tariff not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TARIFF_NOT_FOUND');
    });

    it('returns 400 when tariffId is invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/not-a-nanoid`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- POST /v1/pricing-groups/:id/tariffs ----------

  describe('POST /v1/pricing-groups/:id/tariffs', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        payload: { name: 'Test Tariff', currency: 'USD' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a tariff in a pricing group', async () => {
      const created = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'Peak Rate',
        currency: 'USD',
        pricePerKwh: '0.35',
        pricePerMinute: '0.05',
        pricePerSession: '1.00',
        isActive: true,
        idleFeePricePerMinute: null,
        taxRate: null,
        restrictions: null,
        reservationFeePerMinute: null,
        priority: 0,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      // Q1: existing tariffs for overlap check (empty = no overlap)
      // Q2: unset other defaults (isDefault=true because priority=0)
      // Q3: insert tariff
      setupDbResults([], [], [created]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Peak Rate',
          currency: 'USD',
          pricePerKwh: '0.35',
          pricePerMinute: '0.05',
          pricePerSession: '1.00',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe('Peak Rate');
      expect(body.pricingGroupId).toBe(VALID_GROUP_ID);
      expect(body.pricePerKwh).toBe('0.35');
    });

    it('creates a tariff with default currency when not provided', async () => {
      const created = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'Simple',
        currency: 'USD',
        pricePerKwh: '0.20',
        pricePerMinute: null,
        pricePerSession: null,
        isActive: true,
        idleFeePricePerMinute: null,
        taxRate: null,
        restrictions: null,
        reservationFeePerMinute: null,
        priority: 0,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      // Q1: existing tariffs, Q2: unset defaults, Q3: insert
      setupDbResults([], [], [created]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Simple', pricePerKwh: '0.20' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().currency).toBe('USD');
    });

    it('creates a tariff with only required fields', async () => {
      const created = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'Bare Minimum',
        currency: 'USD',
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        isActive: true,
        idleFeePricePerMinute: null,
        taxRate: null,
        restrictions: null,
        reservationFeePerMinute: null,
        priority: 0,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      // Q1: existing tariffs, Q2: unset defaults, Q3: insert
      setupDbResults([], [], [created]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Bare Minimum' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Bare Minimum');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { currency: 'USD' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when currency is not 3 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Bad Currency', currency: 'US' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when id param is invalid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups/invalid/tariffs',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Test', currency: 'USD' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- DELETE /v1/pricing-groups/:id ----------

  describe('DELETE /v1/pricing-groups/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when pricing group not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(res.json().error).toBe('Pricing group not found');
    });

    it('deletes a pricing group and its tariffs', async () => {
      const group = {
        id: VALID_GROUP_ID,
        name: 'To Delete',
        description: null,
        isDefault: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      // select group, count usage check (empty = no sessions), delete tariffs, delete group
      setupDbResults([group], [], [], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('returns 400 when id is invalid', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/pricing-groups/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- DELETE /v1/pricing-groups/:id/tariffs/:tariffId ----------

  describe('DELETE /v1/pricing-groups/:id/tariffs/:tariffId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when tariff not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TARIFF_NOT_FOUND');
      expect(res.json().error).toBe('Tariff not found');
    });

    it('deletes a tariff', async () => {
      const tariff = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'To Delete',
        currency: 'USD',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      // select tariff, count usage check (empty = no sessions), delete tariff
      setupDbResults([tariff], [], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('returns 400 when id param is invalid', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/not-a-nanoid/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when tariffId param is invalid', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/not-a-nanoid`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- PATCH /v1/pricing-groups/:id ----------

  describe('PATCH /v1/pricing-groups/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('updates a pricing group', async () => {
      const existing = {
        id: VALID_GROUP_ID,
        name: 'Old Name',
        description: null,
        isDefault: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const updated = { ...existing, name: 'New Name', updatedAt: '2024-06-01T00:00:00Z' };
      // Q1: select existing, Q2: update and return
      setupDbResults([existing], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'New Name' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('New Name');
    });

    it('returns 404 when pricing group not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
    });

    it('returns 400 when id is invalid', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/pricing-groups/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------- PATCH /v1/pricing-groups/:id/tariffs/:tariffId ----------

  describe('PATCH /v1/pricing-groups/:id/tariffs/:tariffId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('updates a tariff name', async () => {
      const existing = {
        id: VALID_TARIFF_ID,
        pricingGroupId: VALID_GROUP_ID,
        name: 'Old Rate',
        currency: 'USD',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: null,
        isActive: true,
        idleFeePricePerMinute: null,
        taxRate: null,
        restrictions: null,
        reservationFeePerMinute: null,
        priority: 0,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const updated = { ...existing, name: 'New Rate' };
      // Q1: select existing, Q2: existing tariffs for overlap, Q3: update and return
      setupDbResults([existing], [], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'New Rate' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('New Rate');
    });

    it('returns 404 when tariff not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/${VALID_TARIFF_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TARIFF_NOT_FOUND');
    });

    it('returns 400 when tariffId is invalid', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/pricing-groups/${VALID_GROUP_ID}/tariffs/not-a-nanoid`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
