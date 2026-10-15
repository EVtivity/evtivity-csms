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

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  ACCOUNT_INVOICE_RECIPIENTS: ['fleet', 'member'],
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
      setupDbResults(
        [{ timezone: 'America/New_York' }], // the driver's timezone sets the month
        [
          {
            totalCostCents: 5000,
            totalEnergyWh: '45000',
            totalCo2AvoidedKg: '7.5',
            sessionCount: 3,
          },
        ],
      );
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
      setupDbResults([{ timezone: 'UTC' }], []);
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
      // Each session carries the tax stored with it, which clients label the cost from.
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
        otherCurrencySessionCount: 0,
        fleetBilledSessionCount: 0,
      });
    });

    it('leaves fleet-invoiced and earlier-currency sessions out of the total and counts them', async () => {
      const row = (
        id: string,
        cents: number,
        currency: string,
        billing: Record<string, unknown>,
      ) => ({
        id,
        startedAt: '2026-02-10T10:00:00Z',
        endedAt: '2026-02-10T11:00:00Z',
        energyDeliveredWh: '1000',
        co2AvoidedKg: null,
        finalCostCents: cents,
        taxCents: null,
        currency,
        siteName: 'Site Alpha',
        siteCity: 'Austin',
        billingMode: null,
        billingFleetName: null,
        billingInvoiceStatus: null,
        billingHasPaymentRecord: false,
        billingMemberBilled: false,
        billingInvoiceId: null,
        billingInvoiceNumber: null,
        ...billing,
      });
      setupDbResults(
        [{ firstName: 'John', lastName: 'Doe', timezone: 'Europe/Berlin' }],
        [
          row('ses_card', 1000, 'EUR', {}),
          row('ses_fleet', 700, 'EUR', { billingMode: 'account', billingFleetName: 'Acme' }),
          row('ses_member', 300, 'EUR', {
            billingMode: 'account',
            billingFleetName: 'Acme',
            billingMemberBilled: true,
          }),
          row('ses_usd', 900, 'USD', {}),
        ],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/monthly-statement?month=2026-02',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // The member-billed session is the driver's to pay: it stays in.
      expect(body.totals).toMatchObject({
        totalCostCents: 1300,
        sessionCount: 4,
        otherCurrencySessionCount: 1,
        fleetBilledSessionCount: 1,
      });
      const fleet = body.sessions.find((s: { id: string }) => s.id === 'ses_fleet');
      expect(fleet.accountBilling).toMatchObject({ fleetName: 'Acme', invoicedTo: 'fleet' });
      expect(fleet).not.toHaveProperty('billingMode');
    });
  });

  describe('GET /v1/portal/sessions with month filter', () => {
    it('accepts month query parameter', async () => {
      setupDbResults(
        [{ timezone: 'America/Chicago' }],
        [
          {
            id: 'ses_000000000001',
            transactionId: 'tx-1',
            status: 'completed',
            startedAt: '2026-02-15T10:00:00Z',
            endedAt: '2026-02-15T11:00:00Z',
            energyDeliveredWh: '20000',
            finalCostCents: 1000,
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
