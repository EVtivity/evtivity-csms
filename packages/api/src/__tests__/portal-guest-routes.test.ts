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

vi.mock('@evtivity/database', async () => ({
  isStationLevelUnavailable: (
    await vi.importActual<typeof import('../../../database/src/lib/station-status.js')>(
      '../../../database/src/lib/station-status.js',
    )
  ).isStationLevelUnavailable,
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getCompanyCountry: vi.fn(() => Promise.resolve('NL')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('net')),
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
  paymentRecords: {},
  reservations: {},
  sites: { id: 'id', freeVendEnabled: 'freeVendEnabled' },
  client: {},
  resolveStationTariff: vi.fn().mockResolvedValue(null),
  isStationChargingFree: vi.fn().mockResolvedValue(true),
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

const {
  mockActivePaymentProvider,
  mockAuthorizeGuestHold,
  mockClaimGuestStart,
  mockContinueGuestHold,
  mockHoldTerms,
  mockRollbackGuestStart,
  mockScheduleGuestStartTimeout,
} = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
  mockAuthorizeGuestHold: vi.fn(),
  mockClaimGuestStart: vi.fn(),
  mockContinueGuestHold: vi.fn(),
  mockHoldTerms: vi.fn(),
  mockRollbackGuestStart: vi.fn(),
  mockScheduleGuestStartTimeout: vi.fn(),
}));

vi.mock('../lib/remote-start-timeout.js', () => ({
  scheduleGuestStartTimeout: mockScheduleGuestStartTimeout,
}));

vi.mock('@evtivity/payments', () => ({
  authorizeGuestHold: mockAuthorizeGuestHold,
  claimGuestStart: mockClaimGuestStart,
  continueGuestHold: mockContinueGuestHold,
  holdTerms: mockHoldTerms,
  guestHoldTerms: mockHoldTerms,
  rollbackGuestStart: mockRollbackGuestStart,
}));

vi.mock('../lib/payments.js', () => ({
  activePaymentProvider: mockActivePaymentProvider,
  paymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
}));

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/services/ocpp-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/ocpp-command')>()),
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    commandId: 'mock-command-id',
    response: { status: 'Accepted' },
  }),
}));

vi.mock('../lib/station-status-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/station-status-check.js')>()),
  triggerAndWaitForStatus: vi.fn().mockResolvedValue({ status: 'available' }),
}));

vi.mock('../lib/session-limit.js', () => ({ sessionLimitReached: vi.fn(async () => null) }));

vi.mock('../lib/reservation-buffer.js', () => ({
  isEvseInReservationBuffer: vi.fn().mockResolvedValue(false),
}));

