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
  carbonIntensityFactors: {},
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  settings: {},
  connectors: {},
  evses: {},
  paymentRecords: {},
  ocppServerHealth: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  isNotNull: vi.fn(),
  between: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { carbonRoutes } from '../routes/carbon.js';
import { dashboardRoutes } from '../routes/dashboard.js';
import { db } from '@evtivity/database';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  carbonRoutes(app);
  dashboardRoutes(app);
  await app.ready();
  return app;
}

const MOCK_FACTOR = {
  id: 1,
  regionCode: 'CAMX',
  regionName: 'WECC California',
  countryCode: 'US',
  carbonIntensityKgPerKwh: '0.220',
  source: 'eGRID-2023',
  updatedAt: '2024-01-01',
};

describe('Carbon routes', () => {
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

  it('GET /carbon/factors returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/carbon/factors' });
    expect(response.statusCode).toBe(401);
  });

  // --- Carbon factors ---

  it('GET /carbon/factors returns data with auth', async () => {
    setupDbResults([MOCK_FACTOR]);
    const response = await app.inject({
      method: 'GET',
      url: '/carbon/factors',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].regionCode).toBe('CAMX');
    expect(body[0].countryCode).toBe('US');
  });

  it('GET /carbon/factors?country=US filters by country', async () => {
    setupDbResults([MOCK_FACTOR]);
    const response = await app.inject({
      method: 'GET',
      url: '/carbon/factors?country=US',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].countryCode).toBe('US');
  });

  it('GET /carbon/factors/:regionCode returns single factor', async () => {
    setupDbResults([MOCK_FACTOR]);
    const response = await app.inject({
      method: 'GET',
      url: '/carbon/factors/CAMX',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.regionCode).toBe('CAMX');
    expect(body.regionName).toBe('WECC California');
    expect(body.carbonIntensityKgPerKwh).toBe('0.220');
  });

  it('GET /carbon/factors/INVALID returns 404', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/carbon/factors/INVALID',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('REGION_NOT_FOUND');
  });

  // --- Carbon report ---

  it('GET /carbon/report returns report data', async () => {
    const monthlyRow = {
      month: '2024-01',
      co2_avoided_kg: 150.5,
      energy_wh: 500000,
      session_count: 10,
    };
    const siteRow = {
      site_id: 'site_001',
      site_name: 'Main Campus',
      co2_avoided_kg: 150.5,
      energy_wh: 500000,
      session_count: 10,
    };
    (db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([monthlyRow])
      .mockResolvedValueOnce([siteRow]);

    const response = await app.inject({
      method: 'GET',
      url: '/carbon/report',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.monthlySummary).toHaveLength(1);
    expect(body.monthlySummary[0].month).toBe('2024-01');
    expect(body.siteBreakdown).toHaveLength(1);
    expect(body.siteBreakdown[0].siteName).toBe('Main Campus');
    expect(body.cumulativeTotal).toHaveProperty('co2AvoidedKg');
    expect(body.cumulativeTotal).toHaveProperty('treesEquivalent');
  });

  // --- Carbon report export ---

  it('GET /carbon/report/export returns CSV content-type', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/carbon/report/export',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('sustainability-report.csv');
  });

  // --- Dashboard carbon stats ---

  it('GET /dashboard/carbon-stats returns aggregated data', async () => {
    setupDbResults([{ totalCo2: 250.5, sessionCount: 20, avgCo2: 12.525 }]);
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/carbon-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('totalCo2AvoidedKg');
    expect(body).toHaveProperty('sessionCount');
    expect(body).toHaveProperty('avgCo2AvoidedKgPerSession');
  });
});
