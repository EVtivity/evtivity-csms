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
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
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
  chargingStations: { id: 'stations.id', siteId: 'stations.siteId', isOnline: 'stations.isOnline' },
  chargingSessions: {
    startedAt: 'sessions.startedAt',
    endedAt: 'sessions.endedAt',
    stationId: 'sessions.stationId',
    status: 'sessions.status',
  },
  connectors: {},
  evses: {},
  sites: { id: 'sites.id' },
  reservations: { id: 'reservations.id' },
  settings: {},
  paymentRecords: {},
  ocppServerHealth: {},
  dashboardSnapshots: {},
  getSystemTimezone: vi.fn().mockResolvedValue('America/New_York'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(
    vi.fn(() => ({ mapWith: vi.fn() })),
    { raw: vi.fn(), join: vi.fn() },
  ),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn((col: unknown) => (typeof col === 'string' ? col : 'unnamed')),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
  isNotNull: vi.fn(),
}));

const { mockDerivedStatus } = vi.hoisted(() => ({
  mockDerivedStatus: vi.fn(() => ({ __derivedStatus: true })),
}));

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: mockDerivedStatus,
}));

const { mockQueryRevenue } = vi.hoisted(() => ({ mockQueryRevenue: vi.fn() }));

vi.mock('@evtivity/services/session-revenue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryRevenue: (input: unknown) => mockQueryRevenue(input),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
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

import { registerAuth } from '../plugins/auth.js';
import { dashboardRoutes } from '../routes/dashboard.js';
import { db } from '@evtivity/database';
import { inArray, lte, sql } from 'drizzle-orm';
import rateLimit from '@fastify/rate-limit';
import { getUserSiteIds } from '../lib/site-access.js';

const getUserSiteIdsMock = getUserSiteIds as ReturnType<typeof vi.fn>;

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  dashboardRoutes(app);
  await app.ready();
  return app;
}

const SITE = 'sit_000000000001';
const RANGE = 'from=2025-01-01&to=2025-01-10';