vi.mock('@evtivity/services/maintenance.service', () => ({
  getActiveMaintenanceForStation: vi.fn().mockResolvedValue(null),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalGuestRoutes } from '../routes/portal/guest.js';
import { isStationChargingFree, resolveStationTariff } from '@evtivity/database';
import { isEvseInReservationBuffer } from '../lib/reservation-buffer.js';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { triggerAndWaitForStatus } from '../lib/station-status-check.js';
import { db } from '@evtivity/database';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import { config as apiConfig } from '../lib/config.js';

const CTX = { registry: 'registry', logger: expect.anything() };

function stripeProvider(publishableKey: string) {
  return {
    id: 'stripe',
    clientConfig: vi.fn(() => ({ provider: 'stripe', publishableKey })),
  };
}

const PAID_STATION = {
  id: 'sta_000000000001',
  stationId: 'CS-001',
  siteId: 'site-1',
  isOnline: true,
  onboardingStatus: 'accepted',
  ocppProtocol: 'ocpp2.1',
};

/** Station, EVSE, connector, the empty gate checks and the free-vend lookup. */
function setupStartRows(...rest: unknown[][]): void {
  setupDbResults(
    [PAID_STATION],
    [{ id: 'evs_000000000001' }],
    [{ status: 'available' }],
    [], // active reservation gate (no reservation)
    [], // evse active session check (none)
    [{ freeVendEnabled: false }], // siteFreeVend lookup before tariff resolve
    ...rest,
  );
}

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
    mockActivePaymentProvider.mockResolvedValue(null);
    mockHoldTerms.mockResolvedValue({
      preAuthAmountCents: 5000,
      sitePaymentConfigId: null,
      payoutAccountId: null,
    });
    mockRollbackGuestStart.mockResolvedValue(undefined);
    vi.mocked(isStationChargingFree).mockResolvedValue(true);
    vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
    vi.mocked(getActiveMaintenanceForStation).mockResolvedValue(null);
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
      setupDbResults([{ id: 'sta_000000000001', siteId: null, freeVendEnabled: false }], []);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns paymentEnabled false when no payment provider is active', async () => {
      setupDbResults(
        [{ id: 'sta_000000000001', siteId: null, freeVendEnabled: false }],
        [{ id: 'evs_000000000001' }],
      );

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().paymentEnabled).toBe(false);
      expect(response.json().paymentProvider).toBeNull();
      expect(response.json().isFree).toBe(true);
      expect(response.json()).not.toHaveProperty('preAuthAmountCents');
      expect(mockHoldTerms).not.toHaveBeenCalled();
    });

    it('returns the Stripe client config and the site hold amount when Stripe is active', async () => {
      setupDbResults(
        [{ id: 'sta_000000000001', siteId: 'site-1', freeVendEnabled: false }],
        [{ id: 'evs_000000000001' }],
      );
      mockActivePaymentProvider.mockResolvedValue(stripeProvider('pk_test_abc'));
      mockHoldTerms.mockResolvedValue({
        preAuthAmountCents: 7500,
        sitePaymentConfigId: 4,
        payoutAccountId: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.paymentEnabled).toBe(true);
      expect(body.publishableKey).toBe('pk_test_abc');
      expect(body.paymentProvider).toEqual({ provider: 'stripe', publishableKey: 'pk_test_abc' });
      expect(body.currency).toBe('EUR');
      expect(body.preAuthAmountCents).toBe(7500);
      expect(mockHoldTerms).toHaveBeenCalledWith(CTX, 'site-1', 'CS-001');
    });

    it('returns the provider client config and no publishable key for a provider other than Stripe', async () => {
      setupDbResults(
        [{ id: 'sta_000000000001', siteId: null, freeVendEnabled: false }],
        [{ id: 'evs_000000000001' }],
      );
      mockActivePaymentProvider.mockResolvedValue({
        id: 'simulated',
        clientConfig: vi.fn(() => ({ provider: 'simulated', resultMode: 'sync', testCards: [] })),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.paymentEnabled).toBe(true);
      expect(body).not.toHaveProperty('publishableKey');
      expect(body.paymentProvider).toEqual({
        provider: 'simulated',
        resultMode: 'sync',
        testCards: [],
      });
      expect(body.preAuthAmountCents).toBe(5000);
      // Adyen Web needs the shopper country to start.
      expect(body.countryCode).toBe('NL');
      expect(mockHoldTerms).toHaveBeenCalledWith(CTX, null, 'CS-001');
    });

    it('returns tariff pricing in the company currency', async () => {
      setupDbResults(
        [{ id: 'sta_000000000001', siteId: null, freeVendEnabled: false }],
        [{ id: 'evs_000000000001' }],
      );
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      vi.mocked(resolveStationTariff).mockResolvedValueOnce({
        id: 'tar_001',
        name: 'Standard',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        restrictions: null,
        priority: 0,
        isDefault: true,
        pricingGroup: { id: 'pgr_1', name: 'Group', source: 'station' },
        timezone: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/charger-config/CS-001/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pricing).toEqual(
        expect.objectContaining({ currency: 'EUR', pricePerKwh: '0.25' }),
      );
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
        [], // active reservation gate (no reservation)
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_NOT_AVAILABLE');
    });

    it('starts free charging session when charging is free', async () => {
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
        [], // active reservation gate (no reservation)
        [], // evse active session check (none)
        [{ freeVendEnabled: false }], // siteFreeVend lookup before tariff resolve
      );
      vi.mocked(isStationChargingFree).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().sessionToken).toBeDefined();
      // A guest has no driver and no reservation; the site's free vend comes first.
      expect(vi.mocked(isStationChargingFree)).toHaveBeenCalledWith(
        { stationUuid: 'sta_000000000001', driverUuid: null, reserved: false, freeVend: false },
        expect.anything(),
      );
    });

    it('returns 400 when payment is not configured', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockAuthorizeGuestHold.mockResolvedValueOnce({ outcome: 'not_configured' });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Payment not configured for this station',
        code: 'PAYMENT_NOT_CONFIGURED',
      });
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    it('returns 400 PAYMENT_FAILED with the decline reason when the hold is declined', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockAuthorizeGuestHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'Card declined',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Card declined', code: 'PAYMENT_FAILED' });
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    it('returns 400 PAYMENT_METHOD_REQUIRED for paid charging without a payment method', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { guestEmail: 'guest@example.com' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_METHOD_REQUIRED');
      expect(mockAuthorizeGuestHold).not.toHaveBeenCalled();
    });

    it('returns 400 EMAIL_REQUIRED for paid charging without an email', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('EMAIL_REQUIRED');
      expect(mockAuthorizeGuestHold).not.toHaveBeenCalled();
    });

    it('places the guest hold with the session limits and starts it as DirectPayment', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockAuthorizeGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'pi_guest_123',
        preAuthAmountCents: 5000,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethodId: 'pm_test',
          guestEmail: 'guest@example.com',
          maxEnergyWh: 20000,
          maxCostCents: 9000,
        },
      });

      expect(response.statusCode).toBe(200);
      const sessionToken = response.json().sessionToken as string;
      expect(sessionToken).toHaveLength(20);
      // The service caps maxCostCents at the authorized amount and stores the row.
      expect(mockAuthorizeGuestHold).toHaveBeenCalledWith(
        {
          sessionToken,
          stationOcppId: 'CS-001',
          evseId: 1,
          siteId: 'site-1',
          methodPayload: 'pm_test',
          guestEmail: 'guest@example.com',
          maxCostCents: 9000,
          maxEnergyWh: 20000,
          maxTimeSeconds: null,
          expiresAt: expect.any(Date),
        },
        CTX,
      );
      // The route stores no guest row itself on the paid path.
      expect(db.insert).not.toHaveBeenCalled();
      expect(vi.mocked(sendOcppCommandAndWait)).toHaveBeenCalledWith(
        'CS-001',
        'RequestStartTransaction',
        expect.objectContaining({
          idToken: { idToken: sessionToken, type: 'DirectPayment' },
        }),
      );
      expect(mockRollbackGuestStart).not.toHaveBeenCalled();
    });

    it('places the hold with a provider-tagged one-time card', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockActivePaymentProvider.mockResolvedValueOnce({ id: 'simulated' });
      mockAuthorizeGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'pi_sim_guest',
        preAuthAmountCents: 5000,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethod: { provider: 'simulated', payload: { testCard: '4242424242424242' } },
          guestEmail: 'guest@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockAuthorizeGuestHold).toHaveBeenCalledWith(
        expect.objectContaining({ methodPayload: { testCard: '4242424242424242' } }),
        CTX,
      );
    });

    it('refuses a one-time card collected for another provider before any hold', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockActivePaymentProvider.mockResolvedValueOnce({ id: 'stripe' });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethod: { provider: 'simulated', payload: { testCard: '4242424242424242' } },
          guestEmail: 'guest@example.com',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
      expect(mockAuthorizeGuestHold).not.toHaveBeenCalled();
    });

    it('refuses paymentMethodId and paymentMethod together', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethodId: 'pm_test',
          paymentMethod: { provider: 'stripe', payload: 'pm_test' },
          guestEmail: 'guest@example.com',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(mockAuthorizeGuestHold).not.toHaveBeenCalled();
    });

    it('stores the QR code limits of a free session and starts it as Central', async () => {
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
        [], // active reservation gate (no reservation)
        [], // evse active session check (none)
        [{ freeVendEnabled: false }], // siteFreeVend lookup before tariff resolve
      );
      vi.mocked(isStationChargingFree).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { maxEnergyWh: 20000, maxTimeSeconds: 3600 },
      });

      expect(response.statusCode).toBe(200);
      const insertChain = vi.mocked(db.insert).mock.results[0]?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          maxCostCents: null,
          maxEnergyWh: 20000,
          maxTimeSeconds: 3600,
          startRequestedAt: expect.any(Date),
        }),
      );
      expect(vi.mocked(sendOcppCommandAndWait)).toHaveBeenCalledWith(
        'CS-001',
        'RequestStartTransaction',
        expect.objectContaining({
          idToken: { idToken: response.json().sessionToken as string, type: 'Central' },
        }),
      );
    });

    it('returns 400 with invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'not-an-email' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 504 STATION_TIMEOUT and rolls back the free session when station does not ack', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(true);
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'mock-cmd',
        error: 'No response within 35s',
      });
      setupStartRows(
        [], // INSERT guest_sessions
      );

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe('STATION_TIMEOUT');
      expect(mockRollbackGuestStart).toHaveBeenCalledWith(
        { sessionToken: expect.any(String), paymentId: null },
        CTX,
      );
    });

    it('returns 502 STATION_REJECTED and rolls back the guest hold (paid path)', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'mock-cmd',
        response: { status: 'Rejected' },
      });
      setupStartRows();
      mockAuthorizeGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'pi_guest_123',
        preAuthAmountCents: 5000,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Station rejected start: Rejected',
        code: 'STATION_REJECTED',
      });
      const [hold] = mockAuthorizeGuestHold.mock.calls[0] as [{ sessionToken: string }];
      expect(mockRollbackGuestStart).toHaveBeenCalledWith(
        { sessionToken: hold.sessionToken, paymentId: 'pi_guest_123' },
        CTX,
      );
    });
  });

  describe('POST /v1/portal/guest/start/:stationId/:evseId - 3D Secure', () => {
    const ACTION = { provider: 'adyen', data: { type: 'redirect', url: 'https://issuer.test' } };
    const PORTAL_ORIGIN = new URL(apiConfig.PORTAL_URL).origin;

    it('passes the browser with a server-built return URL and answers the action', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockActivePaymentProvider.mockResolvedValueOnce({ id: 'adyen' });
      mockAuthorizeGuestHold.mockResolvedValueOnce({ outcome: 'action_required', action: ACTION });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethod: {
            provider: 'adyen',
            payload: { paymentMethod: { type: 'scheme' } },
            browser: { origin: PORTAL_ORIGIN, info: { userAgent: 'test' } },
          },
          guestEmail: 'guest@example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        status: 'action_required',
        sessionToken: expect.any(String),
        action: ACTION,
      });
      const returnUrl = new URL('/payments/return', apiConfig.PORTAL_URL);
      returnUrl.searchParams.set('flow', 'guest');
      returnUrl.searchParams.set('token', body.sessionToken as string);
      expect(mockAuthorizeGuestHold).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionToken: body.sessionToken,
          browser: {
            origin: PORTAL_ORIGIN,
            returnUrl: returnUrl.toString(),
            info: { userAgent: 'test' },
          },
        }),
        CTX,
      );
      // The station is started by the details route, not here.
      expect(vi.mocked(sendOcppCommandAndWait)).not.toHaveBeenCalled();
    });

    it('refuses a browser origin other than the portal before any hold', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {
          paymentMethod: {
            provider: 'adyen',
            payload: {},
            browser: { origin: 'https://attacker.example' },
          },
          guestEmail: 'guest@example.com',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(mockAuthorizeGuestHold).not.toHaveBeenCalled();
    });

    it('answers status started for a hold authorized without an action', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupStartRows();
      mockAuthorizeGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'pi_guest_123',
        preAuthAmountCents: 5000,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'started', sessionToken: expect.any(String) });
      // The accepted start is closed by the worker if the guest never plugs in.
      const token = response.json<{ sessionToken: string }>().sessionToken;
      expect(mockScheduleGuestStartTimeout).toHaveBeenCalledWith(token, expect.anything());
    });
  });

  describe('POST /v1/portal/guest/payment-details/:sessionToken', () => {
    const TOKEN = 'a1b2c3d4e5f6a7b8c9d0';
    const DETAILS = { details: { redirectResult: 'X6Xtf' } };

    function post(payload: unknown = { details: DETAILS }) {
      return app.inject({
        method: 'POST',
        url: `/portal/guest/payment-details/${TOKEN}`,
        payload: payload as Record<string, unknown>,
      });
    }

    it('continues the hold, claims the start and starts it as DirectPayment', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'PSP1',
        preAuthAmountCents: 5000,
      });
      mockClaimGuestStart.mockResolvedValueOnce({
        claim: 'claimed',
        stationOcppId: 'CS-001',
        evseId: 2,
        paymentId: 'PSP1',
      });

      const response = await post();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'started', sessionToken: TOKEN });
      expect(mockContinueGuestHold).toHaveBeenCalledWith(
        { sessionToken: TOKEN, details: DETAILS },
        CTX,
      );
      expect(mockClaimGuestStart).toHaveBeenCalledWith(TOKEN);
      expect(vi.mocked(sendOcppCommandAndWait)).toHaveBeenCalledWith(
        'CS-001',
        'RequestStartTransaction',
        expect.objectContaining({
          evseId: 2,
          idToken: { idToken: TOKEN, type: 'DirectPayment' },
        }),
      );
      expect(mockScheduleGuestStartTimeout).toHaveBeenCalledWith(TOKEN, expect.anything());
    });

    it('answers started without a second start when the start was already requested', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({ outcome: 'not_pending' });
      mockClaimGuestStart.mockResolvedValueOnce({ claim: 'already_requested' });

      const response = await post();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'started', sessionToken: TOKEN });
      expect(vi.mocked(sendOcppCommandAndWait)).not.toHaveBeenCalled();
    });

    it('answers 404 SESSION_NOT_FOUND when no session waits for its payment', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({ outcome: 'not_pending' });
      mockClaimGuestStart.mockResolvedValueOnce({ claim: 'not_startable' });

      const response = await post();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
      expect(vi.mocked(sendOcppCommandAndWait)).not.toHaveBeenCalled();
    });

    it('answers a further action', async () => {
      const action = { provider: 'adyen', data: { type: 'threeDS2' } };
      mockContinueGuestHold.mockResolvedValueOnce({ outcome: 'action_required', action });

      const response = await post();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'action_required', sessionToken: TOKEN, action });
      expect(mockClaimGuestStart).not.toHaveBeenCalled();
    });

    it('answers 400 PAYMENT_FAILED with the reason when the card is refused', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({ outcome: 'declined', reason: 'Refused' });

      const response = await post();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Refused', code: 'PAYMENT_FAILED' });
      expect(mockClaimGuestStart).not.toHaveBeenCalled();
    });

    it('answers 400 PAYMENT_NOT_CONFIGURED when the pinned provider is gone', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({ outcome: 'not_configured' });

      const response = await post();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_NOT_CONFIGURED');
    });

    it('rolls back the session and cancels the hold when the station rejects the start', async () => {
      mockContinueGuestHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentId: 'PSP1',
        preAuthAmountCents: 5000,
      });
      mockClaimGuestStart.mockResolvedValueOnce({
        claim: 'claimed',
        stationOcppId: 'CS-001',
        evseId: 1,
        paymentId: 'PSP1',
      });
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'mock-cmd',
        response: { status: 'Rejected' },
      });

      const response = await post();

      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe('STATION_REJECTED');
      expect(mockRollbackGuestStart).toHaveBeenCalledWith(
        { sessionToken: TOKEN, paymentId: 'PSP1' },
        CTX,
      );
      expect(mockScheduleGuestStartTimeout).not.toHaveBeenCalled();
    });

    it('refuses a malformed session token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/payment-details/not-a-token',
        payload: { details: DETAILS },
      });

      expect(response.statusCode).toBe(400);
      expect(mockContinueGuestHold).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/portal/guest/status/:sessionToken', () => {
    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/guest/status/abc123def456abc12345',
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
        url: '/portal/guest/status/abc123def456abc12345',
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
        // parent chargingStations.isSimulator lookup
        [{ isSimulator: false }],
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
        url: '/portal/guest/status/abc123def456abc12345',
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
        url: '/portal/guest/stop/abc123def456abc12345',
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
        url: '/portal/guest/stop/abc123def456abc12345',
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
        url: '/portal/guest/stop/abc123def456abc12345',
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
        url: '/portal/guest/stop/abc123def456abc12345',
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
        url: '/portal/guest/stop/abc123def456abc12345',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      const call = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const message = JSON.parse(call?.[1] as string) as Record<string, unknown>;
      expect(Object.keys(message)).toEqual(['commandId', 'stationId', 'action', 'payload']);
      expect(message).toMatchObject({
        stationId: 'CS-001',
        action: 'RequestStopTransaction',
        payload: { transactionId: 'tx-456' },
      });
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
      setupDbResults(
        [stationRow],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [], // active reservation gate (no reservation)
        [], // evse active session check (none)
        [{ freeVendEnabled: false }], // siteFreeVend lookup before tariff resolve
      );
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
      vi.mocked(isStationChargingFree).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().sessionToken).toBeDefined();
    });
  });

  describe('POST /v1/portal/guest/check-status/:stationId/:evseId', () => {
    it('returns 400 STATION_OFFLINE for an offline station', async () => {
      setupDbResults([{ id: 'sta_off', stationId: 'CS-OFF', isOnline: false, ocppProtocol: null }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-OFF/1',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Station is offline', code: 'STATION_OFFLINE' });
    });

    it('returns 502 STATUS_CHECK_REJECTED when the station rejects the check', async () => {
      setupDbResults([
        { id: 'sta_rej', stationId: 'CS-REJ', isOnline: true, ocppProtocol: 'ocpp2.1' },
      ]);
      vi.mocked(db.execute).mockResolvedValueOnce([{ connector_id: 1 }] as never);
      vi.mocked(triggerAndWaitForStatus).mockResolvedValueOnce({
        status: null,
        errorCode: 'STATUS_CHECK_REJECTED',
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-REJ/1',
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Station rejected the status check',
        code: 'STATUS_CHECK_REJECTED',
      });
    });

    it('returns the refreshed status on success', async () => {
      setupDbResults([
        { id: 'sta_ok', stationId: 'CS-GOK', isOnline: true, ocppProtocol: 'ocpp1.6' },
      ]);
      vi.mocked(db.execute).mockResolvedValueOnce([{ connector_id: 1 }] as never);
      vi.mocked(triggerAndWaitForStatus).mockResolvedValueOnce({ status: 'preparing' });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-GOK/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ connectorStatus: 'preparing' });
    });
  });
});
