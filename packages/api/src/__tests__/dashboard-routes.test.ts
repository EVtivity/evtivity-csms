// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Fleet OCPP health (aggregation covered in the database package tests).
const EMPTY_FLEET = {
  instanceCount: 0,
  connectedStations: 0,
  avgPingLatencyMs: 0,
  maxPingLatencyMs: 0,
  pingSuccessRate: 100,
  totalPingsSent: 0,
  totalPongsReceived: 0,
  serverStartedAt: null,
  updatedAt: null,
  instances: [],
};
const mockGetOcppFleetHealth = vi.hoisted(() => vi.fn());

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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
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
  chargingStations: {},
  chargingSessions: {},
  connectors: {},
  evses: {},
  sites: {},
  settings: {},
  paymentRecords: {},
  client: {},
  getOcppFleetHealth: (...args: unknown[]) => mockGetOcppFleetHealth(...args),
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
    { raw: vi.fn() },
  ),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  lt: vi.fn(),
  isNull: vi.fn(),
  between: vi.fn(),
  isNotNull: vi.fn(),
}));

vi.mock('../lib/payment-site-scope.js', () => ({
  paymentRecordsAtSites: vi.fn(() => ({ paymentsAtSites: true })),
  paymentRecordsOfOperatorStations: vi.fn(() => ({ paymentsOfOperatorStations: true })),
}));

const { mockDerivedStatus } = vi.hoisted(() => ({
  mockDerivedStatus: vi.fn(() => ({ __derivedStatus: true })),
}));

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: mockDerivedStatus,
}));

const { mockQueryRevenue, mockQueryRevenueTotal, mockRequestHasPermission } = vi.hoisted(() => ({
  mockQueryRevenue: vi.fn(),
  mockQueryRevenueTotal: vi.fn(),
  mockRequestHasPermission: vi.fn(),
}));

vi.mock('@evtivity/services/session-revenue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryRevenue: (input: unknown) => mockQueryRevenue(input),
  queryRevenueTotal: (input: unknown) => mockQueryRevenueTotal(input),
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
  requestHasPermission: (...args: unknown[]) => mockRequestHasPermission(...args),
}));

import { registerAuth } from '../plugins/auth.js';
import { dashboardRoutes } from '../routes/dashboard.js';
import { clearDashboardTotalsCache } from '../lib/dashboard-totals.js';
import { db } from '@evtivity/database';
import { getUserSiteIds } from '../lib/site-access.js';
import * as sessionRevenueModule from '@evtivity/services/session-revenue';

const getUserSiteIdsMock = getUserSiteIds as ReturnType<typeof vi.fn>;

/** A per-day snapshot aggregate row as querySnapshotDays reads it. */
function snapshotDayRow(date: string, overrides: Record<string, string> = {}) {
  return {
    date,
    total_stations: '10',
    online_stations: '9',
    online_percent: '90',
    uptime_percent: '99.5',
    active_sessions: '3',
    total_energy_wh: '500000',
    day_energy_wh: '50000',
    total_sessions: '100',
    day_sessions: '10',
    connected_stations: '9',
    total_revenue_cents: '500000',
    day_revenue_cents: '50000',
    session_revenue_cents: '360000',
    billed_sessions: '80',
    legacy_avg_revenue: null,
    total_transactions: '100',
    day_transactions: '10',
    total_ports: '20',
    stations_below_threshold: '1',
    avg_ping_latency_ms: '12.5',
    ping_success_rate: '99.1',
    ...overrides,
  };
}

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  dashboardRoutes(app);
  await app.ready();
  return app;
}

