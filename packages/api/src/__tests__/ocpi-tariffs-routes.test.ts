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
  pricingGroups: {},
  ocpiPartners: {},
}));

const { publishOcpiTariffPush } = vi.hoisted(() => ({ publishOcpiTariffPush: vi.fn() }));
vi.mock('../lib/ocpi-tariff-push.js', () => ({ publishOcpiTariffPush }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
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
    pricingGroupId: null,
    partnerId: 'opr_000000000001',
    ocpiTariffId: 'TARIFF-001',
    createdAt: now,
    updatedAt: now,
    tariffName: 'Standard Rate',
    pricingGroupName: null,
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
    publishOcpiTariffPush.mockClear();
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

  // -------------------------------------------------------
  // POST /v1/ocpi/tariff-mappings
  // -------------------------------------------------------

  describe('POST /v1/ocpi/tariff-mappings', () => {
    function post(payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    it('publishes a pricing group to every partner and pushes it', async () => {
      const mapping = makeMapping({
        id: 5,
        tariffId: null,
        pricingGroupId: 'pgr_000000000001',
        partnerId: null,
        tariffName: null,
        pricingGroupName: 'Default',
        partnerName: null,
      });
      // pricing group exists, id free, insert, reload
      setupDbResults([{ id: 'pgr_000000000001' }], [], [{ id: 5 }], [mapping]);

      const res = await post({ ocpiTariffId: 'TARIFF-001', pricingGroupId: 'pgr_000000000001' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ pricingGroupId: 'pgr_000000000001', tariffId: null });
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [{ partnerId: null, ocpiTariffId: 'TARIFF-001' }],
      });
    });

    it('rejects a mapping without a source or with both', async () => {
      for (const payload of [
        { ocpiTariffId: 'T-1' },
        {
          ocpiTariffId: 'T-1',
          tariffId: 'trf_000000000001',
          pricingGroupId: 'pgr_000000000001',
        },
      ]) {
        const res = await post(payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(res.json().details).toHaveProperty('source');
      }
      expect(publishOcpiTariffPush).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown tariff', async () => {
      setupDbResults([]);
      const res = await post({ ocpiTariffId: 'T-1', tariffId: 'trf_000000000099' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TARIFF_NOT_FOUND');
    });

    it('rejects an OCPI tariff id already published to the same partner', async () => {
      setupDbResults([{ id: 'trf_000000000001' }], [{ id: 2 }]);
      const res = await post({ ocpiTariffId: 'T-1', tariffId: 'trf_000000000001' });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toHaveProperty('ocpiTariffId');
    });

    it('ignores the removed free-form ocpiTariffData field', async () => {
      setupDbResults([{ id: 'trf_000000000001' }], [], [{ id: 6 }], [makeMapping({ id: 6 })]);
      const res = await post({
        ocpiTariffId: 'T-1',
        tariffId: 'trf_000000000001',
        ocpiTariffData: { elements: [] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty('ocpiTariffData');
    });
  });

  // -------------------------------------------------------
  // PATCH /v1/ocpi/tariff-mappings/:id
  // -------------------------------------------------------

  describe('PATCH /v1/ocpi/tariff-mappings/:id', () => {
    it('switches to a pricing group and resyncs the old and new ids', async () => {
      const existing = {
        id: 1,
        tariffId: 'trf_000000000001',
        pricingGroupId: null,
        partnerId: null,
        ocpiTariffId: 'OLD-1',
      };
      // existing, group exists, id free, update, reload
      setupDbResults(
        [existing],
        [{ id: 'pgr_000000000001' }],
        [],
        [],
        [
          makeMapping({
            tariffId: null,
            pricingGroupId: 'pgr_000000000001',
            ocpiTariffId: 'NEW-1',
          }),
        ],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: { authorization: `Bearer ${token}` },
        payload: { pricingGroupId: 'pgr_000000000001', ocpiTariffId: 'NEW-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [
          { partnerId: null, ocpiTariffId: 'NEW-1' },
          { partnerId: null, ocpiTariffId: 'OLD-1' },
        ],
      });
    });

    it('returns 404 for an unknown mapping', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/9',
        headers: { authorization: `Bearer ${token}` },
        payload: { ocpiTariffId: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------
  // DELETE /v1/ocpi/tariff-mappings/:id
  // -------------------------------------------------------

  describe('DELETE /v1/ocpi/tariff-mappings/:id', () => {
    it('deletes the mapping and asks the OCPI server to resync its id', async () => {
      setupDbResults([{ partnerId: 'opr_000000000001', ocpiTariffId: 'T-1' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/ocpi/tariff-mappings/1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [{ partnerId: 'opr_000000000001', ocpiTariffId: 'T-1' }],
      });
    });

    it('returns 404 for an unknown mapping', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/ocpi/tariff-mappings/9',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
