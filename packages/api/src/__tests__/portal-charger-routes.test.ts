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
    execute: vi.fn(() => Promise.resolve([{ nextval: '42', next_val: '6' }])),
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
  client: {},
  chargingStations: {},
  evses: {},
  connectors: {},
  sites: {},
  chargingSessions: {},
  driverPaymentMethods: {},
  paymentRecords: {},
  reservations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

const mockPgEnd = vi.fn().mockResolvedValue(undefined);
const mockPgTagged = vi.fn().mockResolvedValue([]);
vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const fn = mockPgTagged as unknown as Record<string, unknown>;
    fn.end = mockPgEnd;
    return fn;
  }),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn().mockResolvedValue(null),
  createPreAuthorization: vi.fn().mockResolvedValue({ id: 'pi_test_123' }),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: vi.fn().mockResolvedValue(null),
  isTariffFree: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    response: { status: 'Accepted' },
    error: null,
  }),
}));

vi.mock('../lib/reservation-buffer.js', () => ({
  isEvseInReservationBuffer: vi.fn().mockResolvedValue(false),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: vi.fn(),
  };
});

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';
import { getStripeConfig } from '../services/stripe.service.js';
import { resolveTariff, isTariffFree } from '../services/tariff.service.js';
import { isEvseInReservationBuffer } from '../lib/reservation-buffer.js';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';
const VALID_RESERVATION_ID = 'rsv_000000000001';
const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

