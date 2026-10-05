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
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
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

    it('returns the month total in the company currency', async () => {
      setupDbResults([
        { totalCostCents: 5000, totalEnergyWh: '45000', totalCo2AvoidedKg: '7.5', sessionCount: 3 },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-summary?month=2026-02',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalCostCents: 5000,
        totalEnergyWh: 45000,
        totalCo2AvoidedKg: 7.5,
        sessionCount: 3,
        currency: 'EUR',
      });
    });

    it('returns zeros when no sessions', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-summary?month=2026-01',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalCostCents: 0,
        totalEnergyWh: 0,
        totalCo2AvoidedKg: 0,
        sessionCount: 0,
        currency: 'EUR',
      });
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
            co2AvoidedKg: '5.2',
            finalCostCents: 1500,
            tariffTaxRate: '0.19',
            taxCents: 160,
            currency: 'EUR',
            stationName: 'Station A',
            siteName: 'Site Alpha',
            siteCity: 'Austin',
          },
          {
            id: 'ses_2',
            startedAt: '2026-02-11T10:00:00Z',
            endedAt: '2026-02-11T11:00:00Z',
            energyDeliveredWh: '10000',
            co2AvoidedKg: '1.8',
            finalCostCents: 500,
            tariffTaxRate: null,
            taxCents: null,
            currency: 'EUR',
            stationName: 'Station A',
            siteName: 'Site Alpha',
            siteCity: 'Austin',
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
      expect(body.driverName).toBe('John Doe');
      expect(body.sessions).toHaveLength(2);
      // Each session carries its tariff tax rate so clients label the cost.
      expect(body.sessions.map((s: { tariffTaxRate: string | null }) => s.tariffTaxRate)).toEqual([
        '0.19',
        null,
      ]);
      // And the tax stored with it, which the portal labels from.
      expect(body.sessions.map((s: { taxCents: number | null }) => s.taxCents)).toEqual([
        160,
        null,
      ]);
      expect(body.totals).toEqual({
        totalCostCents: 2000,
        currency: 'EUR',
        totalEnergyWh: 40000,
        totalCo2AvoidedKg: 7,
        sessionCount: 2,
      });
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
            tariffTaxRate: null,
            taxCents: null,
            currency: 'EUR',
            stationName: 'Station B',
            siteName: 'Site Beta',
            siteCity: 'Austin',
            siteAddress: null,
            siteState: null,
            co2AvoidedKg: null,
            reservationId: null,
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
