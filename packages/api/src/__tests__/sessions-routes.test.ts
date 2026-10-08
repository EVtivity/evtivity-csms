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

const rebill = vi.hoisted(() => ({
  authorizeCalls: [] as string[][],
  rebillSession: vi.fn(),
  getSessionRebillState: vi.fn(),
}));

vi.mock('../services/session-rebill.service.js', async () => {
  const { AppError } = await import('@evtivity/lib');
  class SessionRebillRefusedError extends AppError {
    readonly reason: string;
    constructor(reason: string) {
      super('Session cannot be re-billed', 409, 'SESSION_REBILL_NOT_ELIGIBLE');
      this.reason = reason;
    }
  }
  return {
    rebillSession: rebill.rebillSession,
    getSessionRebillState: rebill.getSessionRebillState,
    SessionRebillRefusedError,
  };
});

vi.mock('../middleware/rbac.js', () => ({
  authorize: (...permissions: string[]) => {
    rebill.authorizeCalls.push(permissions);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    };
  },
  invalidatePermissionCache: vi.fn(),
}));

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
  drivers: {},
  driverTokens: {},
  transactionEvents: {},
  transactionEventTypeEnum: {
    enumValues: ['Started', 'Updated', 'Ended'] as const,
  },
  paymentRecords: {},
  paymentStatusEnum: {
    enumValues: [
      'pending',
      'pre_authorized',
      'captured',
      'partially_refunded',
      'refunded',
      'failed',
      'cancelled',
    ] as const,
  },
  meterValues: {},
  guestSessions: {},
  vehicles: {},
  sessionStatusEnum: {
    enumValues: ['active', 'completed', 'invalid', 'faulted', 'failed'] as const,
  },
  SESSION_REBILL_STATUSES: ['in_progress', 'billed', 'manual'] as const,
  SESSION_END_FAILED_REASON: 'EndRequestFailed',
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
    inArray: vi.fn(),
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
import * as drizzleOrmModule from 'drizzle-orm';

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
          billingMode: null,
          billingFleetId: null,
          billingFleetName: null,
          invoiceId: null,
          invoiceStatus: null,
          rebillStatus: null,
          rebillClaimedAt: null,
          co2AvoidedKg: null,
          electricityCostCents: null,
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
      const { ilike } = drizzleOrmModule;

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
          billingMode: null,
          billingFleetId: null,
          billingFleetName: null,
          invoiceId: null,
          invoiceStatus: null,
          rebillStatus: null,
          rebillClaimedAt: null,
          co2AvoidedKg: null,
          electricityCostCents: null,
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
          billingMode: null,
          billingFleetId: null,
          billingFleetName: null,
          invoiceId: null,
          invoiceStatus: null,
          rebillStatus: null,
          rebillClaimedAt: null,
          co2AvoidedKg: null,
          electricityCostCents: null,
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
          billingMode: null,
          billingFleetId: null,
          billingFleetName: null,
          invoiceId: null,
          invoiceStatus: null,
          rebillStatus: null,
          rebillClaimedAt: null,
          co2AvoidedKg: null,
          electricityCostCents: null,
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
      const { eq, isNotNull } = drizzleOrmModule;

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
          billingMode: null,
          billingFleetId: null,
          billingFleetName: null,
          invoiceId: null,
          invoiceStatus: null,
          rebillStatus: null,
          rebillClaimedAt: null,
          co2AvoidedKg: null,
          electricityCostCents: null,
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
        siteId: null,
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
        billingMode: null,
        billingFleetId: null,
        billingFleetName: null,
        invoiceId: null,
        invoiceStatus: null,
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: null,
        guestEmail: null,
        guestStatus: null,
        guestPreAuthAmountCents: null,
        guestProvider: null,
        guestProviderPaymentId: null,
        guestExpiresAt: null,
        guestCreatedAt: null,
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
      expect(body.rebillable).toBe(false);
      expect(body.rebillBlockedReason).toBe('status');
      expect(rebill.getSessionRebillState).not.toHaveBeenCalled();
    });

    it('returns the billing stamp, billing fleet and invoice of an account session', async () => {
      const session = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: 'Site A',
        siteId: null,
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
        billingMode: 'account',
        billingFleetId: 'flt_000000000001',
        billingFleetName: 'Acme',
        invoiceId: 'inv_000000000001',
        invoiceStatus: 'issued',
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: null,
        guestEmail: null,
        guestStatus: null,
        guestPreAuthAmountCents: null,
        guestProvider: null,
        guestProviderPaymentId: null,
        guestExpiresAt: null,
        guestCreatedAt: null,
      };
      // session query, transaction events query, payment records query
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        billingMode: 'account',
        billingFleetId: 'flt_000000000001',
        billingFleetName: 'Acme',
        invoiceId: 'inv_000000000001',
        invoiceStatus: 'issued',
      });
    });

    it('reports whether a session the CSMS gave up ending can be re-billed now', async () => {
      const session: Record<string, unknown> = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: 'Site A',
        siteId: null,
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
        billingMode: null,
        billingFleetId: null,
        billingFleetName: null,
        invoiceId: null,
        invoiceStatus: null,
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: null,
        guestEmail: null,
        guestStatus: null,
        guestPreAuthAmountCents: null,
        guestProvider: null,
        guestProviderPaymentId: null,
        guestExpiresAt: null,
        guestCreatedAt: null,
      };
      Object.assign(session, {
        status: 'faulted',
        stoppedReason: 'EndRequestFailed',
        rebillStatus: 'in_progress',
        rebillClaimedAt: '2026-10-01T10:00:00.000Z',
      });
      rebill.getSessionRebillState.mockResolvedValueOnce({
        rebillable: true,
        blockedReason: null,
      });
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(rebill.getSessionRebillState).toHaveBeenCalledWith(VALID_SESSION_ID);
      expect(body.rebillable).toBe(true);
      expect(body.rebillBlockedReason).toBeNull();
      expect(body.rebillClaimedAt).toBe('2026-10-01T10:00:00.000Z');
    });

    it('returns the pending operation and refund ledger of the payment', async () => {
      const session: Record<string, unknown> = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: 'Site A',
        siteId: null,
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
        billingMode: null,
        billingFleetId: null,
        billingFleetName: null,
        invoiceId: null,
        invoiceStatus: null,
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: null,
        guestEmail: null,
        guestStatus: null,
        guestPreAuthAmountCents: null,
        guestProvider: null,
        guestProviderPaymentId: null,
        guestExpiresAt: null,
        guestCreatedAt: null,
      };
      Object.assign(session, {
        paymentId: 'pr_1',
        paymentStatus: 'captured',
        paymentSource: 'card_on_file',
        paymentCurrency: 'USD',
        preAuthAmountCents: 5000,
        capturedAmountCents: 3000,
        refundedAmountCents: 0,
        pendingOperation: 'capture',
        providerRefunds: [
          {
            refundId: 'REF_1',
            paymentId: 'PSP_1',
            amountCents: 500,
            state: 'pending',
            requestedAt: '2026-10-01T10:00:00.000Z',
          },
        ],
      });
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.paymentRecord.pendingOperation).toBe('capture');
      expect(body.paymentRecord.providerRefunds).toEqual([
        expect.objectContaining({ refundId: 'REF_1', state: 'pending', amountCents: 500 }),
      ]);
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
        siteId: null,
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
        currency: 'EUR',
        stoppedReason: null,
        reservationId: null,
        freeVend: false,
        billingMode: null,
        billingFleetId: null,
        billingFleetName: null,
        invoiceId: null,
        invoiceStatus: null,
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: null,
        guestEmail: null,
        guestStatus: null,
        guestPreAuthAmountCents: null,
        guestProvider: null,
        guestProviderPaymentId: null,
        guestExpiresAt: null,
        guestCreatedAt: null,
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
      expect(body.currency).toBe('EUR');
      expect(body.paymentRecord).toBeNull();
    });
    it('returns the guest provider fields next to the deprecated Stripe field', async () => {
      const session = {
        id: VALID_SESSION_ID,
        stationId: VALID_STATION_ID,
        stationName: 'Station-01',
        siteName: null,
        siteId: null,
        driverId: null,
        driverName: null,
        transactionId: 'txn-guest',
        status: 'completed',
        startedAt: '2024-06-01T10:00:00Z',
        endedAt: '2024-06-01T11:00:00Z',
        idleStartedAt: null,
        energyDeliveredWh: '10000',
        currentCostCents: null,
        finalCostCents: 800,
        currency: 'USD',
        stoppedReason: null,
        reservationId: null,
        freeVend: false,
        billingMode: null,
        billingFleetId: null,
        billingFleetName: null,
        invoiceId: null,
        invoiceStatus: null,
        rebillStatus: null,
        rebillClaimedAt: null,
        co2AvoidedKg: null,
        electricityCostCents: null,
        metadata: null,
        tokenId: null,
        tokenIdToken: null,
        tokenType: null,
        vehicleId: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        paymentId: null,
        paymentStatus: null,
        paymentSource: null,
        paymentCurrency: null,
        preAuthAmountCents: null,
        capturedAmountCents: null,
        refundedAmountCents: null,
        failureReason: null,
        guestSessionToken: 'tok_guest',
        guestEmail: 'guest@example.com',
        guestStatus: 'completed',
        guestPreAuthAmountCents: 2000,
        guestProvider: 'stripe',
        guestProviderPaymentId: 'pi_guest',
        guestExpiresAt: '2024-06-02T10:00:00Z',
        guestCreatedAt: '2024-06-01T09:55:00Z',
      };
      setupDbResults([session], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().guestSession).toMatchObject({
        sessionToken: 'tok_guest',
        provider: 'stripe',
        providerPaymentId: 'pi_guest',
      });
      expect(response.json().guestSession).not.toHaveProperty('stripePaymentIntentId');
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
      const { eq } = drizzleOrmModule;

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

  describe('POST /v1/sessions/:id/rebill', () => {
    const result = {
      sessionId: VALID_SESSION_ID,
      rebillStatus: 'billed',
      result: 'charged',
      manualReason: null,
      finalCostCents: 1190,
      currency: 'EUR',
      endedAt: new Date('2026-06-04T01:00:00Z'),
      paymentRecordId: 9,
      failureReason: null,
    };

    beforeEach(() => {
      rebill.rebillSession.mockReset();
    });

    it('requires both sessions:write and payments:write', () => {
      expect(rebill.authorizeCalls).toContainEqual(['sessions:write', 'payments:write']);
    });

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/rebill`,
      });
      expect(response.statusCode).toBe(401);
      expect(rebill.rebillSession).not.toHaveBeenCalled();
    });

    it('bills the session through the service with the actor and site scope', async () => {
      rebill.rebillSession.mockResolvedValueOnce(result);
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/rebill`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...result, endedAt: '2026-06-04T01:00:00.000Z' });
      expect(rebill.rebillSession).toHaveBeenCalledWith(
        VALID_SESSION_ID,
        expect.objectContaining({
          siteIds: null,
          actor: expect.objectContaining({ actor: 'operator', actorUserId: 'test-id' }) as unknown,
        }),
      );
    });

    it('answers 409 with the refusal reason', async () => {
      const { SessionRebillRefusedError } = await import('../services/session-rebill.service.js');
      rebill.rebillSession.mockRejectedValueOnce(new SessionRebillRefusedError('paid'));
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/rebill`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Session cannot be re-billed',
        code: 'SESSION_REBILL_NOT_ELIGIBLE',
        details: { reason: 'paid' },
      });
    });

    it('answers 400 when the payment provider cannot be reached', async () => {
      const { PaymentProviderUnavailableError } = await import('@evtivity/payments');
      rebill.rebillSession.mockRejectedValueOnce(new PaymentProviderUnavailableError('timeout'));
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/rebill`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PAYMENT_PROVIDER_CONNECTION_FAILED' });
    });

    it('rejects an invalid session id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions/not-a-session/rebill',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(rebill.rebillSession).not.toHaveBeenCalled();
    });
  });
});
