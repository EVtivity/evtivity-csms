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
    'having',
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
  },
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  paymentRecords: {},
  drivers: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: sqlTag,
    desc: vi.fn(),
    count: vi.fn(),
    asc: vi.fn(),
    gte: vi.fn(),
    between: vi.fn(),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalSessionRoutes } from '../routes/portal/sessions.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalSessionRoutes);
  await app.ready();
  return app;
}

describe('Portal monthly summary routes', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('GET /v1/portal/sessions/monthly-summary', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-summary?month=2026-02',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns monthly summary', async () => {
      setupDbResults([
        { totalCostCents: '5000', totalEnergyWh: '45000', sessionCount: '3', currency: 'USD' },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-summary?month=2026-02',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totalCostCents).toBeDefined();
      expect(body.sessionCount).toBeDefined();
    });

    it('returns zeros when no sessions', async () => {
      setupDbResults([
        { totalCostCents: null, totalEnergyWh: null, sessionCount: '0', currency: null },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-summary?month=2026-01',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.sessionCount).toBeDefined();
    });
  });

  describe('GET /v1/portal/sessions/monthly-statement', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-statement?month=2026-02',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns monthly statement with sessions', async () => {
      setupDbResults(
        [{ firstName: 'John', lastName: 'Doe' }],
        [
          {
            id: 'ses_1',
            startedAt: '2026-02-10T10:00:00Z',
            endedAt: '2026-02-10T11:00:00Z',
            energyDeliveredWh: '30000',
            finalCostCents: 1500,
            currency: 'USD',
            stationName: 'Station A',
            siteName: 'Site Alpha',
          },
        ],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-statement?month=2026-02',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.month).toBe('2026-02');
      expect(body.driverName).toBeDefined();
      expect(body.sessions).toBeDefined();
    });
  });

  describe('GET /v1/portal/sessions with month filter', () => {
    it('accepts month query parameter', async () => {
      setupDbResults(
        [
          {
            id: 'ses_000000000001',
            transactionId: 'tx-1',
            status: 'completed',
            startedAt: '2026-02-15T10:00:00Z',
            endedAt: '2026-02-15T11:00:00Z',
            energyDeliveredWh: '20000',
            finalCostCents: 1000,
            currency: 'USD',
            stationName: 'Station B',
            siteName: 'Site Beta',
            siteCity: 'Austin',
            siteAddress: null,
            siteState: null,
            co2AvoidedKg: null,
          },
        ],
        [{ count: 1 }],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions?month=2026-02',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toBeDefined();
      expect(body.total).toBeDefined();
    });
  });
});
