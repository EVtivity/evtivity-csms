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
    '$dynamic',
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
  ocppServerHealth: {},
  getSystemTimezone: vi.fn().mockResolvedValue('America/New_York'),
  getCompanyCurrency: vi.fn().mockResolvedValue('EUR'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
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
  });

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

  it('GET /v1/dashboard/stats returns station and session statistics', async () => {
    // First query: station rows grouped by availability and isOnline
    // Second query: session stats
    // Third query: count of stations with a faulted connector (drives faultedStations)
    setupDbResults(
      [
        { status: 'available', isOnline: true, count: 5 },
        { status: 'faulted', isOnline: false, count: 1 },
      ],
      [{ activeSessions: 3, totalSessions: 100, totalEnergyWh: 500000 }],
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
    expect(body).toHaveProperty('activeSessions', 3);
    expect(body).toHaveProperty('totalSessions', 100);
    expect(body).toHaveProperty('totalEnergyWh', 500000);
    expect(body).toHaveProperty('faultedStations', 1);
    expect(body).toHaveProperty('statusCounts');
    expect(body).toHaveProperty('onlinePercent');
  });

  it('GET /v1/dashboard/stats returns zeros when no data', async () => {
    setupDbResults([], [undefined]);
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

  it('GET /v1/dashboard/energy-history returns energy data per day', async () => {
    // First query: timezone setting
    // Timezone now comes from cached getSystemTimezone (mocked above).
    setupDbResults([
      { date: '2025-01-01', energyWh: 1000 },
      { date: '2025-01-02', energyWh: 2000 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/energy-history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0]).toHaveProperty('date');
    expect(body[0]).toHaveProperty('energyWh');
  });

  it('GET /v1/dashboard/session-history returns session counts per day', async () => {
    setupDbResults([
      { date: '2025-01-01', count: 10 },
      { date: '2025-01-02', count: 15 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/session-history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('date');
    expect(body[0]).toHaveProperty('count');
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
    setupDbResults([{ siteName: 'Main Site', sessionHours: 100, stationCount: 5 }]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/utilization',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('site', 'Main Site');
    expect(body[0]).toHaveProperty('utilization');
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

  it('GET /v1/dashboard/financial-stats returns revenue, electricity cost, and profit per currency', async () => {
    setupDbResults([
      {
        currency: 'USD',
        totalRevenueCents: '500000',
        todayRevenueCents: '10000',
        avgRevenueCentsPerSession: '500.4',
        totalTransactions: '1000',
        totalElectricityCostCents: '120000',
        dayElectricityCostCents: '3000',
      },
      {
        currency: 'EUR',
        totalRevenueCents: '2000',
        todayRevenueCents: '0',
        avgRevenueCentsPerSession: '1000',
        totalTransactions: '2',
        totalElectricityCostCents: '2500',
        dayElectricityCostCents: '0',
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Company currency (EUR) first even with less revenue; amounts never mixed.
    expect(body.currencies).toEqual([
      {
        currency: 'EUR',
        totalRevenueCents: 2000,
        todayRevenueCents: 0,
        avgRevenueCentsPerSession: 1000,
        totalTransactions: 2,
        totalElectricityCostCents: 2500,
        dayElectricityCostCents: 0,
        totalProfitCents: -500,
        dayProfitCents: 0,
      },
      {
        currency: 'USD',
        totalRevenueCents: 500000,
        todayRevenueCents: 10000,
        avgRevenueCentsPerSession: 500,
        totalTransactions: 1000,
        totalElectricityCostCents: 120000,
        dayElectricityCostCents: 3000,
        totalProfitCents: 380000,
        dayProfitCents: 7000,
      },
    ]);
    expect(body).not.toHaveProperty('currency');
    expect(body).not.toHaveProperty('totalRevenueCents');
  });

  it('GET /v1/dashboard/financial-stats drops currencies without activity and never returns an empty list', async () => {
    setupDbResults([
      {
        currency: 'USD',
        totalRevenueCents: '0',
        todayRevenueCents: '0',
        avgRevenueCentsPerSession: '0',
        totalTransactions: '0',
        totalElectricityCostCents: '0',
        dayElectricityCostCents: '0',
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.currencies).toHaveLength(1);
    expect(body.currencies[0]).toMatchObject({ currency: 'EUR', totalRevenueCents: 0 });
  });

  it('GET /v1/dashboard/financial-stats returns zeroed financials in the company currency when the user has no site access', async () => {
    getUserSiteIdsMock.mockResolvedValueOnce([]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/financial-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.currencies).toEqual([
      {
        currency: 'EUR',
        totalRevenueCents: 0,
        todayRevenueCents: 0,
        avgRevenueCentsPerSession: 0,
        totalTransactions: 0,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
        totalProfitCents: 0,
        dayProfitCents: 0,
      },
    ]);
  });

  it('GET /v1/dashboard/revenue-history returns daily revenue per currency', async () => {
    setupDbResults([
      { date: '2025-01-01', currency: 'USD', revenueCents: '5000', sessionCount: 10 },
      { date: '2025-01-01', currency: 'EUR', revenueCents: '300', sessionCount: 1 },
      { date: '2025-01-02', currency: 'USD', revenueCents: '7000', sessionCount: 14 },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/revenue-history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([
      {
        date: '2025-01-01',
        sessionCount: 11,
        revenue: [
          { currency: 'EUR', revenueCents: 300, sessionCount: 1 },
          { currency: 'USD', revenueCents: 5000, sessionCount: 10 },
        ],
      },
      {
        date: '2025-01-02',
        sessionCount: 14,
        revenue: [{ currency: 'USD', revenueCents: 7000, sessionCount: 14 }],
      },
    ]);
  });

  it('GET /v1/dashboard/payment-breakdown returns counts per status and totals per currency', async () => {
    setupDbResults([
      { status: 'captured', currency: 'USD', count: 50, totalCents: '250000' },
      { status: 'captured', currency: 'EUR', count: 5, totalCents: '9000' },
      { status: 'refunded', currency: 'USD', count: 2, totalCents: '1000' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/payment-breakdown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([
      {
        status: 'captured',
        count: 55,
        totals: [
          { currency: 'EUR', count: 5, totalCents: 9000 },
          { currency: 'USD', count: 50, totalCents: 250000 },
        ],
      },
      {
        status: 'refunded',
        count: 2,
        totals: [{ currency: 'USD', count: 2, totalCents: 1000 }],
      },
    ]);
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

  it('GET /v1/dashboard/ocpp-health returns server health data', async () => {
    setupDbResults(
      [{ count: 10 }],
      [
        {
          avgPingLatencyMs: 25,
          maxPingLatencyMs: 100,
          pingSuccessRate: 99,
          totalPingsSent: 5000,
          totalPongsReceived: 4950,
          serverStartedAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-15T12:00:00Z',
        },
      ],
    );
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
  });

  it('GET /v1/dashboard/ocpp-health returns defaults when no row', async () => {
    setupDbResults([{ count: 0 }], []);
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
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        has_data: true,
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
        total_transactions: '100',
        day_transactions: '10',
        total_ports: '20',
        stations_below_threshold: '1',
        avg_ping_latency_ms: '12.5',
        ping_success_rate: '99.1',
      },
    ] as never);
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        currency: 'USD',
        total_revenue_cents: '500000',
        day_revenue_cents: '50000',
        total_sessions: '100',
        total_electricity_cost_cents: '1000',
        day_electricity_cost_cents: '100',
      },
      {
        currency: 'EUR',
        total_revenue_cents: '9000',
        day_revenue_cents: '0',
        total_sessions: '3',
        total_electricity_cost_cents: '0',
        day_electricity_cost_cents: '0',
      },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('totalStations', 10);
    expect(body).toHaveProperty('uptimePercent', 99.5);
    expect(body).toHaveProperty('totalTransactions', 100);
    expect(body).not.toHaveProperty('dayRevenueCents');
    expect(body.revenue).toEqual([
      {
        currency: 'EUR',
        totalRevenueCents: 9000,
        dayRevenueCents: 0,
        avgRevenueCentsPerSession: 3000,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
      },
      {
        currency: 'USD',
        totalRevenueCents: 500000,
        dayRevenueCents: 50000,
        avgRevenueCentsPerSession: 5000,
        totalElectricityCostCents: 1000,
        dayElectricityCostCents: 100,
      },
    ]);
  });

  it('GET /v1/dashboard/snapshots averages each currency per day over a range', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        has_data: true,
        day_count: '2',
        total_stations: '10',
        online_stations: '9',
        online_percent: '90',
        uptime_percent: '99',
        active_sessions: '3',
        total_energy_wh: '500000',
        day_energy_wh: '50000',
        total_sessions: '100',
        day_sessions: '10',
        connected_stations: '9',
        total_transactions: '100',
        day_transactions: '10',
        total_ports: '20',
        stations_below_threshold: '1',
        avg_ping_latency_ms: '12.5',
        ping_success_rate: '99.1',
      },
    ] as never);
    // Summed over both days: EUR had activity on only one of them.
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        currency: 'EUR',
        total_revenue_cents: '4000',
        day_revenue_cents: '1000',
        total_sessions: '8',
        total_electricity_cost_cents: '600',
        day_electricity_cost_cents: '200',
      },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots?date=2026-03-11&to=2026-03-12',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.revenue).toEqual([
      {
        currency: 'EUR',
        totalRevenueCents: 2000,
        dayRevenueCents: 500,
        avgRevenueCentsPerSession: 500,
        totalElectricityCostCents: 300,
        dayElectricityCostCents: 100,
      },
    ]);
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
    expect(body.hasData).toBe(false);
    expect(body.totalStations).toBe(0);
    expect(body.uptimePercent).toBe(100);
    expect(body.revenue).toEqual([
      {
        currency: 'EUR',
        totalRevenueCents: 0,
        dayRevenueCents: 0,
        avgRevenueCentsPerSession: 0,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
      },
    ]);
  });

  it('GET /v1/dashboard/snapshots/trend returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/trend',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/dashboard/snapshots/trend returns daily aggregated data', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        date: '2026-03-12',
        has_data: true,
        total_stations: '10',
        online_stations: '9',
        online_percent: '95',
        uptime_percent: '99',
        active_sessions: '3',
        total_energy_wh: '500000',
        day_energy_wh: '50000',
        total_sessions: '100',
        day_sessions: '10',
        connected_stations: '9',
        total_transactions: '100',
        day_transactions: '10',
        total_ports: '20',
        stations_below_threshold: '0',
        avg_ping_latency_ms: '12.5',
        ping_success_rate: '99.1',
      },
    ] as never);
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        date: '2026-03-12',
        currency: 'USD',
        total_revenue_cents: '500000',
        day_revenue_cents: '50000',
        total_sessions: '100',
        total_electricity_cost_cents: '0',
        day_electricity_cost_cents: '0',
      },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/snapshots/trend',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('days');
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days[0]).toHaveProperty('date', '2026-03-12');
    expect(body.days[0]).toHaveProperty('totalStations', 10);
    expect(body.days[0].revenue).toEqual([
      {
        currency: 'USD',
        totalRevenueCents: 500000,
        dayRevenueCents: 50000,
        avgRevenueCentsPerSession: 5000,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
      },
    ]);
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