describe('Dashboard routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    clearDashboardTotalsCache();
    mockRequestHasPermission.mockResolvedValue(true);
  });

  /** Revenue totals of rows, as queryRevenueTotal returns them. */
  function totalsOf(rows: Parameters<typeof sessionRevenueModule.aggregateRevenueRows>[0]) {
    return (
      sessionRevenueModule.aggregateRevenueRows(rows.map((r) => ({ ...r, key: null }))).get(null) ??
      sessionRevenueModule.EMPTY_REVENUE
    );
  }

  // --- Auth requirements ---

  it('GET /v1/dashboard/stats returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/stats' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/energy-history returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/energy-history' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/session-history returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/session-history' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/station-status returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/station-status' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/utilization returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/utilization' });
    expect(response.statusCode).toBe(401);
  });

  // --- Happy paths ---

  it('GET /v1/dashboard/stats counts accepted stations and reads the cached all-time totals', async () => {
    // Load order: session totals before today (cached), station rows, today's
    // session totals, active sessions, stations whose display status is faulted.
    setupDbResults(
      [{ totalSessions: 90, totalEnergyWh: 450000 }],
      [
        { status: 'available', onboardingStatus: 'accepted', isOnline: true, count: 5 },
        { status: 'faulted', onboardingStatus: 'accepted', isOnline: false, count: 1 },
        { status: 'available', onboardingStatus: 'pending', isOnline: true, count: 2 },
        { status: 'available', onboardingStatus: 'blocked', isOnline: false, count: 1 },
      ],
      [{ totalSessions: 10, totalEnergyWh: 50000 }],
      [{ activeSessions: 3 }],
      [{ faulted: 1 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('totalStations', 6);
    expect(body).toHaveProperty('onlineStations', 5);
    expect(body).toHaveProperty('onlinePercent', 83);
    expect(body).toHaveProperty('activeSessions', 3);
    expect(body).toHaveProperty('totalSessions', 100);
    expect(body).toHaveProperty('totalEnergyWh', 500000);
    expect(body).toHaveProperty('faultedStations', 1);
    expect(body.statusCounts).toEqual({ available: 5, faulted: 1 });
    expect(body.onboardingStatusCounts).toEqual({ accepted: 6, pending: 2, blocked: 1 });
    // The faulted count reads the station list's display status.
    expect(mockDerivedStatus).toHaveBeenCalled();

    // Within the minute the earlier totals come from the cache; today stays live.
    setupDbResults(
      [{ status: 'available', onboardingStatus: 'accepted', isOnline: true, count: 1 }],
      [{ totalSessions: 11, totalEnergyWh: 51000 }],
      [{ activeSessions: 0 }],
      [{ faulted: 0 }],
    );
    const again = await app.inject({
      method: 'GET',
      url: '/dashboard/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(again.body)).toMatchObject({
      totalStations: 1,
      totalSessions: 101,
      activeSessions: 0,
    });
  });

  it('GET /v1/dashboard/stats returns zeros when no data', async () => {
    setupDbResults([], [], [], [], []);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalStations).toBe(0);
    expect(body.onlineStations).toBe(0);
    expect(body.onlinePercent).toBe(0);
  });

  it('GET /v1/dashboard/stats leaves conformance stations and their sessions out', async () => {
    const database = await import('@evtivity/database');
    vi.mocked(database.isOperatorStation).mockClear();
    vi.mocked(database.inOperatorStation).mockClear();
    setupDbResults([], [], [], [], []);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    // Station counts and faults, then the session totals and active sessions.
    expect(vi.mocked(database.isOperatorStation)).toHaveBeenCalled();
    expect(vi.mocked(database.inOperatorStation)).toHaveBeenCalled();
  });

  it('GET /v1/dashboard/energy-history returns energy data per day', async () => {
    // First query: timezone setting
    // Timezone now comes from cached getSystemTimezone (mocked above).
    setupDbResults([
      { date: '2025-01-03', energyWh: 2000 },
      { date: '2025-01-01', energyWh: 1000 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/energy-history?from=2025-01-01&to=2025-01-03',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    // Every day of the range, oldest first, a day without sessions at 0.
    expect(JSON.parse(response.body)).toEqual([
      { date: '2025-01-01', energyWh: 1000 },
      { date: '2025-01-02', energyWh: 0 },
      { date: '2025-01-03', energyWh: 2000 },
    ]);
  });

  it('GET /v1/dashboard/session-history returns session counts per day', async () => {
    setupDbResults([
      { date: '2025-01-01', count: 10 },
      { date: '2025-01-02', count: 15 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/session-history?from=2024-12-31&to=2025-01-02',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      { date: '2024-12-31', count: 0 },
      { date: '2025-01-01', count: 10 },
      { date: '2025-01-02', count: 15 },
    ]);
  });

  it('GET /v1/dashboard/session-history refuses a negative or zero days', async () => {
    for (const days of ['-3', '0', 'abc']) {
      const response = await app.inject({
        method: 'GET',
        url: `/dashboard/session-history?days=${days}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, days).toBe(400);
    }
  });

  it('GET /v1/dashboard/station-status returns status counts', async () => {
    setupDbResults([
      { status: 'available', count: 8 },
      { status: 'faulted', count: 2 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/station-status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('status');
    expect(body[0]).toHaveProperty('count');
  });

  it('GET /v1/dashboard/utilization returns site utilization data', async () => {
    // A past range of 3 days is 72 hours per port.
    vi.mocked(db.execute).mockResolvedValueOnce([
      { site_name: 'Two Ports', ports: '2', session_hours: '36' },
      { site_name: 'Busy', ports: '1', session_hours: '54' },
      { site_name: 'No Ports', ports: '0', session_hours: '10' },
      { site_name: 'Over', ports: '1', session_hours: '80' },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/utilization?from=2025-01-01&to=2025-01-03',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    // Ordered by the ratio, never above 100; a site without ports is 0.
    expect(JSON.parse(response.body)).toEqual([
      { site: 'Over', utilization: 100 },
      { site: 'Busy', utilization: 75 },
      { site: 'Two Ports', utilization: 25 },
      { site: 'No Ports', utilization: 0 },
    ]);
  });

  it('GET /v1/dashboard/utilization keeps tiny values unrounded so the chart scales', async () => {
    // 200 ports over 72 hours is 14,400 port-hours: 69 charging hours is 0.479...%;
    // 400 ports and 1 charging hour is 0.00347...%, still above zero.
    vi.mocked(db.execute).mockResolvedValueOnce([
      { site_name: 'Large', ports: '200', session_hours: '69' },
      { site_name: 'Larger', ports: '400', session_hours: '1' },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/utilization?from=2025-01-01&to=2025-01-03',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { site: string; utilization: number }[];
    expect(body.map((r) => r.site)).toEqual(['Large', 'Larger']);
    expect(body[0]?.utilization).toBeCloseTo((69 / 14_400) * 100, 10);
    expect(body[1]?.utilization).toBeCloseTo((1 / 28_800) * 100, 10);
    expect(body[1]?.utilization).toBeGreaterThan(0);
  });

  it('GET /v1/dashboard/peak-usage returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/peak-usage' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/peak-usage returns hourly usage data', async () => {
    setupDbResults([
      { hour: 9, dayOfWeek: 1, count: 5 },
      { hour: 17, dayOfWeek: 5, count: 10 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/peak-usage',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('hour');
    expect(body[0]).toHaveProperty('dayOfWeek');
    expect(body[0]).toHaveProperty('count');
  });

  it('GET /v1/dashboard/financial-stats returns revenue, electricity cost, and profit in the company currency', async () => {
    // Load order: the electricity cost before today (cached), then today's.
    setupDbResults([{ electricityCostCents: 117000 }], [{ electricityCostCents: 3000 }]);
    // The shared revenue definition (session-revenue.ts): before today, then today.
    const today = [
      { key: null, taxRate: '0.19', grossCents: 1190, source: 'session', count: 8 },
      { key: null, taxRate: '0.07', grossCents: 480, source: 'session', count: 1 },
      // A reservation fee: revenue, but not a session.
      { key: null, taxRate: '0.19', grossCents: 595, source: 'fee', count: 1 },
      { key: null, taxRate: '0.19', grossCents: 1190, source: 'account', count: 1 },
    ];
    mockQueryRevenueTotal
      .mockResolvedValueOnce(
        totalsOf([
          { key: null, taxRate: '0.19', grossCents: 1190, source: 'session', count: 392 },
          { key: null, taxRate: '0', grossCents: 23520, source: 'session', count: 1 },
          // Unpaid account sessions: billed on account, not revenue.
          { key: null, taxRate: '0.19', grossCents: 2380, source: 'account', count: 2 },
        ]),
      )
      .mockResolvedValueOnce(totalsOf(today));
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const sessionsGross = 400 * 1190 + 23520 + 480;
    expect(body).toHaveProperty('totalRevenueCents', sessionsGross + 595);
    expect(body).toHaveProperty('todayRevenueCents', 8 * 1190 + 480 + 595);
    expect(body).toHaveProperty('avgRevenueCentsPerSession', Math.round(sessionsGross / 402));
    expect(body).toHaveProperty('totalTransactions', 403);
    expect(body).toHaveProperty('totalElectricityCostCents', 120000);
    expect(body).toHaveProperty('dayElectricityCostCents', 3000);
    // Each amount is split at its rate: 1190 at 19% is 1000 net + 190 tax,
    // 480 at 7% is 449 net + 31 tax, 595 at 19% is 500 net + 95 tax.
    expect(body).toHaveProperty('totalNetRevenueCents', 400 * 1000 + 23520 + 449 + 500);
    expect(body).toHaveProperty('totalTaxCents', 400 * 190 + 31 + 95);
    expect(body).toHaveProperty('todayNetRevenueCents', 8 * 1000 + 449 + 500);
    expect(body).toHaveProperty('todayTaxCents', 8 * 190 + 31 + 95);
    // Profit = revenue excluding tax - electricity cost
    expect(body).toHaveProperty('totalProfitCents', 424469 - 120000);
    expect(body).toHaveProperty('dayProfitCents', 8949 - 3000);
    expect(body).toHaveProperty('billedOnAccountCents', 2 * 2380 + 1190);
    expect(body).toHaveProperty('billedOnAccountCount', 3);
    expect(body).toHaveProperty('currency', 'EUR');
    // Before today: the cached part, bounded by the start of today.
    const earlier = mockQueryRevenueTotal.mock.calls[0]?.[0] as { where: unknown[] };
    expect(earlier.where).toHaveLength(1);
    // Today is read through the indexed dates.
    expect(mockQueryRevenueTotal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ companyCurrency: 'EUR', occurredSince: expect.any(Date) }),
    );
  });

  it('GET /v1/dashboard/financial-stats leaves the electricity cost of unpaid account sessions out of profit', async () => {
    setupDbResults([{ electricityCostCents: 500 }], [{ electricityCostCents: 0 }]);
    const rows = [
      {
        key: null,
        taxRate: '0',
        grossCents: 1000,
        source: 'session',
        electricityCostCents: 300,
        count: 1,
      },
      {
        key: null,
        taxRate: '0',
        grossCents: 900,
        source: 'account',
        electricityCostCents: 200,
        count: 1,
      },
    ];
    mockQueryRevenueTotal.mockResolvedValueOnce(totalsOf(rows)).mockResolvedValueOnce(totalsOf([]));
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(response.body);
    expect(body.totalElectricityCostCents).toBe(500);
    expect(body.totalProfitCents).toBe(1000 - 300);
  });

  it('GET /v1/dashboard/financial-stats leaves sessions without an electricity cost out of profit', async () => {
    setupDbResults([{ electricityCostCents: 200 }], [{ electricityCostCents: 100 }]);
    const today = [
      {
        key: null,
        taxRate: '0',
        grossCents: 1000,
        source: 'session',
        costMissing: false,
        count: 1,
      },
      { key: null, taxRate: '0', grossCents: 400, source: 'session', costMissing: true, count: 1 },
    ];
    mockQueryRevenueTotal
      .mockResolvedValueOnce(
        totalsOf([
          // One session with a cost, two without, one at a station without a site.
          {
            key: null,
            taxRate: '0',
            grossCents: 1000,
            source: 'session',
            costMissing: false,
            count: 1,
          },
          {
            key: null,
            taxRate: '0',
            grossCents: 500,
            source: 'session',
            costMissing: true,
            count: 2,
          },
          {
            key: null,
            taxRate: '0',
            grossCents: 700,
            source: 'session',
            costMissing: true,
            count: 1,
          },
        ]),
      )
      .mockResolvedValueOnce(totalsOf(today));
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Revenue keeps every session.
    expect(body.totalRevenueCents).toBe(2000 + 400 + 1000 + 700);
    expect(body.todayRevenueCents).toBe(1400);
    // Profit counts only the sessions with a cost.
    expect(body.totalProfitCents).toBe(2000 - 300);
    expect(body.dayProfitCents).toBe(1000 - 100);
    expect(body.totalCostMissingSessionCount).toBe(4);
    expect(body.totalCostMissingRevenueCents).toBe(400 + 1000 + 700);
    expect(body.dayCostMissingSessionCount).toBe(1);
    expect(body.dayCostMissingRevenueCents).toBe(400);
  });

  it('GET /v1/dashboard/financial-stats reports no excluded sessions when every session has a cost', async () => {
    setupDbResults([{ electricityCostCents: 300 }], [{ electricityCostCents: 0 }]);
    mockQueryRevenueTotal
      .mockResolvedValueOnce(
        totalsOf([
          {
            key: null,
            taxRate: '0',
            grossCents: 1000,
            source: 'session',
            costMissing: false,
            count: 2,
          },
        ]),
      )
      .mockResolvedValueOnce(totalsOf([]));
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(response.body);
    expect(body.totalProfitCents).toBe(2000 - 300);
    expect(body.totalCostMissingSessionCount).toBe(0);
    expect(body.totalCostMissingRevenueCents).toBe(0);
  });

  it('GET /v1/dashboard/financial-stats returns zeroed financials when the user has no site access', async () => {
    getUserSiteIdsMock.mockResolvedValueOnce([]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalElectricityCostCents).toBe(0);
    expect(body.totalNetRevenueCents).toBe(0);
    expect(body.totalTaxCents).toBe(0);
    expect(body.totalProfitCents).toBe(0);
    expect(body.dayProfitCents).toBe(0);
    expect(body.billedOnAccountCents).toBe(0);
    expect(body.totalCostMissingSessionCount).toBe(0);
    expect(body.currency).toBe('EUR');
  });

  it('GET /v1/dashboard/revenue-history returns daily revenue data', async () => {
    const { aggregateRevenueRows } = sessionRevenueModule;
    mockQueryRevenue.mockResolvedValueOnce(
      aggregateRevenueRows([
        { key: '2025-01-03', taxRate: '0', grossCents: 500, source: 'session', count: 14 },
        { key: '2025-01-01', taxRate: '0', grossCents: 500, source: 'session', count: 10 },
        { key: '2025-01-01', taxRate: '0', grossCents: 300, source: 'fee', count: 1 },
      ]),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/revenue-history?from=2025-01-01&to=2025-01-03',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Every day, oldest first; revenue includes fees, the count only sessions.
    expect(body).toEqual([
      { date: '2025-01-01', revenueCents: 5300, sessionCount: 10 },
      { date: '2025-01-02', revenueCents: 0, sessionCount: 0 },
      { date: '2025-01-03', revenueCents: 7000, sessionCount: 14 },
    ]);
    // Midnight of the first day in America/New_York, read through the indexed dates.
    expect(mockQueryRevenue).toHaveBeenCalledWith(
      expect.objectContaining({ occurredSince: new Date('2025-01-01T05:00:00.000Z') }),
    );
  });

  it('GET /v1/dashboard/payment-breakdown returns payment status data', async () => {
    setupDbResults([
      { status: 'captured', count: 50, totalCents: 250000 },
      { status: 'refunded', count: 2, totalCents: 1000 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/payment-breakdown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('status');
    expect(body[0]).toHaveProperty('count');
    expect(body[0]).toHaveProperty('totalCents');
    const scope = await import('../lib/payment-site-scope.js');
    expect(vi.mocked(scope.paymentRecordsOfOperatorStations)).toHaveBeenCalled();
  });

  it('GET /v1/dashboard/uptime returns uptime data', async () => {
    setupDbResults([{ uptime_percent: '99.5', total_ports: '20', stations_below_threshold: '1' }]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/uptime',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('uptimePercent');
    expect(body).toHaveProperty('totalPorts');
    expect(body).toHaveProperty('stationsBelowThreshold');
  });

  it('GET /v1/dashboard/uptime returns defaults when no data', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/uptime',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.uptimePercent).toBe(100);
    expect(body.totalPorts).toBe(0);
    expect(body.stationsBelowThreshold).toBe(0);
  });

  it('GET /v1/dashboard/ocpp-health returns the fleet health and each process', async () => {
    setupDbResults([{ count: 10 }]);
    const instance = {
      instanceId: 'ocpp-a',
      connectedStations: 10,
      avgPingLatencyMs: 25,
      maxPingLatencyMs: 100,
      pingSuccessRate: 99,
      totalPingsSent: 5000,
      totalPongsReceived: 4950,
      serverStartedAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-15T12:00:00Z'),
    };
    mockGetOcppFleetHealth.mockResolvedValueOnce({
      ...EMPTY_FLEET,
      instanceCount: 1,
      connectedStations: 10,
      avgPingLatencyMs: 25,
      maxPingLatencyMs: 100,
      pingSuccessRate: 99,
      totalPingsSent: 5000,
      totalPongsReceived: 4950,
      serverStartedAt: instance.serverStartedAt,
      updatedAt: instance.updatedAt,
      instances: [instance],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/ocpp-health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('connectedStations', 10);
    expect(body).toHaveProperty('avgPingLatencyMs', 25);
    expect(body).toHaveProperty('pingSuccessRate', 99);
    expect(body).toHaveProperty('instanceCount', 1);
    expect(body.instances).toEqual([
      {
        instanceId: 'ocpp-a',
        connectedStations: 10,
        avgPingLatencyMs: 25,
        maxPingLatencyMs: 100,
        pingSuccessRate: 99,
        serverStartedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-15T12:00:00.000Z',
      },
    ]);
  });

  it('GET /v1/dashboard/ocpp-health gives a site-restricted user its connected count only', async () => {
    getUserSiteIdsMock.mockResolvedValueOnce(['sit_a']);
    setupDbResults([{ count: 3 }]);
    mockGetOcppFleetHealth.mockClear();
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/ocpp-health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      connectedStations: 3,
      avgPingLatencyMs: 0,
      maxPingLatencyMs: 0,
      pingSuccessRate: 100,
      totalPingsSent: 0,
      serverStartedAt: null,
      instanceCount: 0,
    });
    expect(body).not.toHaveProperty('instances');
    expect(mockGetOcppFleetHealth).not.toHaveBeenCalled();
  });

  it('GET /v1/dashboard/ocpp-health returns defaults when no process reports', async () => {
    setupDbResults([{ count: 0 }]);
    mockGetOcppFleetHealth.mockResolvedValueOnce(EMPTY_FLEET);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/ocpp-health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.connectedStations).toBe(0);
    expect(body.avgPingLatencyMs).toBe(0);
    expect(body.pingSuccessRate).toBe(100);
    expect(body.serverStartedAt).toBeNull();
    expect(body.updatedAt).toBeNull();
    expect(body.instanceCount).toBe(0);
    expect(body.instances).toEqual([]);
  });

  // --- Snapshot endpoints ---

  it('GET /v1/dashboard/snapshots returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-12',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/snapshots returns aggregated snapshot for a date', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([snapshotDayRow('2026-03-12')] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('hasData', true);
    expect(body).toHaveProperty('totalStations', 10);
    expect(body).toHaveProperty('uptimePercent', 99.5);
    expect(body).toHaveProperty('dayRevenueCents', 50000);
    // Revenue per session: billed session revenue over billed sessions.
    expect(body).toHaveProperty('avgRevenueCentsPerSession', 4500);
  });

  it('GET /v1/dashboard/snapshots uses the stored average of rows without a billed count', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      snapshotDayRow('2026-03-12', {
        session_revenue_cents: null as unknown as string,
        billed_sessions: null as unknown as string,
        legacy_avg_revenue: '3300',
      }),
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(response.body)).toHaveProperty('avgRevenueCentsPerSession', 3300);
  });

  it('GET /v1/dashboard/snapshots hides money from a user without payments:read', async () => {
    mockRequestHasPermission.mockResolvedValue(false);
    vi.mocked(db.execute).mockResolvedValueOnce([snapshotDayRow('2026-03-12')] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      totalStations: 10,
      totalRevenueCents: null,
      dayRevenueCents: null,
      avgRevenueCentsPerSession: null,
      totalTransactions: null,
      dayTransactions: null,
    });
    expect(mockRequestHasPermission).toHaveBeenCalledWith(expect.anything(), 'payments:read');
  });

  it('GET /v1/dashboard/snapshots averages a date range over the days with data', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      snapshotDayRow('2026-03-11', { day_sessions: '10' }),
      snapshotDayRow('2026-03-12', { day_sessions: '20' }),
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-10&to=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(response.body)).toMatchObject({ hasData: true, daySessions: 15 });
  });

  it('GET /v1/dashboard/snapshots/day-over-day compares the latest snapshot day with the day before', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([{ date: '2026-03-12' }] as never)
      .mockResolvedValueOnce([
        snapshotDayRow('2026-03-11', { day_sessions: '8' }),
        snapshotDayRow('2026-03-12', { day_sessions: '10' }),
      ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/day-over-day',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.current).toMatchObject({ date: '2026-03-12', hasData: true, daySessions: 10 });
    expect(body.previous).toMatchObject({ date: '2026-03-11', hasData: true, daySessions: 8 });
  });

  it('GET /v1/dashboard/snapshots/day-over-day marks a day without a snapshot', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([{ date: '2026-03-12' }] as never)
      .mockResolvedValueOnce([snapshotDayRow('2026-03-12')] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/day-over-day',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(response.body);
    expect(body.current.hasData).toBe(true);
    expect(body.previous).toMatchObject({ date: '2026-03-11', hasData: false });
  });

  it('GET /v1/dashboard/snapshots returns zeros when no data', async () => {
    // db.execute returns [] by default, so rows[0] is undefined -> emptySnapshot
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-01-01',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalStations).toBe(0);
    expect(body.uptimePercent).toBe(100);
  });

  it('GET /v1/dashboard/snapshots/trend returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/trend',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/snapshots/trend returns daily aggregated data, newest first', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      snapshotDayRow('2026-03-11'),
      snapshotDayRow('2026-03-12'),
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/trend',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.days.map((d: { date: string }) => d.date)).toEqual(['2026-03-12', '2026-03-11']);
    expect(body.days[0]).toHaveProperty('totalStations', 10);
  });

  it('GET /v1/dashboard/snapshots/available-dates returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/available-dates',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/snapshots/available-dates returns date list', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      { date: '2026-03-12' },
      { date: '2026-03-11' },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/available-dates',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toContain('2026-03-12');
  });
});
