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
  drivers: {},
  transactionEvents: {},
  paymentRecords: {},
  meterValues: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (..._args: unknown[]) => ({ as: vi.fn() });
  const sqlFn = Object.assign(sqlTag, { raw: vi.fn(() => ({ as: vi.fn() })) });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    isNotNull: vi.fn(),
    sql: sqlFn,
    desc: vi.fn(),
    count: vi.fn(),
    asc: vi.fn(),
  };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { sessionRoutes } from '../routes/sessions.js';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    sessionRoutes(instance);
  });
  await app.ready();
  return app;
}

describe('Session routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  describe('GET /v1/sessions', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sessions',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns paginated sessions with defaults', async () => {
      const sessions = [
        {
          id: VALID_SESSION_ID,
          stationId: VALID_STATION_ID,
          stationName: 'Station-01',
          siteName: 'Site A',
          driverId: null,
          driverName: null,
          transactionId: 'txn-001',
          status: 'active',
          startedAt: '2024-06-01T10:00:00Z',
          endedAt: null,
          idleStartedAt: null,
          energyDeliveredWh: '5000',
          currentCostCents: 250,
          finalCostCents: null,
          currency: 'USD',
          freeVend: false,
          co2AvoidedKg: null,
          createdAt: '2024-06-01T10:00:00Z',
          _total: 1,
        },
      ];
      setupDbResults(sessions);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(VALID_SESSION_ID);
      expect(body.data[0].stationName).toBe('Station-01');
      expect(body.data[0].siteName).toBe('Site A');
      expect(body.data[0].transactionId).toBe('txn-001');
      expect(body.data[0].status).toBe('active');
    });

    it('returns empty list when no sessions exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns total 0 when count row is missing', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('accepts page and limit query params', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?page=2&limit=5',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('applies search filter via ilike on transactionId', async () => {
      const { ilike } = await import('drizzle-orm');

      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?search=txn-123',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(ilike).toHaveBeenCalled();
    });

    it('returns multiple sessions with correct pagination total', async () => {
      const sessions = [
        {
          id: 'ses_000000000002',
          stationId: VALID_STATION_ID,
          stationName: 'Station-01',
          siteName: 'Site A',
          driverId: null,
          driverName: null,
          transactionId: 'txn-001',
          status: 'completed',
          startedAt: '2024-06-01T10:00:00Z',
          endedAt: '2024-06-01T11:00:00Z',
          idleStartedAt: null,
          energyDeliveredWh: '15000',
          currentCostCents: null,
          finalCostCents: 750,
          currency: 'USD',
          freeVend: false,
          co2AvoidedKg: null,
          createdAt: '2024-06-01T10:00:00Z',
          _total: 25,
        },
        {
          id: 'ses_000000000003',
          stationId: VALID_STATION_ID,
          stationName: 'Station-02',
          siteName: null,
          driverId: null,
          driverName: null,
          transactionId: null,
          status: 'active',
          startedAt: '2024-06-02T08:00:00Z',
          endedAt: null,
          idleStartedAt: null,
          energyDeliveredWh: null,
          currentCostCents: 100,
          finalCostCents: null,
          currency: null,
          freeVend: false,
          co2AvoidedKg: null,
          createdAt: '2024-06-02T08:00:00Z',
          _total: 25,
        },
      ];
      setupDbResults(sessions);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?page=1&limit=2',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(25);
      expect(body.data[0].status).toBe('completed');
      expect(body.data[1].siteName).toBeNull();
    });

    it('returns 400 for invalid page param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sessions?page=0',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for invalid limit param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sessions?limit=200',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('handles search with no matching results', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?search=nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('handles search combined with pagination', async () => {
      const sessions = [
        {
          id: VALID_SESSION_ID,
          stationId: VALID_STATION_ID,
          stationName: 'Station-01',
          siteName: 'Site A',
          driverId: null,
          driverName: null,
          transactionId: 'txn-match-001',
          status: 'completed',
          startedAt: '2024-06-01T10:00:00Z',
          endedAt: '2024-06-01T11:00:00Z',
          idleStartedAt: null,
          energyDeliveredWh: '10000',
          currentCostCents: null,
          finalCostCents: 500,
          currency: 'EUR',
          freeVend: false,
          co2AvoidedKg: null,
          createdAt: '2024-06-01T10:00:00Z',
          _total: 3,
        },
      ];
      setupDbResults(sessions);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?search=txn-match&page=1&limit=1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(3);
    });

    it('accepts idling status filter', async () => {
      const { eq, isNotNull } = await import('drizzle-orm');

      const sessions = [
        {
          id: VALID_SESSION_ID,
          stationId: VALID_STATION_ID,
          stationName: 'Station-01',
          siteName: 'Site A',
          driverId: null,
          driverName: null,
          transactionId: 'txn-001',
          status: 'active',
          startedAt: '2024-06-01T10:00:00Z',
          endedAt: null,
          idleStartedAt: '2024-06-01T10:30:00Z',
          energyDeliveredWh: '5000',
          currentCostCents: 250,
          finalCostCents: null,
          currency: 'USD',
          freeVend: false,
          co2AvoidedKg: null,
          createdAt: '2024-06-01T10:00:00Z',
          _total: 1,
        },
      ];
      setupDbResults(sessions);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?status=idling',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].idleStartedAt).toBe('2024-06-01T10:30:00Z');
      expect(eq).toHaveBeenCalled();
      expect(isNotNull).toHaveBeenCalled();
    });
  });

  describe('GET /v1/sessions/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns session details when found', async () => {
      const session = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: 'Site A',
        driverId: null,
        driverName: null,
        transactionId: 'txn-001',
        status: 'completed',
        startedAt: '2024-06-01T10:00:00Z',
        endedAt: '2024-06-01T11:00:00Z',
        idleStartedAt: null,
        energyDeliveredWh: '20000',
        currentCostCents: null,
        finalCostCents: 1000,
        currency: 'USD',
        stoppedReason: null,
        reservationId: null,
        freeVend: false,
        co2AvoidedKg: null,
      };
      // session query, transaction events query, payment records query
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(VALID_SESSION_ID);
      expect(body.transactionId).toBe('txn-001');
      expect(body.status).toBe('completed');
      expect(body.finalCostCents).toBe(1000);
      expect(body.currency).toBe('USD');
      expect(body.paymentRecord).toBeNull();
    });

    it('returns 404 when session not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('Session not found');
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 400 for invalid id param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sessions/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns session with null optional fields', async () => {
      const session = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: null,
        driverId: null,
        driverName: null,
        transactionId: null,
        status: 'active',
        startedAt: '2024-06-01T10:00:00Z',
        endedAt: null,
        idleStartedAt: null,
        energyDeliveredWh: null,
        currentCostCents: null,
        finalCostCents: null,
        currency: null,
        stoppedReason: null,
        reservationId: null,
        freeVend: false,
        co2AvoidedKg: null,
      };
      // session query, transaction events query, payment records query
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(VALID_SESSION_ID);
      expect(body.transactionId).toBeNull();
      expect(body.endedAt).toBeNull();
      expect(body.energyDeliveredWh).toBeNull();
      expect(body.currentCostCents).toBeNull();
      expect(body.finalCostCents).toBeNull();
      expect(body.currency).toBeNull();
      expect(body.paymentRecord).toBeNull();
    });
  });

  describe('GET /v1/sessions/:id/meter-values', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/meter-values`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 for unknown session', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/meter-values`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns paginated meter values with correct shape', async () => {
      const meterValue = {
        id: 1,
        timestamp: '2024-06-01T10:05:00Z',
        measurand: 'Energy.Active.Import.Register',
        value: '5000',
        unit: 'Wh',
        phase: null,
        location: 'Outlet',
        context: 'Sample.Periodic',
        source: 'MeterValues',
      };
      // session lookup, meter values data, meter values count
      setupDbResults([{ id: VALID_SESSION_ID }], [meterValue], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/meter-values`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].measurand).toBe('Energy.Active.Import.Register');
      expect(body.data[0].value).toBe('5000');
      expect(body.data[0].source).toBe('MeterValues');
    });

    it('accepts measurand filter', async () => {
      const { eq } = await import('drizzle-orm');

      setupDbResults([{ id: VALID_SESSION_ID }], [], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/meter-values?measurand=Voltage`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
      // eq should be called for both session_id filter and measurand filter
      expect(eq).toHaveBeenCalled();
    });
  });
});
