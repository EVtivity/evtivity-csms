// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_SESSION_ID = 'ses_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_SITE_ID = 'sit_000000000001';
const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_PM_ID = '1';

// -- DB mock helpers --

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
  },
  sitePaymentConfigs: {},
  driverPaymentMethods: {},
  paymentRecords: {},
  paymentReconciliationRuns: {},
  chargingSessions: {},
  settings: {},
  drivers: {},
  chargingStations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@evtivity/lib', () => ({
  encryptString: vi.fn().mockReturnValue('encrypted_value'),
  dispatchDriverNotification: vi.fn(),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => ({})),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn().mockResolvedValue({
    configId: 'config-1',
    secretKey: 'sk_test_123',
    publishableKey: 'pk_test_123',
    currency: 'USD',
    preAuthAmountCents: 5000,
    connectedAccountId: null,
    platformFeePercent: 0,
  }),
  createPreAuthorization: vi
    .fn()
    .mockResolvedValue({ id: 'pi_test_123', status: 'requires_capture' }),
  capturePayment: vi.fn().mockResolvedValue({ id: 'pi_test_123', status: 'succeeded' }),
  cancelPaymentIntent: vi.fn().mockResolvedValue({ id: 'pi_test_123', status: 'canceled' }),
  createRefund: vi.fn().mockResolvedValue({ id: 're_test_123' }),
  createSetupIntent: vi
    .fn()
    .mockResolvedValue({ id: 'seti_test', client_secret: 'seti_secret_123' }),
  createCustomer: vi.fn().mockResolvedValue({ id: 'cus_test_123' }),
  detachPaymentMethod: vi.fn().mockResolvedValue({ id: 'pm_test' }),
  clearConfigCache: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { paymentRoutes } from '../routes/payments.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(paymentRoutes);
  await app.ready();
  return app;
}

