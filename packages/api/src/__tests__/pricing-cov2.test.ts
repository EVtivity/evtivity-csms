// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
import {
  resetSiteAccessMock,
  setMockStationSites,
  setMockUserSiteIds,
} from './helpers/site-access-mock.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Queue of results, one per awaited query chain, in call order.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
interface Chain {
  calls: Array<{ method: string; args: unknown[] }>;
  kind: string;
}
const chains: Chain[] = [];

function setupDbResults(...results: unknown[]) {
  dbResults = results;
  dbCallIndex = 0;
  chains.length = 0;
}

function makeChain(kind: string) {
  const rec: Chain = { calls: [], kind };
  chains.push(rec);
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
  ];
  for (const m of methods) {
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

const { executeMock, sqlCalls } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
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

vi.mock('../lib/pricing-events.js', () => ({
  publishPricingChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/database', () => {
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
    execute: executeMock,
  };
  // The default swap runs in a transaction on the same mocked chains.
  db['transaction'] = vi.fn((fn: (tx: unknown) => unknown) => fn(db));
  return {
    db,
    client: {},
    pricingGroups: { id: 'id', pricingGroupId: 'pricingGroupId', isDefault: 'isDefault' },
    tariffs: {
      id: 'id',
      pricingGroupId: 'pricingGroupId',
      isActive: 'isActive',
      priority: 'priority',
      isDefault: 'isDefault',
      restrictions: 'restrictions',
      createdAt: 'createdAt',
    },
    chargingSessions: { tariffId: 'tariffId' },
    sessionTariffSegments: { tariffId: 'tariffId' },
    pricingGroupAuditLog: { name: 'pricingGroupAuditLog' },
    tariffAuditLog: { name: 'tariffAuditLog' },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    resolveGroupTariffs: vi.fn(),
    getSystemTimezone: vi.fn(() => Promise.resolve('Europe/Berlin')),
    loadStationPricingChain: vi.fn(),
    pickFromChain: vi.fn(),
    getPricingHolidays: vi.fn(() => Promise.resolve([])),
    pgErrorCode: (err: unknown) => (err as { code?: string }).code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
    PG_UNIQUE_VIOLATION: '23505',
  };
});

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const node = { text: strings.join('?'), values };
    sqlCalls.push(node);
    return node;
  };
  sql.identifier = (name: string) => ({ identifier: name });
  sql.join = (parts: unknown[], sep: unknown) => ({ join: parts, sep });
  return {
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    and: vi.fn((...a: unknown[]) => ({ and: a })),
    ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
    sql,
    desc: vi.fn(),
    count: vi.fn(),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { pricingRoutes } from '../routes/pricing.js';
import {
  writeAudit,
  resolveGroupTariffs,
  loadStationPricingChain,
  pickFromChain,
  getSystemTimezone,
} from '@evtivity/database';
import { publishPricingChanged } from '../lib/pricing-events.js';

const GROUP_ID = 'pgr_000000000001';
const TARIFF_ID = 'trf_000000000001';
const STATION_ID = 'sta_000000000001';

function tariffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARIFF_ID,
    pricingGroupId: GROUP_ID,
    name: 'Standard',
    pricePerKwh: '0.30',
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
    ...overrides,
  };
}

