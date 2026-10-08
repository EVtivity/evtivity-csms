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

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(() => Promise.resolve(state.siteIds)),
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
  supportCases,
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

  it('keeps support cases without a station visible to restricted users', async () => {
    setupDbResults([{ id: 'cas_1' }], [], []);
    const res = await get('/support-cases/cas_1/neighbors');
    expect(res.statusCode).toBe(200);
    const scope = currentScope() as { or: Array<Record<string, unknown>> };
    expect(scope.or[0]).toEqual({ isNull: supportCases.stationId });
    expect((scope.or[1] as { inArray: unknown[] }).inArray[0]).toBe(supportCases.stationId);
  });

  it('skips fleet invoices for restricted users', async () => {
    setupDbResults([{ id: 'inv_1' }], [{ id: 'inv_0' }], [{ id: 'inv_2' }]);
    const res = await get('/invoices/inv_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: 'inv_0', nextId: 'inv_2' });
    // The current, prev and next queries all leave fleet invoices out.
    expect(mainWheres()).toHaveLength(3);
    for (const where of mainWheres()) {
      expect(where.and[1]).toEqual({ isNull: invoices.fleetId });
    }
  });

  it('serves driver invoice neighbors to a restricted user with no site', async () => {
    state.siteIds = [];
    setupDbResults([{ id: 'inv_1' }], [], [{ id: 'inv_2' }]);
    const res = await get('/invoices/inv_1/neighbors');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prevId: null, nextId: 'inv_2' });
    expect(currentScope()).toEqual({ isNull: invoices.fleetId });
  });

  it('404s a fleet invoice for a restricted user as a missing invoice', async () => {
    setupDbResults([]);
    const res = await get('/invoices/inv_fleet/neighbors');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found', code: 'INVOICE_NOT_FOUND' });
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
