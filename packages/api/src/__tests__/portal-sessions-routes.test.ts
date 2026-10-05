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

vi.mock('../lib/session-limit.js', () => ({ sessionLimitReached: vi.fn(async () => null) }));

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
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  paymentRecords: {},
  meterValues: {},
  drivers: {},
  driverTokens: {},
  vehicles: {},
  vehicleEfficiencyLookup: {},
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
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalSessionRoutes } from '../routes/portal/sessions.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const DRIVER_ID = 'drv_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalSessionRoutes);
  await app.ready();
  return app;
}

describe('Portal sessions routes - handler logic', () => {
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
  });

  describe('GET /v1/portal/sessions', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns paginated sessions for authenticated driver', async () => {
      setupDbResults(
        [
          {
            id: VALID_SESSION_ID,
            transactionId: 'tx-1',
            status: 'completed',
            startedAt: '2024-01-01T00:00:00Z',
            endedAt: '2024-01-01T01:00:00Z',
            energyDeliveredWh: 10000,
            finalCostCents: 500,
            tariffTaxRate: '0.19',
            taxCents: 80,
            currency: 'USD',
            stationName: 'CS-001',
            siteName: 'Site A',
            siteAddress: '123 Main St',
            siteCity: 'Austin',
            siteState: 'TX',
            co2AvoidedKg: null,
            reservationId: null,
          },
        ],
        [{ count: 1 }],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions?page=1&limit=10',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(VALID_SESSION_ID);
      expect(body.data[0].status).toBe('completed');
      expect(body.data[0].tariffTaxRate).toBe('0.19');
      expect(body.data[0].taxCents).toBe(80);
    });

    it('returns empty data with zero total when no sessions', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('uses default pagination when no query params', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 400 for a month outside 01-12', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions?month=2024-13',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 with invalid page parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions?page=0',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 with invalid limit parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions?limit=999',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/portal/sessions/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 403 when session belongs to another driver', async () => {
      setupDbResults([
        {
          id: VALID_SESSION_ID,
          transactionId: 'tx-1',
          status: 'completed',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: '2024-01-01T01:00:00Z',
          energyDeliveredWh: 10000,
          currentCostCents: null,
          tariffTaxRate: '0.19',
          finalCostCents: 500,
          currency: 'USD',
          meterStart: 0,
          meterStop: 10000,
          stoppedReason: 'EVDisconnected',
          stationName: 'CS-001',
          siteName: 'Site A',
          driverId: 'other-driver-id',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('FORBIDDEN');
    });

    it('returns session detail with payment when session belongs to driver', async () => {
      setupDbResults(
        [
          {
            id: VALID_SESSION_ID,
            transactionId: 'tx-1',
            status: 'completed',
            startedAt: '2024-01-01T00:00:00Z',
            endedAt: '2024-01-01T01:00:00Z',
            energyDeliveredWh: 10000,
            currentCostCents: null,
            tariffTaxRate: '0.19',
            finalCostCents: 500,
            // The split stored with the final cost (as read back from jsonb).
            costBreakdown: {
              basis: 'net',
              netCents: 420,
              taxCents: 80,
              grossCents: 500,
              taxLines: [{ taxRate: 0.19, netCents: 420, taxCents: 80 }],
              components: null,
            },
            currency: 'USD',
            meterStart: 0,
            meterStop: 10000,
            stoppedReason: 'EVDisconnected',
            stationName: 'CS-001',
            siteName: 'Site A',
            siteAddress: '123 Main St',
            siteCity: 'Austin',
            siteState: 'TX',
            driverId: DRIVER_ID,
            updatedAt: '2024-01-01T01:00:00Z',
            idleStartedAt: null,
            co2AvoidedKg: null,
            reservationId: null,
          },
        ],
        [
          {
            id: 1,
            status: 'captured',
            paymentSource: 'stripe',
            currency: 'USD',
            preAuthAmountCents: 5000,
            capturedAmountCents: null,
            refundedAmountCents: 0,
            failureReason: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(VALID_SESSION_ID);
      expect(body.status).toBe('completed');
      expect(body.tariffTaxRate).toBe('0.19');
      expect(body.netCents).toBe(420);
      expect(body.taxCents).toBe(80);
      expect(body.taxRate).toBe('0.19');
      // The stored breakdown is not part of the response.
      expect(body).not.toHaveProperty('costBreakdown');
      expect(body.payment).toBeDefined();
      expect(body.payment.status).toBe('captured');
    });

    it('returns no tax split when the cost contains no tax or the split is not known', async () => {
      setupDbResults(
        [
          {
            id: VALID_SESSION_ID,
            transactionId: 'tx-1',
            status: 'active',
            startedAt: '2024-01-01T00:00:00Z',
            endedAt: null,
            energyDeliveredWh: 10000,
            currentCostCents: 350,
            tariffTaxRate: null,
            finalCostCents: null,
            // A breakdown stored for another amount is not used.
            costBreakdown: {
              basis: 'net',
              netCents: 252,
              taxCents: 48,
              grossCents: 300,
              taxLines: [{ taxRate: 0.19, netCents: 252, taxCents: 48 }],
              components: null,
            },
            currency: 'USD',
            meterStart: 0,
            meterStop: null,
            stoppedReason: null,
            stationName: 'CS-001',
            siteName: null,
            siteAddress: null,
            siteCity: null,
            siteState: null,
            driverId: DRIVER_ID,
            updatedAt: '2024-01-01T01:00:00Z',
            idleStartedAt: null,
            co2AvoidedKg: null,
            reservationId: null,
          },
        ],
        [],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.netCents).toBeNull();
      expect(body.taxCents).toBeNull();
      expect(body.taxRate).toBeNull();
    });

    it('returns session detail with null payment when no payment record', async () => {
      setupDbResults(
        [
          {
            id: VALID_SESSION_ID,
            transactionId: 'tx-1',
            status: 'completed',
            startedAt: '2024-01-01T00:00:00Z',
            endedAt: '2024-01-01T01:00:00Z',
            energyDeliveredWh: 10000,
            currentCostCents: null,
            tariffTaxRate: '0.19',
            finalCostCents: 0,
            currency: 'USD',
            meterStart: 0,
            meterStop: 10000,
            stoppedReason: null,
            stationName: 'CS-001',
            siteName: null,
            siteAddress: null,
            siteCity: null,
            siteState: null,
            driverId: DRIVER_ID,
            updatedAt: '2024-01-01T01:00:00Z',
            idleStartedAt: null,
            co2AvoidedKg: null,
            reservationId: null,
          },
        ],
        [],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: `/portal/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(VALID_SESSION_ID);
      expect(body.payment).toBeNull();
    });

    it('returns 400 with invalid id parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/sessions/not-a-nanoid',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