describe('Payment routes - handler logic', () => {
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
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-1234567890ab';
  });

  // --- GET /v1/sites/:id/payment-config ---

  describe('GET /v1/sites/:id/payment-config', () => {
    it('returns payment config when found', async () => {
      const config = {
        id: 'pc-1',
        siteId: VALID_SITE_ID,
        stripeConnectedAccountId: 'acct_123',
        currency: 'USD',
        preAuthAmountCents: 5000,
        platformFeePercent: null,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults([config]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().currency).toBe('USD');
    });

    it('returns 404 when no payment config', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_CONFIG_NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- PUT /v1/sites/:id/payment-config ---

  describe('PUT /v1/sites/:id/payment-config', () => {
    it('updates existing payment config', async () => {
      const updated = {
        id: 'pc-1',
        siteId: VALID_SITE_ID,
        stripeConnectedAccountId: null,
        currency: 'EUR',
        preAuthAmountCents: 5000,
        platformFeePercent: null,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults(
        [{ id: 'pc-1' }], // existing found
        [updated], // update returning
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
        payload: { currency: 'EUR', isEnabled: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().currency).toBe('EUR');
    });

    it('creates new payment config when none exists', async () => {
      const created = {
        id: 'pc-new',
        siteId: VALID_SITE_ID,
        stripeConnectedAccountId: null,
        currency: 'USD',
        preAuthAmountCents: 5000,
        platformFeePercent: null,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults(
        [], // no existing
        [created], // insert returning
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
        payload: { currency: 'USD' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe('pc-new');
    });
  });

  // --- DELETE /v1/sites/:id/payment-config ---

  describe('DELETE /v1/sites/:id/payment-config', () => {
    it('deletes payment config and returns success', async () => {
      setupDbResults([{ id: 'pc-1', siteId: VALID_SITE_ID }]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('returns 404 when no payment config to delete', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_CONFIG_NOT_FOUND');
    });
  });

  // --- GET /v1/settings/stripe ---

  describe('GET /v1/settings/stripe', () => {
    it('returns stripe settings from database', async () => {
      const rows = [
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
        { key: 'stripe.currency', value: 'USD' },
        { key: 'stripe.preAuthAmountCents', value: 5000 },
        { key: 'stripe.platformFeePercent', value: 2.5 },
        { key: 'other.setting', value: 'ignored' },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('publishableKey');
      expect(body).toHaveProperty('currency');
      expect(body).toHaveProperty('preAuthAmountCents');
      expect(body).toHaveProperty('platformFeePercent');
    });
  });

  // --- PUT /v1/settings/stripe ---

  describe('PUT /v1/settings/stripe', () => {
    it('saves stripe settings and returns success', async () => {
      // Each setting pair triggers an upsert
      setupDbResults([], [], []);

      const response = await app.inject({
        method: 'PUT',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
        payload: {
          publishableKey: 'pk_test_new',
          currency: 'EUR',
          preAuthAmountCents: 3000,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  // --- GET /v1/drivers/:id/payment-methods ---

  describe('GET /v1/drivers/:id/payment-methods', () => {
    it('returns payment methods for driver', async () => {
      const methods = [
        {
          id: VALID_PM_ID,
          driverId: VALID_DRIVER_ID,
          stripeCustomerId: 'cus_test',
          stripePaymentMethodId: 'pm_test',
          cardBrand: 'visa',
          cardLast4: '4242',
          isDefault: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      setupDbResults(methods);

      const response = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].cardLast4).toBe('4242');
    });
  });

  // --- POST /v1/drivers/:id/payment-methods ---

  describe('POST /v1/drivers/:id/payment-methods', () => {
    it('saves a payment method and returns 201', async () => {
      const method = {
        id: VALID_PM_ID,
        driverId: VALID_DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        cardBrand: 'visa',
        cardLast4: '4242',
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults(
        [], // no existing methods (will be default)
        [method], // insert returning
      );

      const response = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          stripePaymentMethodId: 'pm_test',
          stripeCustomerId: 'cus_test',
          cardBrand: 'visa',
          cardLast4: '4242',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().isDefault).toBe(true);
    });
  });

  // --- DELETE /v1/drivers/:id/payment-methods/:pmId ---

  describe('DELETE /v1/drivers/:id/payment-methods/:pmId', () => {
    it('deletes payment method and returns success', async () => {
      const method = {
        id: VALID_PM_ID,
        driverId: VALID_DRIVER_ID,
        stripePaymentMethodId: 'pm_test_123',
      };
      setupDbResults(
        [method], // found
        [], // delete
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });
  });

  // --- PATCH /v1/drivers/:id/payment-methods/:pmId/default ---

  describe('PATCH /v1/drivers/:id/payment-methods/:pmId/default', () => {
    it('sets payment method as default', async () => {
      const updated = {
        id: VALID_PM_ID,
        driverId: VALID_DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        cardBrand: null,
        cardLast4: null,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults(
        [{ id: VALID_PM_ID }], // method found
        [], // unset all defaults
        [updated], // set this as default
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}/default`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().isDefault).toBe(true);
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}/default`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });
  });

  // --- GET /v1/sessions/:id/payment ---

  describe('GET /v1/sessions/:id/payment', () => {
    it('returns payment record for session', async () => {
      const record = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        driverId: null,
        sitePaymentConfigId: null,
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        paymentSource: null,
        currency: 'USD',
        preAuthAmountCents: 0,
        capturedAmountCents: null,
        refundedAmountCents: 0,
        status: 'captured',
        failureReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([record]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/payment`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('captured');
    });

    it('returns 404 when no payment record', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${VALID_SESSION_ID}/payment`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  // --- GET /v1/payments ---

  describe('GET /v1/payments', () => {
    it('returns paginated payment records', async () => {
      const record = {
        id: 'pay-1',
        sessionId: null,
        driverId: null,
        sitePaymentConfigId: null,
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        paymentSource: null,
        currency: 'USD',
        preAuthAmountCents: 0,
        capturedAmountCents: 1500,
        refundedAmountCents: 0,
        status: 'captured',
        failureReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([record], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/payments',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
    });

    it('returns empty list when no payments', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/payments',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
      expect(response.json().total).toBe(0);
    });
  });

  // --- POST /v1/sessions/:id/pre-authorize ---

  describe('POST /v1/sessions/:id/pre-authorize', () => {
    it('creates pre-authorization and returns payment record', async () => {
      const session = {
        id: VALID_SESSION_ID,
        stationId: 'sta_000000000001',
        driverId: VALID_DRIVER_ID,
      };
      const pm = {
        id: VALID_PM_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
      };
      const station = { siteId: 'site-1' };
      const record = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        driverId: null,
        sitePaymentConfigId: null,
        stripePaymentIntentId: 'pi_test_123',
        stripeCustomerId: null,
        paymentSource: null,
        currency: 'USD',
        preAuthAmountCents: 0,
        capturedAmountCents: null,
        refundedAmountCents: 0,
        status: 'pre_authorized',
        failureReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      setupDbResults(
        [session], // session found
        [pm], // payment method found
        [station], // station lookup
        [record], // insert payment record
      );

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/pre-authorize`,
        headers: { authorization: 'Bearer ' + token },
        payload: { paymentMethodId: VALID_PM_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('pre_authorized');
    });

    it('returns 404 when session not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/pre-authorize`,
        headers: { authorization: 'Bearer ' + token },
        payload: { paymentMethodId: VALID_PM_ID },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults(
        [{ id: VALID_SESSION_ID, stationId: 'sta_000000000001', driverId: VALID_DRIVER_ID }],
        [], // pm not found
      );

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/pre-authorize`,
        headers: { authorization: 'Bearer ' + token },
        payload: { paymentMethodId: VALID_PM_ID },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });
  });

  // --- POST /v1/sessions/:id/capture ---

  describe('POST /v1/sessions/:id/capture', () => {
    it('captures payment and returns updated record', async () => {
      const preAuthRecord = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        status: 'pre_authorized',
        stripePaymentIntentId: 'pi_test_123',
      };
      const updated = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        driverId: null,
        sitePaymentConfigId: null,
        stripePaymentIntentId: 'pi_test_123',
        stripeCustomerId: null,
        paymentSource: null,
        currency: 'USD',
        preAuthAmountCents: 0,
        capturedAmountCents: 1200,
        refundedAmountCents: 0,
        status: 'captured',
        failureReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      // 1: find pre-auth, 2: get session cost (no amount specified), 3: station lookup, 4: update record
      setupDbResults(
        [preAuthRecord],
        [{ finalCostCents: 1200 }],
        [{ siteId: 'site-1' }],
        [updated],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/capture`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('captured');
    });

    it('returns 404 when no pre-authorized payment', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/capture`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('NO_PRE_AUTH');
    });

    it('returns 400 when payment intent missing', async () => {
      setupDbResults([
        {
          id: 'pay-1',
          sessionId: VALID_SESSION_ID,
          status: 'pre_authorized',
          stripePaymentIntentId: null,
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/capture`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MISSING_PAYMENT_INTENT');
    });
  });

  // --- POST /v1/sessions/:id/refund ---

  describe('POST /v1/sessions/:id/refund', () => {
    it('creates refund and returns updated record', async () => {
      const record = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        status: 'captured',
        stripePaymentIntentId: 'pi_test_123',
        capturedAmountCents: 1500,
        refundedAmountCents: 0,
        driverId: VALID_DRIVER_ID,
        currency: 'USD',
      };
      const updated = {
        id: 'pay-1',
        sessionId: VALID_SESSION_ID,
        driverId: null,
        sitePaymentConfigId: null,
        stripePaymentIntentId: 'pi_test_123',
        stripeCustomerId: null,
        paymentSource: null,
        currency: 'USD',
        preAuthAmountCents: 0,
        capturedAmountCents: 1500,
        refundedAmountCents: 1500,
        status: 'refunded',
        failureReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      setupDbResults(
        [record], // find captured record
        [{ siteId: 'site-1' }], // station lookup
        [updated], // update record
      );

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/refund`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('refunded');
    });

    it('returns 400 when no captured payment', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/refund`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('NO_CAPTURED_PAYMENT');
    });

    it('returns 400 when payment intent missing on refund', async () => {
      setupDbResults([
        {
          id: 'pay-1',
          sessionId: VALID_SESSION_ID,
          status: 'captured',
          stripePaymentIntentId: null,
          capturedAmountCents: 1000,
          refundedAmountCents: 0,
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/refund`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MISSING_PAYMENT_INTENT');
    });
  });

  // --- POST /v1/drivers/:id/payment-methods/setup-intent ---

  describe('POST /v1/drivers/:id/payment-methods/setup-intent', () => {
    it('creates setup intent for existing customer', async () => {
      const driver = {
        id: VALID_DRIVER_ID,
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      };
      setupDbResults(
        [driver], // driver found
        [{ stripeCustomerId: 'cus_existing' }], // existing method with customer id
      );

      const response = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/setup-intent`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('clientSecret');
      expect(response.json()).toHaveProperty('customerId');
      expect(response.json()).toHaveProperty('publishableKey');
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/setup-intent`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });
  });

  // --- POST /v1/settings/stripe/test ---

  describe('POST /v1/settings/stripe/test', () => {
    it('returns success when Stripe connection works', async () => {
      const { getStripeConfig } = await import('../services/stripe.service.js');
      const mockConfig = {
        stripe: { balance: { retrieve: vi.fn().mockResolvedValue({ available: [] }) } },
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      vi.mocked(getStripeConfig).mockResolvedValueOnce(mockConfig as never);

      const response = await app.inject({
        method: 'POST',
        url: '/settings/stripe/test',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('returns 400 when Stripe is not configured', async () => {
      const { getStripeConfig } = await import('../services/stripe.service.js');
      vi.mocked(getStripeConfig).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'POST',
        url: '/settings/stripe/test',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STRIPE_NOT_CONFIGURED');
    });

    it('returns 400 when Stripe connection fails', async () => {
      const { getStripeConfig } = await import('../services/stripe.service.js');
      const mockConfig = {
        stripe: {
          balance: { retrieve: vi.fn().mockRejectedValue(new Error('Invalid API key')) },
        },
        publishableKey: 'pk_test',
        currency: 'USD',
        preAuthAmountCents: 5000,
        configId: null,
        connectedAccountId: null,
        platformFeePercent: 0,
      };
      vi.mocked(getStripeConfig).mockResolvedValueOnce(mockConfig as never);

      const response = await app.inject({
        method: 'POST',
        url: '/settings/stripe/test',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STRIPE_CONNECTION_FAILED');
    });
  });

  // --- GET /v1/sites/payment-configs ---

  describe('GET /v1/sites/payment-configs', () => {
    it('returns all site payment configurations', async () => {
      const configs = [
        {
          id: 'pc-1',
          siteId: VALID_SITE_ID,
          stripeConnectedAccountId: 'acct_123',
          currency: 'USD',
          preAuthAmountCents: 5000,
          platformFeePercent: null,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'pc-2',
          siteId: VALID_DRIVER_ID,
          stripeConnectedAccountId: null,
          currency: 'EUR',
          preAuthAmountCents: 3000,
          platformFeePercent: '5',
          isEnabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      setupDbResults(configs);

      const response = await app.inject({
        method: 'GET',
        url: '/sites/payment-configs',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0].currency).toBe('USD');
      expect(body[1].currency).toBe('EUR');
    });

    it('returns empty array when no configs exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/sites/payment-configs',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites/payment-configs',
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
