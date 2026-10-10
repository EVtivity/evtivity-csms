// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, inArrayMock, isNullMock, orMock, andMock, eqMock } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0, siteIds: null as string[] | null },
  inArrayMock: vi.fn((col: unknown, values: unknown) => ({ inArray: [col, values] })),
  isNullMock: vi.fn((col: unknown) => ({ isNull: col })),
  orMock: vi.fn((...parts: unknown[]) => ({ or: parts })),
  andMock: vi.fn((...parts: unknown[]) => ({ and: parts })),
  eqMock: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
}));

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

const whereArgs: unknown[] = [];

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn((cond: unknown) => {
    whereArgs.push(cond);
    return chain;
  });
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
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

vi.mock('../lib/support-case-scope.js', () => ({
  supportCaseSiteCondition: vi.fn((siteIds: string[]) => ({ supportCaseSiteCondition: siteIds })),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(state.siteIds)),
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => unknown } },
      notFound: unknown,
    ) => {
      if (state.siteIds == null) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
}));

vi.mock('@evtivity/database', () => {
  const fakeTable = (name: string) => {
    const table = { _name: name };
    return { id: { name: 'id', table }, createdAt: { name: 'created_at', table } };
  };
  return {
    db: { select: vi.fn(() => makeChain()) },
    sites: fakeTable('sites'),
    chargingStations: { ...fakeTable('charging_stations'), siteId: { name: 'site_id' } },
    chargingSessions: { ...fakeTable('charging_sessions'), stationId: { name: 'station_id' } },
    drivers: fakeTable('drivers'),
    fleets: fakeTable('fleets'),
    users: fakeTable('users'),
    driverTokens: fakeTable('driver_tokens'),
    reservations: { ...fakeTable('reservations'), stationId: { name: 'rsv_station_id' } },
    invoices: { ...fakeTable('invoices'), fleetId: { name: 'fleet_id' } },
    supportCases: { ...fakeTable('support_cases'), stationId: { name: 'case_station_id' } },
    pricingGroups: fakeTable('pricing_groups'),
    ocpiPartners: fakeTable('ocpi_partners'),
    configTemplates: fakeTable('config_templates'),
    chargingProfileTemplates: fakeTable('charging_profile_templates'),
    firmwareCampaigns: fakeTable('firmware_campaigns'),
    octtRuns: fakeTable('octt_runs'),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: eqMock,
  and: andMock,
  or: orMock,
  sql: vi.fn(() => ({ sql: true })),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  inArray: inArrayMock,
  isNull: isNullMock,
}));

import { registerAuth } from '../plugins/auth.js';
import { entityNeighborRoutes } from '../routes/entity-neighbors.js';
import {
  chargingSessions,
  chargingStations,
  invoices,
  reservations,
  sites,
} from '@evtivity/database';

describe('entity neighbor site scoping (cov2)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    entityNeighborRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_test', roleId: 'rol_test' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    state.siteIds = ['sit_a', 'sit_b'];
    whereArgs.length = 0;
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  /** WHERE conditions of the three neighbor queries (current, prev, next), not the subqueries. */
  const mainWheres = (): Array<{ and: unknown[] }> =>
    whereArgs.filter(
      (w): w is { and: unknown[] } => typeof w === 'object' && w != null && 'and' in w,
    );
  /** The scope condition the current-row query was filtered with. */
  const currentScope = (): unknown => mainWheres()[0]?.and[1];

  it('limits sites to the allowed site ids', async () => {
    setupDbResults([{ id: 'sit_a' }], [{ id: 'sit_new' }], []);
    const res = await get('/sites/sit_a/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'sit_new', nextId: null });
    expect(currentScope()).toEqual({ inArray: [sites.id, ['sit_a', 'sit_b']] });
  });

  it('limits sessions to stations at the allowed sites', async () => {
    setupDbResults([{ id: 'ses_1' }], [], [{ id: 'ses_old' }]);
    const res = await get('/sessions/ses_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: null, nextId: 'ses_old' });
    const scope = currentScope() as { inArray: [unknown, unknown] };
    expect(scope.inArray[0]).toBe(chargingSessions.stationId);
    expect(inArrayMock).toHaveBeenCalledWith(chargingStations.siteId, ['sit_a', 'sit_b']);
    // Prev and next queries carry the same scope.
    expect(mainWheres()).toHaveLength(3);
    expect(mainWheres()[1]?.and[1]).toBe(scope);
    expect(mainWheres()[2]?.and[1]).toBe(scope);
  });

  it('limits reservations to stations at the allowed sites', async () => {
    setupDbResults([{ id: 'rsv_1' }], [{ id: 'rsv_0' }], [{ id: 'rsv_2' }]);
    const res = await get('/reservations/rsv_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'rsv_0', nextId: 'rsv_2' });
    const scope = currentScope() as { inArray: [unknown, unknown] };
    expect(scope.inArray[0]).toBe(reservations.stationId);
    expect(inArrayMock).toHaveBeenCalledWith(chargingStations.siteId, ['sit_a', 'sit_b']);
  });

  it('pages support cases with the case list visibility (supportCaseSiteCondition)', async () => {
    setupDbResults([{ id: 'cas_1' }], [], []);
    const res = await get('/support-cases/cas_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(currentScope()).toEqual({ supportCaseSiteCondition: state.siteIds });
  });

  it.each([
    ['assigned to some sites', ['sit_a']],
    ['assigned to no site', []],
  ])('404s every invoice for a restricted user %s', async (_label, ids) => {
    state.siteIds = ids;
    setupDbResults([{ id: 'inv_1' }], [{ id: 'inv_0' }], [{ id: 'inv_2' }]);
    const res = await get('/invoices/inv_1/neighbors');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found', code: 'INVOICE_NOT_FOUND' });
    expect(mainWheres()).toHaveLength(0);
  });

  it('does not scope invoices for unrestricted users', async () => {
    state.siteIds = null;
    isNullMock.mockClear();
    setupDbResults([{ id: 'inv_1' }], [{ id: 'inv_fleet' }], []);
    const res = await get('/invoices/inv_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'inv_fleet', nextId: null });
    expect(mainWheres()).toHaveLength(0);
    expect(isNullMock).not.toHaveBeenCalledWith(invoices.fleetId);
  });

  it('404s a scoped session the user cannot see', async () => {
    setupDbResults([]);
    const res = await get('/sessions/ses_other/neighbors');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found', code: 'SESSION_NOT_FOUND' });
  });

  it('does not scope unrestricted users and serializes integer ids as strings', async () => {
    state.siteIds = null;
    setupDbResults([{ id: 7 }], [{ id: 8 }], [{ id: 6 }]);
    const res = await get('/octt/runs/7/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: '8', nextId: '6' });
    // The integer id is parsed before the lookup, and no scope is added.
    expect(whereArgs[0]).toEqual({ eq: [expect.anything(), 7] });
  });
});