describe('Portal charger routes - handler logic', () => {
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
    vi.mocked(getStripeConfig).mockResolvedValue(null);
    vi.mocked(resolveTariff).mockResolvedValue(null);
    vi.mocked(isTariffFree).mockReturnValue(true);
    vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
  });

  describe('GET /v1/portal/chargers/:stationId/evse/:evseId', () => {
    it('returns 404 when station is not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when EVSE is not found', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            model: 'M1',
            isOnline: true,
            siteName: null,
            siteAddress: null,
            siteCity: null,
            siteState: null,
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns charger info with paymentEnabled false when no stripe config', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: '123 Main',
            siteCity: 'City',
            siteState: 'CA',
          },
        ],
        [{ id: 'evs_000000000001', evseId: 1, status: 'available' }],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150',
            maxCurrentAmps: null,
            status: 'available',
          },
        ],
      );
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.stationId).toBe('CS-001');
      expect(body.paymentEnabled).toBe(false);
      expect(body.evse.evseId).toBe(1);
      expect(body.evse.connectors).toHaveLength(1);
    });

    it('returns paymentEnabled true when stripe config exists', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: 'site-1',
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: '123 Main',
            siteCity: 'City',
            siteState: 'CA',
          },
        ],
        [{ id: 'evs_000000000001', evseId: 1, status: 'available' }],
        [],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: 1,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().paymentEnabled).toBe(true);
    });
  });

  describe('GET /v1/portal/chargers/:stationId/pricing', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station is not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when no tariff found', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveTariff).mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PRICING_NOT_FOUND');
    });

    it('returns resolved pricing for driver', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveTariff).mockResolvedValue({
        id: 'tar_001',
        name: 'Standard',
        currency: 'USD',
        pricePerKwh: '0.25',
        pricePerMinute: '0.10',
        pricePerSession: '2.00',
        idleFeePricePerMinute: '0.05',
        reservationFeePerMinute: null,
        taxRate: '0.08',
        restrictions: null,
        priority: 0,
        isDefault: true,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.currency).toBe('USD');
      expect(body.pricePerKwh).toBe('0.25');
      expect(body.pricePerMinute).toBe('0.10');
      expect(body.pricePerSession).toBe('2.00');
      expect(body.idleFeePricePerMinute).toBe('0.05');
      expect(body.taxRate).toBe('0.08');
    });

    it('calls resolveTariff with station UUID and driver ID', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveTariff).mockResolvedValue({
        id: 'tar_001',
        name: 'Driver Rate',
        currency: 'EUR',
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        restrictions: null,
        priority: 0,
        isDefault: false,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(resolveTariff).toHaveBeenCalledWith(VALID_STATION_ID, DRIVER_ID);
    });
  });

  describe('GET /v1/portal/chargers/search', () => {
    it('returns search results', async () => {
      setupDbResults(
        [
          {
            stationId: 'CS-001',
            stationUuid: 'uuid-001',
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            evseCount: 2,
            availableCount: 1,
          },
          {
            stationId: 'CS-002',
            stationUuid: 'uuid-002',
            model: 'M2',
            isOnline: false,
            siteName: 'Site B',
            evseCount: 1,
            availableCount: 0,
          },
        ],
        [], // connector rows
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/search?q=CS',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0].stationId).toBe('CS-001');
      expect(body[0].availableCount).toBe(1);
      expect(body[0].connectors).toEqual([]);
    });

    it('returns 400 when q parameter is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/search',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /v1/portal/chargers/:stationId/evse/:evseId/start', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([
        {
          id: VALID_STATION_ID,
          stationId: 'CS-001',
          siteId: null,
          isOnline: false,
          onboardingStatus: 'accepted',
          ocppProtocol: 'ocpp2.1',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 400 when connector is not available', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'faulted' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_NOT_AVAILABLE');
    });

    it('returns 400 when payment is required but no paymentMethodId provided', async () => {
      vi.mocked(isTariffFree).mockReturnValue(false);
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: 'site-1',
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: 1,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_METHOD_REQUIRED');
    });

    it('starts charging session without payment when stripe not configured', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [],
        [{ id: VALID_SESSION_ID }],
      );
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
    });
  });

  describe('GET /v1/portal/chargers/sessions/active', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns active sessions for authenticated driver', async () => {
      setupDbResults([
        {
          id: 's1',
          stationId: 'CS-001',
          transactionId: 'tx1',
          startedAt: '2024-01-01',
          energyDeliveredWh: 1000,
          currentCostCents: 500,
          currency: 'USD',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0].id).toBe('s1');
    });

    it('returns empty data array when no active sessions', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
    });
  });

  describe('POST /v1/portal/chargers/sessions/:sessionId/stop', () => {
    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('stops an active session', async () => {
      setupDbResults([{ id: VALID_SESSION_ID, transactionId: 'tx-123', stationOcppId: 'CS-001' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('stopping');
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
    });
  });

  describe('GET /v1/portal/reservations', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/reservations',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns reservations for authenticated driver', async () => {
      setupDbResults([
        {
          id: 'r1',
          reservationId: 1,
          stationOcppId: 'CS-001',
          status: 'active',
          expiresAt: '2025-01-01',
          createdAt: '2024-12-01',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
    });
  });

  describe('POST /v1/portal/reservations', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-999',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([{ id: VALID_STATION_ID, isOnline: false, onboardingStatus: 'accepted' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('creates a reservation', async () => {
      const reservationData = {
        id: VALID_RESERVATION_ID,
        reservationId: 1,
        stationId: VALID_STATION_ID,
        driverId: null,
        status: 'active',
        expiresAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // DB call 1: station lookup
      // DB call 2: conflict check (no conflicts)
      // DB call 3: insert returning reservation
      // getNextReservationId uses db.execute (sequence)
      setupDbResults(
        [{ id: VALID_STATION_ID, isOnline: true, onboardingStatus: 'accepted' }],
        [],
        [reservationData],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(VALID_RESERVATION_ID);
    });
  });

  describe('DELETE /v1/portal/reservations/:id', () => {
    it('returns 404 when reservation not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([
        { id: VALID_STATION_ID, reservationId: 1, status: 'expired', stationOcppId: 'CS-001' },
      ]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('cancels an active reservation', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID, reservationId: 1, status: 'active', stationOcppId: 'CS-001' }],
        [],
      );
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('cancelled');
    });
  });

  describe('POST /v1/portal/chargers/:stationId/evse/:evseId/start - reservation buffer', () => {
    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'CS-001',
      siteId: null,
      isOnline: true,
      onboardingStatus: 'accepted',
      ocppProtocol: 'ocpp2.1',
    };
    const evseRow = { id: 'evs_000000000001' };
    const connectorRow = { status: 'available' };
    const existingSessionsEmpty: unknown[] = [];

    it('returns 409 when EVSE has a reservation starting within the buffer window', async () => {
      setupDbResults([stationRow], [evseRow], [connectorRow], existingSessionsEmpty);
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('RESERVATION_BUFFER_ACTIVE');
    });

    it('allows session start when reservation starts outside the buffer window', async () => {
      setupDbResults([stationRow], [evseRow], [connectorRow], existingSessionsEmpty, [
        { id: VALID_SESSION_ID },
      ]);
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
    });

    it('allows session start when buffer is disabled (bufferMinutes=0)', async () => {
      setupDbResults([stationRow], [evseRow], [connectorRow], existingSessionsEmpty, [
        { id: VALID_SESSION_ID },
      ]);
      // bufferMinutes=0 means isEvseInReservationBuffer returns false immediately
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
