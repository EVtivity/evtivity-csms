// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[] = [];
let dbCallIndex = 0;
interface Chain {
  kind: string;
  calls: Array<{ method: string; args: unknown[] }>;
}
const chains: Chain[] = [];

function setupDbResults(...results: unknown[]) {
  dbResults = results;
  dbCallIndex = 0;
  chains.length = 0;
}

function makeChain(kind: string) {
  const rec: Chain = { kind, calls: [] };
  chains.push(rec);
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'leftJoin',
    'values',
    'returning',
    'set',
  ]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      rec.calls.push({ method: m, args });
      return chain;
    });
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r ?? []).then(resolve, reject);
  };
  return chain;
}

function argsOf(kind: string, method: string): unknown[][] {
  return chains
    .filter((c) => c.kind === kind)
    .flatMap((c) => c.calls.filter((x) => x.method === method).map((x) => x.args));
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
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  },
  ocpiTariffMappings: { id: 'm.id', partnerId: 'm.partnerId', ocpiTariffId: 'm.ocpiTariffId' },
  tariffs: { id: 't.id' },
  pricingGroups: { id: 'g.id' },
  ocpiPartners: { id: 'p.id' },
  pgErrorCode: (err: unknown) => (err as { code?: string }).code,
  PG_UNIQUE_VIOLATION: '23505',
}));

