// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The city, connector type, Plug and Charge and free vend dashboard routes
// against a mocked database: permission, site scope, ordering and the
// company-wide contract count rule. The SQL itself (case folding, retired
// EVSEs, the Plug and Charge token rule) runs in the integration test
// 143-dashboard-layout-and-charts.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  index: 0,
  selects: 0,
  permissions: new Set<string>(['dashboard:read', 'drivers:read']),
}));

function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  db: {
    select: vi.fn(() => {
      state.selects++;
      return makeChain();
    }),
  },
  chargingStations: {},
  chargingSessions: {},
  connectors: {},
  evses: {},
  sites: {},
  paymentRecords: {},
  pncContracts: {},
  client: {},
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getOcppFleetHealth: vi.fn(),
  getSystemTimezone: vi.fn().mockResolvedValue('UTC'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(
    vi.fn(() => ({ mapWith: vi.fn() })),
    { raw: vi.fn() },
  ),
  count: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (...required: string[]) =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      if (required.some((p) => !state.permissions.has(p))) {
        await reply.status(403).send({ code: 'INSUFFICIENT_PERMISSIONS' });
      }
    },
  invalidatePermissionCache: vi.fn(),
  requestHasPermission: (_request: unknown, permission: string) =>
    Promise.resolve(state.permissions.has(permission)),
}));

import { registerAuth } from '../plugins/auth.js';
import { dashboardRoutes, LOCATIONS_BY_CITY_LIMIT } from '../routes/dashboard.js';
import { getUserSiteIds } from '../lib/site-access.js';

const siteIdsMock = getUserSiteIds as ReturnType<typeof vi.fn>;

function results(...rows: unknown[][]): void {
  state.results = rows;
  state.index = 0;
}

describe('new dashboard charts', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    dashboardRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results();
    state.selects = 0;
    state.permissions = new Set(['dashboard:read', 'drivers:read']);
    siteIdsMock.mockResolvedValue(null);
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const ROUTES = [
    '/dashboard/locations-by-city',
    '/dashboard/evses-by-connector-type',
    '/dashboard/plug-and-charge',
    '/dashboard/free-vend',
  ];

  it('needs dashboard:read on every route', async () => {
    state.permissions = new Set(['stations:read']);
    for (const url of ROUTES) {
      expect((await get(url)).statusCode).toBe(403);
    }
  });

  it('answers empty without a query for a user with no site', async () => {
    siteIdsMock.mockResolvedValue([]);
    const city = await get('/dashboard/locations-by-city');
    expect(city.json()).toEqual({ cities: [], other: { siteCount: 0, stationCount: 0 } });
    expect((await get('/dashboard/evses-by-connector-type')).json()).toEqual([]);
    const pnc = (await get('/dashboard/plug-and-charge?days=2')).json();
    expect(pnc.days).toHaveLength(3);
    expect(pnc.totals).toEqual({ sessionCount: 0, energyWh: 0 });
    expect(pnc.activeContracts).toBeNull();
    const free = (await get('/dashboard/free-vend?days=2')).json();
    expect(free.freeVendSiteCount).toBe(0);
    expect(state.selects).toBe(0);
  });

  it('orders cities by stations then sites, keeps the null city and sums the rest', async () => {
    const rows = [
      { city: 'Berlin', siteCount: 1, stationCount: 2 },
      { city: null, siteCount: 2, stationCount: 2 },
      { city: 'Austin', siteCount: 3, stationCount: 9 },
      ...Array.from({ length: LOCATIONS_BY_CITY_LIMIT }, (_, i) => ({
        city: `Town ${String(i).padStart(2, '0')}`,
        siteCount: 1,
        stationCount: 1,
      })),
    ];
    results(rows);
    const body = (await get('/dashboard/locations-by-city')).json();
    expect(body.cities).toHaveLength(LOCATIONS_BY_CITY_LIMIT);
    expect(body.cities.slice(0, 3)).toEqual([
      { city: 'Austin', siteCount: 3, stationCount: 9 },
      { city: null, siteCount: 2, stationCount: 2 },
      { city: 'Berlin', siteCount: 1, stationCount: 2 },
    ]);
    // 20 towns of 1 and 1: 17 listed, 3 summed.
    expect(body.other).toEqual({ siteCount: 3, stationCount: 3 });
  });

  it('lists connector types by EVSE count', async () => {
    results([
      { connectorType: 'type2', evseCount: 1, connectorCount: 1 },
      { connectorType: 'ccs2', evseCount: 4, connectorCount: 5 },
    ]);
    const body = (await get('/dashboard/evses-by-connector-type')).json();
    expect(body.map((r: { connectorType: string }) => r.connectorType)).toEqual(['ccs2', 'type2']);
  });

  it('fills every day of the Plug and Charge range and counts contracts for all-site users with drivers:read', async () => {
    const today = new Date().toISOString().slice(0, 10);
    results([{ date: today, sessionCount: 2, energyWh: 3000 }], [{ count: 5 }]);
    const body = (await get('/dashboard/plug-and-charge?days=6')).json();
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toEqual({ date: today, sessionCount: 2, energyWh: 3000 });
    expect(body.totals).toEqual({ sessionCount: 2, energyWh: 3000 });
    expect(body.activeContracts).toBe(5);
  });

  it('gives no contract count to a site-restricted user or a user without drivers:read', async () => {
    siteIdsMock.mockResolvedValue(['sit_a']);
    results([]);
    expect((await get('/dashboard/plug-and-charge')).json().activeContracts).toBeNull();
    expect(state.selects).toBe(1);

    siteIdsMock.mockResolvedValue(null);
    state.permissions = new Set(['dashboard:read']);
    state.selects = 0;
    results([]);
    expect((await get('/dashboard/plug-and-charge')).json().activeContracts).toBeNull();
    expect(state.selects).toBe(1);
  });

  it('returns free vend days, totals and the free vend site count', async () => {
    const today = new Date().toISOString().slice(0, 10);
    results([{ date: today, sessionCount: 1, energyWh: 500 }], [{ count: 2 }]);
    const body = (await get('/dashboard/free-vend?days=1')).json();
    expect(body.days).toHaveLength(2);
    expect(body.totals).toEqual({ sessionCount: 1, energyWh: 500 });
    expect(body.freeVendSiteCount).toBe(2);
  });

  it('refuses an invalid date range', async () => {
    for (const url of ['/dashboard/plug-and-charge?days=0', '/dashboard/free-vend?from=x&to=y']) {
      expect((await get(url)).statusCode).toBe(400);
    }
  });
});