const group = {
  id: GROUP_ID,
  name: 'Default',
  description: null,
  isDefault: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('pricing routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    pricingRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    sqlCalls.length = 0;
    executeMock.mockReset();
  });

  describe('DELETE /pricing-groups/:id', () => {
    it('returns 409 when a tariff of the group is used only by a session segment', async () => {
      setupDbResults([group], [{ count: 0 }], [{ count: 2 }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PRICING_GROUP_TARIFFS_IN_USE');
      expect(argsOf('delete', 'where')).toHaveLength(0);
    });

    it('maps a foreign key violation during the delete race to 409', async () => {
      const fkError = Object.assign(new Error('fk'), { code: '23503' });
      setupDbResults([group], [{ count: 0 }], [{ count: 0 }], [tariffRow()], fkError);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PRICING_GROUP_TARIFFS_IN_USE');
      expect(writeAudit).not.toHaveBeenCalled();
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });

    it('rethrows a delete error that is not a foreign key violation', async () => {
      const other = Object.assign(new Error('boom'), { code: '40001' });
      setupDbResults([group], [{ count: 0 }], [{ count: 0 }], [], other);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(500);
    });

    it('audits every cascaded tariff and the group, then publishes group.deleted', async () => {
      const t1 = tariffRow({ id: 'trf_000000000001' });
      const t2 = tariffRow({ id: 'trf_000000000002' });
      setupDbResults([group], [{ count: 0 }], [{ count: 0 }], [t1, t2], [], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      const audits = vi.mocked(writeAudit).mock.calls;
      expect(audits).toHaveLength(3);
      expect(audits[0]?.[1]).toMatchObject({
        entityId: 'trf_000000000001',
        action: 'deleted',
        notes: `cascade from pricing_group ${GROUP_ID}`,
        actorUserId: 'usr_1',
      });
      expect(audits[1]?.[1]).toMatchObject({ entityId: 'trf_000000000002', action: 'deleted' });
      expect(audits[2]?.[1]).toMatchObject({
        entityId: GROUP_ID,
        action: 'deleted',
        before: group,
      });
      expect(publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: GROUP_ID,
        action: 'group.deleted',
      });
    });
  });

  describe('GET /pricing/tariffs', () => {
    it('returns every tariff in a page envelope', async () => {
      setupDbResults([tariffRow(), tariffRow({ id: 'trf_000000000002', isDefault: false })]);
      const res = await app.inject({ method: 'GET', url: '/pricing/tariffs', headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data.map((t: { id: string }) => t.id)).toEqual([
        'trf_000000000001',
        'trf_000000000002',
      ]);
    });
  });

  describe('POST /pricing-groups/:id/tariffs', () => {
    const defaultRow = {
      id: TARIFF_ID,
      restrictions: null,
      priority: 0,
      isDefault: true,
      isActive: true,
    };

    it('creates a whole-day tariff from daysOfWeek without a timeRange', async () => {
      const created = tariffRow({
        id: 'trf_000000000002',
        restrictions: { daysOfWeek: [0, 6] },
        priority: 20,
        isDefault: false,
      });
      setupDbResults([defaultRow], [created]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: { name: 'Weekend', pricePerKwh: '0.20', restrictions: { daysOfWeek: [0, 6] } },
      });
      expect(res.statusCode).toBe(201);
      const values = argsOf('insert', 'values')[0]?.[0] as Record<string, unknown>;
      expect(values).toMatchObject({ priority: 20, isDefault: false });
      // No default swap for a restricted tariff.
      expect(argsOf('update', 'set')).toHaveLength(0);
    });

    it('returns 409 TARIFF_OVERLAP when a second default tariff is created', async () => {
      setupDbResults([defaultRow]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: { name: 'Another default', pricePerKwh: '0.40' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'TARIFF_OVERLAP',
        error: 'Only one default tariff allowed per group',
      });
    });

    it('refuses a restricted tariff in a group without a default (B2, TC-T3-01)', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: {
          name: 'Peak',
          pricePerKwh: '0.50',
          restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: 'TARIFF_DEFAULT_REQUIRED',
        error: 'A pricing group with tariffs needs one active default tariff without restrictions',
      });
      expect(argsOf('insert', 'values')).toHaveLength(0);
    });

    it('refuses isDefault on a restricted tariff (B2, TC-T3-02)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: {
          name: 'Night',
          pricePerKwh: '0.20',
          isDefault: true,
          restrictions: { timeRange: { startTime: '22:00', endTime: '06:00' } },
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: 'TARIFF_DEFAULT_REQUIRED',
        error: 'A tariff with restrictions cannot be the default tariff',
      });
    });

    it('refuses isDefault false on an active tariff without restrictions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: { name: 'Base', pricePerKwh: '0.30', isDefault: false },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARIFF_DEFAULT_REQUIRED');
    });

    it('creates the default in one transaction, clearing a stale default flag (B20)', async () => {
      const stale = {
        id: 'trf_000000000007',
        restrictions: { holidays: true },
        priority: 40,
        isDefault: true,
        isActive: true,
      };
      const created = tariffRow({ id: 'trf_000000000002' });
      setupDbResults([stale], [], [created]);
      const res = await app.inject({
        method: 'POST',
        url: `/pricing-groups/${GROUP_ID}/tariffs`,
        headers: auth,
        payload: { name: 'Base', pricePerKwh: '0.30' },
      });
      expect(res.statusCode).toBe(201);
      const sets = argsOf('update', 'set');
      expect(sets[0]?.[0]).toMatchObject({ isDefault: false });
      const values = argsOf('insert', 'values')[0]?.[0] as Record<string, unknown>;
      expect(values).toMatchObject({ priority: 0, isDefault: true, pricingGroupId: GROUP_ID });
      expect(publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: GROUP_ID,
        tariffId: 'trf_000000000002',
        action: 'tariff.created',
      });
    });
  });

  describe('PATCH /pricing-groups/:id/tariffs/:tariffId', () => {
    const url = `/pricing-groups/${GROUP_ID}/tariffs/${TARIFF_ID}`;

    it('returns 400 INVALID_RESTRICTIONS for an invalid time format', async () => {
      setupDbResults([tariffRow()]);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload: { restrictions: { timeRange: { startTime: '25:00', endTime: '06:00' } } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_RESTRICTIONS');
      expect(res.json().error).toContain('HH:MM');
    });

    const peakRow = {
      id: 'trf_000000000005',
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
      priority: 10,
      isDefault: false,
      isActive: true,
    };
    const selfDefault = {
      id: TARIFF_ID,
      restrictions: null,
      priority: 0,
      isDefault: true,
      isActive: true,
    };

    it('returns 409 TARIFF_OVERLAP when the new restriction collides with a holiday tariff', async () => {
      setupDbResults(
        [tariffRow({ isDefault: false, priority: 10 })],
        [
          { ...selfDefault, id: 'trf_000000000009' },
          { id: TARIFF_ID, restrictions: null, priority: 10, isDefault: false, isActive: true },
          {
            id: 'trf_000000000005',
            restrictions: { holidays: true },
            priority: 40,
            isDefault: false,
            isActive: true,
          },
        ],
      );
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload: { restrictions: { holidays: true } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'TARIFF_OVERLAP',
        error: 'Only one holiday tariff allowed per group',
      });
    });

    it('promotes an activated tariff without restrictions to default in one transaction (B20)', async () => {
      const existing = tariffRow({ isDefault: false, isActive: false, priority: 0 });
      const updated = tariffRow({ name: 'Renamed', isDefault: true });
      setupDbResults(
        [existing],
        [
          { id: TARIFF_ID, restrictions: null, priority: 0, isDefault: false, isActive: false },
          { ...peakRow, isDefault: true },
        ],
        [],
        [updated],
      );
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload: {
          name: 'Renamed',
          pricePerKwh: '0.25',
          pricePerMinute: null,
          pricePerSession: '1.00',
          isActive: true,
          idleFeePricePerMinute: '0.10',
          reservationFeePerMinute: '0.05',
          taxRate: '0.19',
          restrictions: null,
          isDefault: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Renamed');
      const sets = argsOf('update', 'set').map((a) => a[0] as Record<string, unknown>);
      expect(sets[0]).toMatchObject({ isDefault: false });
      expect(sets[1]).toMatchObject({
        name: 'Renamed',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: '1.00',
        isActive: true,
        idleFeePricePerMinute: '0.10',
        reservationFeePerMinute: '0.05',
        taxRate: '0.19',
        restrictions: null,
        priority: 0,
        isDefault: true,
      });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'updated',
        before: existing,
      });
      expect(publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: GROUP_ID,
        tariffId: TARIFF_ID,
        action: 'tariff.updated',
      });
    });

    it.each([
      ['deactivating', { isActive: false }],
      ['restricting', { restrictions: { timeRange: { startTime: '18:00', endTime: '20:00' } } }],
    ])('refuses %s the default while other tariffs are active (B2, TC-T3-04)', async (_n, body) => {
      setupDbResults([tariffRow()], [selfDefault, peakRow]);
      const res = await app.inject({ method: 'PATCH', url, headers: auth, payload: body });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARIFF_DEFAULT_REQUIRED');
      expect(argsOf('update', 'set')).toHaveLength(0);
    });

    it('deactivates the last active tariff of a group', async () => {
      setupDbResults(
        [tariffRow()],
        [selfDefault],
        [tariffRow({ isActive: false, isDefault: false })],
      );
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);
      const sets = argsOf('update', 'set').map((a) => a[0] as Record<string, unknown>);
      expect(sets[0]).toMatchObject({ isActive: false, isDefault: false });
    });

    it('refuses isDefault on a restricted tariff', async () => {
      setupDbResults([
        tariffRow({ isDefault: false, priority: 10, restrictions: peakRow.restrictions }),
      ]);
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload: { isDefault: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: 'TARIFF_DEFAULT_REQUIRED',
        error: 'A tariff with restrictions cannot be the default tariff',
      });
    });

    it('does not write isDefault or priority on an unrelated edit', async () => {
      setupDbResults([tariffRow()], [selfDefault], [tariffRow({ name: 'X' })]);
      const res = await app.inject({ method: 'PATCH', url, headers: auth, payload: { name: 'X' } });
      expect(res.statusCode).toBe(200);
      const sets = argsOf('update', 'set').map((a) => a[0] as Record<string, unknown>);
      expect(sets).toHaveLength(1);
      expect(sets[0]).not.toHaveProperty('isDefault');
      expect(sets[0]).not.toHaveProperty('priority');
    });
  });

  describe('DELETE /pricing-groups/:id/tariffs/:tariffId', () => {
    it('returns 409 TARIFF_IN_USE when a session references the tariff', async () => {
      setupDbResults([tariffRow()], [{ count: 3 }], [{ count: 0 }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}/tariffs/${TARIFF_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARIFF_IN_USE');
      expect(argsOf('delete', 'where')).toHaveLength(0);
    });

    it('refuses deleting the default while other tariffs are active (B2)', async () => {
      setupDbResults(
        [tariffRow()],
        [{ count: 0 }],
        [{ count: 0 }],
        [
          { id: TARIFF_ID, restrictions: null, priority: 0, isDefault: true, isActive: true },
          {
            id: 'trf_000000000005',
            restrictions: { holidays: true },
            priority: 40,
            isDefault: false,
            isActive: true,
          },
        ],
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}/tariffs/${TARIFF_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARIFF_DEFAULT_REQUIRED');
      expect(argsOf('delete', 'where')).toHaveLength(0);
    });

    it('deletes the default when it is the last active tariff', async () => {
      setupDbResults(
        [tariffRow()],
        [{ count: 0 }],
        [{ count: 0 }],
        [{ id: TARIFF_ID, restrictions: null, priority: 0, isDefault: true, isActive: true }],
        [],
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/pricing-groups/${GROUP_ID}/tariffs/${TARIFF_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(argsOf('delete', 'where')).toHaveLength(1);
    });
  });

  describe('POST /pricing-groups default conflict (B20)', () => {
    it('returns 409 PRICING_GROUP_DEFAULT_EXISTS when a default group exists', async () => {
      setupDbResults([{ id: 'pgr_000000000009' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: auth,
        payload: { name: 'Second default', isDefault: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: 'PRICING_GROUP_DEFAULT_EXISTS',
        error: 'Another pricing group is already the default',
      });
      expect(argsOf('insert', 'values')).toHaveLength(0);
    });

    it('maps the unique violation of a concurrent default create to 409', async () => {
      setupDbResults([], Object.assign(new Error('duplicate'), { code: '23505' }));
      const res = await app.inject({
        method: 'POST',
        url: '/pricing-groups',
        headers: auth,
        payload: { name: 'Racing default', isDefault: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PRICING_GROUP_DEFAULT_EXISTS');
    });
  });

  describe('GET /pricing-groups/:id/schedule', () => {
    it('returns 404 when the group does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${GROUP_ID}/schedule`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
    });

    it('sorts by priority and flags the current tariff', async () => {
      setupDbResults([group]);
      const base = tariffRow({ id: 'trf_000000000001', priority: 0, name: 'Base' });
      const night = tariffRow({ id: 'trf_000000000002', priority: 10, name: 'Night' });
      vi.mocked(resolveGroupTariffs).mockResolvedValueOnce({
        tariffs: [base, night],
        current: night,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-groups/${GROUP_ID}/schedule`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(getSystemTimezone).toHaveBeenCalled();
      const body = res.json<Array<{ name: string; isCurrent: boolean }>>();
      expect(body.map((t) => [t.name, t.isCurrent])).toEqual([
        ['Night', true],
        ['Base', false],
      ]);
      expect(vi.mocked(resolveGroupTariffs).mock.calls[0]?.[1]).toMatchObject({
        timezone: 'Europe/Berlin',
      });
    });
  });

  describe('GET /stations/:id/active-tariff', () => {
    const url = `/stations/${STATION_ID}/active-tariff`;

    it.each([
      ['another site', 'sit_000000000099'],
      ['no site', null],
    ])(
      'returns 404 STATION_NOT_FOUND to a site-restricted user for a station at %s',
      async (_label, siteId) => {
        setMockUserSiteIds(['sit_000000000001']);
        setMockStationSites({ [STATION_ID]: siteId });
        try {
          const res = await app.inject({ method: 'GET', url, headers: auth });
          expect(res.statusCode).toBe(404);
          expect(res.json().code).toBe('STATION_NOT_FOUND');
          expect(loadStationPricingChain).not.toHaveBeenCalled();
        } finally {
          resetSiteAccessMock();
        }
      },
    );

    it('returns 404 NO_PRICING_GROUP when the station has no pricing', async () => {
      vi.mocked(loadStationPricingChain).mockResolvedValueOnce([]);
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NO_PRICING_GROUP');
    });

    it('returns 404 NO_TARIFFS when no group has active tariffs', async () => {
      vi.mocked(loadStationPricingChain).mockResolvedValueOnce([
        { group: { id: GROUP_ID, name: 'Default' }, tariffs: [], timezone: 'UTC' },
      ] as never);
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NO_TARIFFS');
    });

    it('returns 404 NO_MATCHING_TARIFF when no tariff applies now', async () => {
      vi.mocked(loadStationPricingChain).mockResolvedValueOnce([
        { group: { id: GROUP_ID, name: 'Default' }, tariffs: [tariffRow()], timezone: 'UTC' },
      ] as never);
      vi.mocked(pickFromChain).mockReturnValueOnce(null);
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NO_MATCHING_TARIFF');
    });

    it('returns the tariff of the first group that has one, as billing (B2)', async () => {
      const t = tariffRow({ name: 'Peak' });
      const chain = [
        { group: { id: 'pgr_000000000002', name: 'Empty' }, tariffs: [], timezone: null },
        { group: { id: GROUP_ID, name: 'Public' }, tariffs: [t], timezone: 'America/New_York' },
      ];
      vi.mocked(loadStationPricingChain).mockResolvedValueOnce(chain as never);
      vi.mocked(pickFromChain).mockReturnValueOnce({ pricing: chain[1], tariff: t } as never);
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: TARIFF_ID,
        name: 'Peak',
        pricingGroupId: GROUP_ID,
        pricingGroupName: 'Public',
      });
      expect(vi.mocked(loadStationPricingChain).mock.calls[0]?.[0]).toEqual({
        stationUuid: STATION_ID,
        driverUuid: null,
      });
      expect(vi.mocked(pickFromChain).mock.calls[0]?.[0]).toBe(chain);
    });
  });

  describe('GET /pricing-audit', () => {
    function auditRow(overrides: Record<string, unknown> = {}) {
      return {
        id: '7',
        entity_type: 'tariff',
        entity_id: TARIFF_ID,
        action: 'updated',
        actor_user_id: 'usr_1',
        before: { a: 1 },
        after: { a: 2 },
        notes: null,
        created_at: '2024-05-01T10:00:00.000Z',
        ...overrides,
      };
    }

    it('maps rows across all four branches and returns the count', async () => {
      executeMock
        .mockResolvedValueOnce([
          auditRow(),
          auditRow({
            id: 8,
            entity_type: null,
            entity_id: null,
            action: null,
            actor_user_id: null,
            before: undefined,
            after: undefined,
            created_at: new Date('2024-05-02T00:00:00.000Z'),
          }),
          auditRow({ id: 9, created_at: null }),
        ])
        .mockResolvedValueOnce([{ total: 3 }]);
      const res = await app.inject({ method: 'GET', url: '/pricing-audit', headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data[0]).toMatchObject({
        id: 7,
        entityType: 'tariff',
        entityId: TARIFF_ID,
        action: 'updated',
        actorUserId: 'usr_1',
        before: { a: 1 },
        after: { a: 2 },
        notes: null,
        createdAt: '2024-05-01T10:00:00.000Z',
      });
      expect(body.data[1]).toMatchObject({
        id: 8,
        entityType: '',
        entityId: '',
        action: '',
        actorUserId: null,
        before: null,
        after: null,
        createdAt: '2024-05-02T00:00:00.000Z',
      });
      expect(typeof body.data[2].createdAt).toBe('string');
      const dataSql = executeMock.mock.calls[0]?.[0] as { values: unknown[] };
      const join = dataSql.values[0] as { join: unknown[] };
      expect(join.join).toHaveLength(4);
      // limit and offset for page 1 with the default page size
      expect(dataSql.values[2]).toBe(0);
    });

    it('builds only the matching branch when entityType and entityId are given', async () => {
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-audit?entityType=holiday&entityId=hol_1&page=2&limit=10`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      const dataSql = executeMock.mock.calls[0]?.[0] as { values: unknown[] };
      expect((dataSql.values[0] as { join: unknown[] }).join).toHaveLength(1);
      expect(dataSql.values[1]).toBe(10);
      expect(dataSql.values[2]).toBe(10);
      const entityFilter = sqlCalls.find((s) => s.values.includes('hol_1'));
      expect(entityFilter?.values).toEqual([
        { identifier: 'holiday_id' },
        'hol_1',
        { identifier: 'holiday_id_snapshot' },
        'hol_1',
      ]);
    });

    it('limits a pricingGroupId filter to the group and tariff branches', async () => {
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-audit?pricingGroupId=${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const dataSql = executeMock.mock.calls[0]?.[0] as { values: unknown[] };
      expect((dataSql.values[0] as { join: unknown[] }).join).toHaveLength(2);
      const anyFilter = sqlCalls.find((s) => s.text.includes('= ANY('));
      expect(anyFilter?.values[0]).toEqual({ identifier: 'tariff_id_snapshot' });
    });

    it('returns an empty page without querying when no branch applies', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-audit?entityType=holiday&pricingGroupId=${GROUP_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(executeMock).not.toHaveBeenCalled();
    });
  });
});
