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
  chargingStations: {},
  evses: {},
  connectors: {},
  guestSessions: {},
  chargingSessions: {},
  meterValues: {},
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

const mockStripePaymentIntentsCreate = vi.fn().mockResolvedValue({ id: 'pi_guest_123' });
vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: vi.fn().mockResolvedValue(null),
  isTariffFree: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/reservation-buffer.js', () => ({
  isEvseInReservationBuffer: vi.fn().mockResolvedValue(false),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalGuestRoutes } from '../routes/portal/guest.js';
import { getStripeConfig } from '../services/stripe.service.js';
import { isTariffFree } from '../services/tariff.service.js';
import { isEvseInReservationBuffer } from '../lib/reservation-buffer.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalGuestRoutes);
  await app.ready();
  return app;
}

describe('Portal guest routes - handler logic', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getStripeConfig).mockResolvedValue(null);
    vi.mocked(isTariffFree).mockReturnValue(true);
    vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
  });

  describe('GET /v1/portal/guest/charger-config/:stationId/:evseId', () => {
    it('returns 404 when station is not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when EVSE does not exist', async () => {
      setupDbResults([{ id: 'sta_000000000001', siteId: null }], []);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns paymentEnabled false when no stripe config', async () => {
      setupDbResults([{ id: 'sta_000000000001', siteId: null }], [{ id: 'evs_000000000001' }]);
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().paymentEnabled).toBe(false);
      expect(response.json().isFree).toBe(true);
    });

    it('returns payment config when stripe is configured', async () => {
      setupDbResults([{ id: 'sta_000000000001', siteId: 'site-1' }], [{ id: 'evs_000000000001' }]);
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {} as never,
        publishableKey: 'pk_test_abc',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: 1,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.paymentEnabled).toBe(true);
      expect(body.publishableKey).toBe('pk_test_abc');
      expect(body.currency).toBe('USD');
      expect(body.preAuthAmountCents).toBe(5000);
    });
  });

  describe('POST /v1/portal/guest/start/:stationId/:evseId', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([
        {
          id: 'sta_000000000001',
          stationId: 'CS-001',
          siteId: null,
          isOnline: false,
          onboardingStatus: 'accepted',
          ocppProtocol: 'ocpp2.1',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
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
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 400 when connector is not available', async () => {
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
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
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_NOT_AVAILABLE');
    });

    it('starts free charging session when isTariffFree returns true', async () => {
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
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
      );
      vi.mocked(isTariffFree).mockReturnValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().sessionToken).toBeDefined();
    });

    it('returns 400 when payment is not configured', async () => {
      vi.mocked(isTariffFree).mockReturnValue(false);
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
      );
      vi.mocked(getStripeConfig).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_NOT_CONFIGURED');
    });

    it('returns 400 when payment intent creation fails', async () => {
      vi.mocked(isTariffFree).mockReturnValue(false);
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
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
        stripe: {
          paymentIntents: {
            create: vi.fn().mockRejectedValue(new Error('Card declined')),
          },
        } as never,
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: 1,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_FAILED');
      expect(response.json().error).toBe('Card declined');
    });

    it('starts guest session when payment succeeds', async () => {
      vi.mocked(isTariffFree).mockReturnValue(false);
      setupDbResults(
        [
          {
            id: 'sta_000000000001',
            stationId: 'CS-001',
            siteId: 'site-1',
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [],
      );
      vi.mocked(getStripeConfig).mockResolvedValue({
        stripe: {
          paymentIntents: {
            create: mockStripePaymentIntentsCreate,
          },
        } as never,
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: 1,
        connectedAccountId: null,
        platformFeePercent: 0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().sessionToken).toBeDefined();
      expect(typeof response.json().sessionToken).toBe('string');
    });

    it('returns 400 with invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'not-an-email' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/portal/guest/status/:sessionToken', () => {
    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/status/abc123token',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns guest session status without charging session', async () => {
      setupDbResults([
        {
          status: 'payment_authorized',
          stationOcppId: 'CS-001',
          evseId: 1,
          chargingSessionId: null,
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/status/abc123token',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('payment_authorized');
      expect(body.stationOcppId).toBe('CS-001');
      expect(body.evseId).toBe(1);
    });

    it('returns guest session status with linked charging session data', async () => {
      setupDbResults(
        [
          {
            status: 'charging',
            stationOcppId: 'CS-001',
            evseId: 1,
            chargingSessionId: 'ses_000000000001',
          },
        ],
        [
          {
            energyDeliveredWh: 5000,
            currentCostCents: 250,
            finalCostCents: null,
            startedAt: '2024-01-01T00:00:00Z',
            endedAt: null,
          },
        ],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/status/abc123token',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('charging');
      expect(Number(body.energyDeliveredWh)).toBe(5000);
      expect(Number(body.currentCostCents)).toBe(250);
    });
  });

  describe('POST /v1/portal/guest/stop/:sessionToken', () => {
    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/stop/abc123token',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 400 when session is not charging', async () => {
      setupDbResults([
        {
          status: 'payment_authorized',
          chargingSessionId: null,
          stationOcppId: 'CS-001',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/stop/abc123token',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('NOT_CHARGING');
    });

    it('returns 400 when no linked charging session', async () => {
      setupDbResults([
        {
          status: 'charging',
          chargingSessionId: null,
          stationOcppId: 'CS-001',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/stop/abc123token',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('NO_CHARGING_SESSION');
    });

    it('returns 400 when linked charging session record not found', async () => {
      setupDbResults(
        [
          {
            status: 'charging',
            chargingSessionId: 'ses_000000000001',
            stationOcppId: 'CS-001',
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/stop/abc123token',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('stops a charging guest session', async () => {
      setupDbResults(
        [
          {
            status: 'charging',
            chargingSessionId: 'ses_000000000001',
            stationOcppId: 'CS-001',
          },
        ],
        [{ transactionId: 'tx-456' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/stop/abc123token',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('POST /v1/portal/guest/start/:stationId/:evseId - reservation buffer', () => {
    const stationRow = {
      id: 'sta_000000000001',
      stationId: 'CS-001',
      siteId: null,
      isOnline: true,
      onboardingStatus: 'accepted',
      ocppProtocol: 'ocpp2.1',
    };

    it('returns 409 when EVSE has a reservation starting within the buffer window', async () => {
      setupDbResults([stationRow], [{ id: 'evs_000000000001' }], [{ status: 'available' }]);
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('RESERVATION_BUFFER_ACTIVE');
    });

    it('allows guest session start when reservation starts outside the buffer window', async () => {
      setupDbResults([stationRow], [{ id: 'evs_000000000001' }], [{ status: 'available' }], []);
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
      vi.mocked(isTariffFree).mockReturnValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().sessionToken).toBeDefined();
    });
  });
});