describe('dashboard routes - site scoping and date ranges', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    headers = {
      authorization: `Bearer ${app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    getUserSiteIdsMock.mockResolvedValue(null);
    mockQueryRevenue.mockResolvedValue(new Map());
    vi.mocked(db.execute).mockResolvedValue([] as never);
  });

  describe('an operator without any site gets empty data without a query', () => {
    const cases: Array<[string, unknown]> = [
      [
        '/dashboard/stats',
        {
          totalStations: 0,
          onlineStations: 0,
          onlinePercent: 0,
          activeSessions: 0,
          totalSessions: 0,
          totalEnergyWh: 0,
          faultedStations: 0,
          statusCounts: {},
          onboardingStatusCounts: {},
        },
      ],
      ['/dashboard/energy-history', []],
      ['/dashboard/session-history', []],
      ['/dashboard/station-status', []],
      ['/dashboard/utilization', []],
      ['/dashboard/peak-usage', []],
      ['/dashboard/revenue-history', []],
      ['/dashboard/payment-breakdown', []],
      ['/dashboard/uptime', { uptimePercent: 100, totalPorts: 0, stationsBelowThreshold: 0 }],
      [
        '/dashboard/ocpp-health',
        {
          connectedStations: 0,
          avgPingLatencyMs: 0,
          maxPingLatencyMs: 0,
          pingSuccessRate: 100,
          totalPingsSent: 0,
          totalPongsReceived: 0,
          serverStartedAt: null,
          updatedAt: null,
        },
      ],
      ['/dashboard/site-locations', []],
      ['/dashboard/snapshots/trend', { days: [] }],
      ['/dashboard/snapshots/available-dates', []],
      [
        '/dashboard/carbon-stats',
        { totalCo2AvoidedKg: 0, sessionCount: 0, avgCo2AvoidedKgPerSession: 0 },
      ],
    ];
    for (const [url, expected] of cases) {
      it(`GET ${url}`, async () => {
        getUserSiteIdsMock.mockResolvedValue([]);
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expected);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.execute).not.toHaveBeenCalled();
      });
    }

    it('GET /dashboard/financial-stats returns zeros in the company currency', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/dashboard/financial-stats', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        totalRevenueCents: 0,
        totalProfitCents: 0,
        currency: 'EUR',
      });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('GET /dashboard/snapshots returns the empty snapshot', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/snapshots?date=2025-01-01',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ hasData: false, totalStations: 0, pingSuccessRate: 100 });
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('a site-restricted operator gets data filtered to its sites', () => {
    const selectRoutes = [
      '/dashboard/stats',
      `/dashboard/energy-history?${RANGE}`,
      `/dashboard/session-history?${RANGE}`,
      '/dashboard/station-status',
      `/dashboard/utilization?${RANGE}`,
      `/dashboard/peak-usage?${RANGE}`,
      '/dashboard/financial-stats',
      '/dashboard/ocpp-health',
      '/dashboard/site-locations',
      '/dashboard/carbon-stats?from=2025-01-01&to=2025-01-31',
    ];
    for (const url of selectRoutes) {
      it(`GET ${url} filters with the user site ids`, async () => {
        getUserSiteIdsMock.mockResolvedValue([SITE]);
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(200);
        expect(inArray).toHaveBeenCalledWith(expect.any(String), [SITE]);
      });
    }

    it('GET /dashboard/energy-history and session-history bound the range with lte', async () => {
      const a = await app.inject({
        method: 'GET',
        url: `/dashboard/energy-history?${RANGE}`,
        headers,
      });
      const b = await app.inject({
        method: 'GET',
        url: `/dashboard/session-history?${RANGE}`,
        headers,
      });
      const c = await app.inject({ method: 'GET', url: `/dashboard/peak-usage?${RANGE}`, headers });
      const d = await app.inject({
        method: 'GET',
        url: `/dashboard/utilization?${RANGE}`,
        headers,
      });
      expect([a.statusCode, b.statusCode, c.statusCode, d.statusCode]).toEqual([
        200, 200, 200, 200,
      ]);
      expect(lte).toHaveBeenCalledTimes(4);
      // The range end is the last millisecond of the "to" day (parseDateRange).
      const end = new Date('2025-01-10');
      end.setHours(23, 59, 59, 999);
      expect(lte).toHaveBeenCalledWith('sessions.startedAt', end);
    });

    it('GET /dashboard/revenue-history passes the site and end-date filters to the revenue query', async () => {
      getUserSiteIdsMock.mockResolvedValue([SITE]);
      const res = await app.inject({
        method: 'GET',
        url: `/dashboard/revenue-history?${RANGE}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(mockQueryRevenue).toHaveBeenCalledTimes(1);
      const input = mockQueryRevenue.mock.calls[0]?.[0] as { where: unknown[] };
      expect(input.where).toHaveLength(3);
    });

    it('GET /dashboard/payment-breakdown answers for a restricted operator', async () => {
      getUserSiteIdsMock.mockResolvedValue([SITE]);
      setupDbResults([{ status: 'captured', count: 2, totalCents: 1500 }]);
      const res = await app.inject({ method: 'GET', url: '/dashboard/payment-breakdown', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        expect.objectContaining({ status: 'captured', count: 2, totalCents: 1500 }),
      ]);
    });

    const executeRoutes = [
      '/dashboard/uptime',
      '/dashboard/snapshots/trend',
      '/dashboard/snapshots/available-dates',
      '/dashboard/snapshots?date=2025-01-01',
    ];
    for (const url of executeRoutes) {
      it(`GET ${url} adds a site_id IN filter`, async () => {
        getUserSiteIdsMock.mockResolvedValue([SITE]);
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(200);
        expect(sql.join).toHaveBeenCalled();
        expect(db.execute).toHaveBeenCalled();
      });
    }
  });

  describe('GET /dashboard/snapshots validates the range end', () => {
    it('rejects an impossible "to" date with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/snapshots?date=2025-01-01&to=2025-02-30',
        headers,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('rejects a "to" before "date" with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/snapshots?date=2025-01-10&to=2025-01-01',
        headers,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  it('GET /dashboard/carbon-stats bounds endedAt by from and to in the system timezone', async () => {
    setupDbResults([{ totalCo2: 12.345, sessionCount: 3, avgCo2: 4.115 }]);
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/carbon-stats?from=2025-01-01&to=2025-01-31',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalCo2AvoidedKg: 12.35, sessionCount: 3 });
    const sqlArgs = vi.mocked(sql).mock.calls.map((c) => c.slice(1));
    expect(sqlArgs).toContainEqual(['sessions.endedAt', 'America/New_York', '2025-01-01']);
    expect(sqlArgs).toContainEqual(['sessions.endedAt', 'America/New_York', '2025-01-31']);
  });

  it('GET /dashboard/site-locations maps the site rows', async () => {
    setupDbResults([
      { siteId: SITE, name: 'Depot', latitude: '52.5', longitude: '13.4', stationCount: 3 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/dashboard/site-locations', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { siteId: SITE, name: 'Depot', latitude: '52.5', longitude: '13.4', stationCount: 3 },
    ]);
  });

  it('GET /dashboard/snapshots rejects an impossible "date" with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2025-02-30',
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('GET /dashboard/carbon-stats rejects "from" after "to" with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/carbon-stats?from=2025-02-01&to=2025-01-01',
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: '"from" date must be on or before "to" date',
      code: 'VALIDATION_ERROR',
    });
    expect(getUserSiteIdsMock).not.toHaveBeenCalled();
  });

  it('limits each user to 30 dashboard requests a minute', async () => {
    const limited = Fastify();
    await registerAuth(limited);
    await limited.register(rateLimit, { global: false });
    dashboardRoutes(limited);
    await limited.ready();
    try {
      const auth = (userId: string) => ({
        authorization: `Bearer ${limited.jwt.sign({ userId, roleId: VALID_ROLE_ID })}`,
      });
      let last = 0;
      for (let i = 0; i < 31; i++) {
        const res = await limited.inject({
          method: 'GET',
          url: '/dashboard/station-status',
          headers: auth('usr_busy'),
        });
        last = res.statusCode;
      }
      expect(last).toBe(429);
      const other = await limited.inject({
        method: 'GET',
        url: '/dashboard/station-status',
        headers: auth('usr_idle'),
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