const { publishOcpiTariffPush } = vi.hoisted(() => ({
  publishOcpiTariffPush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/ocpi-tariff-push.js', () => ({ publishOcpiTariffPush }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  sql: vi.fn(() => ({ sql: true })),
  desc: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { ocpiTariffRoutes } from '../routes/ocpi-tariffs.js';

const GROUP_ID = 'pgr_000000000001';
const TARIFF_ID = 'trf_000000000001';
const PARTNER_ID = 'opr_000000000001';
const now = '2024-01-01T00:00:00.000Z';

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ocpiTariffId: 'T-1',
    partnerId: null,
    tariffId: TARIFF_ID,
    pricingGroupId: null,
    createdAt: now,
    updatedAt: now,
    tariffName: 'Std',
    pricingGroupName: null,
    partnerName: null,
    ...overrides,
  };
}

const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' });

describe('OCPI tariff mapping routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocpiTariffRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  describe('GET /ocpi/tariff-mappings', () => {
    it('filters by partner and pages the result', async () => {
      setupDbResults([mapping({ partnerId: PARTNER_ID })], [{ count: 11 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/ocpi/tariff-mappings?partnerId=${PARTNER_ID}&page=2&limit=10`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 11, data: [{ id: 1, partnerId: PARTNER_ID }] });
      expect(argsOf('select', 'where').map((a) => a[0])).toEqual([
        { eq: ['m.partnerId', PARTNER_ID] },
        { eq: ['m.partnerId', PARTNER_ID] },
      ]);
      expect(argsOf('select', 'offset')[0]?.[0]).toBe(10);
    });

    it('lists every mapping without a partner filter and defaults the total to 0', async () => {
      setupDbResults([], []);
      const res = await app.inject({ method: 'GET', url: '/ocpi/tariff-mappings', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(argsOf('select', 'where')[0]?.[0]).toBeUndefined();
    });
  });

  describe('POST /ocpi/tariff-mappings', () => {
    it('returns 404 PRICING_GROUP_NOT_FOUND for an unknown group', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: auth,
        payload: { ocpiTariffId: 'T-1', pricingGroupId: GROUP_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
    });

    it('returns 404 PARTNER_NOT_FOUND for an unknown partner', async () => {
      setupDbResults([{ id: GROUP_ID }], []);
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: auth,
        payload: { ocpiTariffId: 'T-1', pricingGroupId: GROUP_ID, partnerId: PARTNER_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PARTNER_NOT_FOUND');
    });

    it('maps a concurrent unique violation on insert to 400', async () => {
      setupDbResults([{ id: GROUP_ID }], [{ id: PARTNER_ID }], [], uniqueViolation());
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: auth,
        payload: { ocpiTariffId: 'T-1', pricingGroupId: GROUP_ID, partnerId: PARTNER_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { ocpiTariffId: 'This OCPI tariff id is already published to this partner' },
      });
      expect(publishOcpiTariffPush).not.toHaveBeenCalled();
    });

    it('returns 500 when the insert returns no row', async () => {
      setupDbResults([{ id: TARIFF_ID }], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: auth,
        payload: { ocpiTariffId: 'T-1', tariffId: TARIFF_ID },
      });
      expect(res.statusCode).toBe(500);
      expect(publishOcpiTariffPush).not.toHaveBeenCalled();
    });

    it('checks the id against mappings for every partner when no partner is given', async () => {
      setupDbResults([{ id: GROUP_ID }], [], [{ id: 5 }], [mapping({ id: 5 })]);
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/tariff-mappings',
        headers: auth,
        payload: { ocpiTariffId: 'T-9', pricingGroupId: GROUP_ID },
      });
      expect(res.statusCode).toBe(201);
      const takenWhere = argsOf('select', 'where')[1]?.[0] as { and: unknown[] };
      expect(takenWhere.and).toEqual([
        { eq: ['m.ocpiTariffId', 'T-9'] },
        { isNull: 'm.partnerId' },
      ]);
      expect(argsOf('insert', 'values')[0]?.[0]).toEqual({
        ocpiTariffId: 'T-9',
        partnerId: null,
        tariffId: null,
        pricingGroupId: GROUP_ID,
      });
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [{ partnerId: null, ocpiTariffId: 'T-9' }],
      });
    });
  });

  describe('PATCH /ocpi/tariff-mappings/:id', () => {
    it('switches the source to a pricing group and clears the tariff', async () => {
      setupDbResults([mapping()], [{ id: GROUP_ID }], [], [], [mapping({ tariffId: null })]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { pricingGroupId: GROUP_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(argsOf('update', 'set')[0]?.[0]).toMatchObject({
        ocpiTariffId: 'T-1',
        partnerId: null,
        tariffId: null,
        pricingGroupId: GROUP_ID,
      });
      // id and partner scope unchanged: only the current target is pushed
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [{ partnerId: null, ocpiTariffId: 'T-1' }],
      });
    });

    it('returns 400 when both a tariff and a pricing group are sent', async () => {
      setupDbResults([mapping()]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { tariffId: TARIFF_ID, pricingGroupId: GROUP_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({
        source: 'Select exactly one internal tariff or pricing group',
      });
    });

    it('switches to a tariff and pushes the old partner scope too', async () => {
      const existing = mapping({ tariffId: null, pricingGroupId: GROUP_ID, partnerId: null });
      setupDbResults([existing], [{ id: TARIFF_ID }], [{ id: PARTNER_ID }], [], [], [mapping()]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { tariffId: TARIFF_ID, partnerId: PARTNER_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(argsOf('update', 'set')[0]?.[0]).toMatchObject({
        partnerId: PARTNER_ID,
        tariffId: TARIFF_ID,
        pricingGroupId: null,
      });
      expect(publishOcpiTariffPush).toHaveBeenCalledWith({
        targets: [
          { partnerId: PARTNER_ID, ocpiTariffId: 'T-1' },
          { partnerId: null, ocpiTariffId: 'T-1' },
        ],
      });
    });

    it('returns 404 TARIFF_NOT_FOUND for an unknown tariff', async () => {
      setupDbResults([mapping()], []);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { tariffId: 'trf_000000000009' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TARIFF_NOT_FOUND');
    });

    it('returns 400 when another mapping already holds the new id', async () => {
      setupDbResults([mapping()], [{ id: 2 }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { ocpiTariffId: 'T-2' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(argsOf('update', 'set')).toHaveLength(0);
    });

    it('maps a concurrent unique violation on update to 400', async () => {
      setupDbResults([mapping()], [{ id: 1 }], uniqueViolation());
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { ocpiTariffId: 'T-2' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({
        ocpiTariffId: 'This OCPI tariff id is already published to this partner',
      });
      expect(publishOcpiTariffPush).not.toHaveBeenCalled();
    });

    it('rethrows an update error that is not a unique violation', async () => {
      setupDbResults([mapping()], [], Object.assign(new Error('x'), { code: '40001' }));
      const res = await app.inject({
        method: 'PATCH',
        url: '/ocpi/tariff-mappings/1',
        headers: auth,
        payload: { ocpiTariffId: 'T-2' },
      });
      expect(res.statusCode).toBe(500);
    });
  });
});
