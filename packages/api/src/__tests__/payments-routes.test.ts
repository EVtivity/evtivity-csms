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
    'onConflictDoNothing',
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

vi.mock('@evtivity/database', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbMock)),
  };
  return {
    db: dbMock,
    client: {},
    sitePaymentConfigs: {},
    driverPaymentMethods: {},
    paymentRecords: {},
    paymentReconciliationRuns: {},
    chargingSessions: {},
    settings: {},
    drivers: {},
    chargingStations: {},
    sites: {},
    settingAuditLog: {},
    siteAuditLog: {},
    writeAudit: vi.fn(async () => undefined),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  like: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@evtivity/lib', () => ({
  encryptString: vi.fn().mockReturnValue('encrypted_value'),
  decryptString: vi.fn((value: string) => `decrypted:${value}`),
  dispatchDriverNotification: vi.fn(() => Promise.resolve()),
  notificationMoney: vi.fn((cents: number, currency: string) => `${String(cents)} ${currency}`),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => ({})),
}));

const {
  mockAuthorizeSessionHold,
  mockCaptureSessionHold,
  mockRefundPaymentRecord,
  mockRetryShortfallForRecord,
  mockRunPaymentReconciliation,
  mockSaveDriverMethod,
  mockRemoveDriverMethod,
  mockSetDefaultDriverMethod,
  mockStartDriverMethodSetup,
  mockGetPaymentProvider,
  mockClearPaymentCaches,
  mockPaymentContext,
  MockPaymentProviderNotConfiguredError,
} = vi.hoisted(() => {
  class MockPaymentProviderNotConfiguredError extends Error {
    readonly providerId: string;
    constructor(providerId: string) {
      super(`Payment provider ${providerId} is not configured`);
      this.providerId = providerId;
    }
  }
  return {
    mockAuthorizeSessionHold: vi.fn(),
    mockCaptureSessionHold: vi.fn(),
    mockRefundPaymentRecord: vi.fn(),
    mockRetryShortfallForRecord: vi.fn(),
    mockRunPaymentReconciliation: vi.fn(),
    mockSaveDriverMethod: vi.fn(),
    mockRemoveDriverMethod: vi.fn(),
    mockSetDefaultDriverMethod: vi.fn(),
    mockStartDriverMethodSetup: vi.fn(),
    mockGetPaymentProvider: vi.fn(),
    mockClearPaymentCaches: vi.fn(),
    mockPaymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
    MockPaymentProviderNotConfiguredError,
  };
});

vi.mock('@evtivity/payments', () => ({
  authorizeSessionHold: mockAuthorizeSessionHold,
  captureSessionHold: mockCaptureSessionHold,
  refundPaymentRecord: mockRefundPaymentRecord,
  retryShortfallForRecord: mockRetryShortfallForRecord,
  runPaymentReconciliation: mockRunPaymentReconciliation,
  saveDriverMethod: mockSaveDriverMethod,
  removeDriverMethod: mockRemoveDriverMethod,
  setDefaultDriverMethod: mockSetDefaultDriverMethod,
  startDriverMethodSetup: mockStartDriverMethodSetup,
  PaymentProviderNotConfiguredError: MockPaymentProviderNotConfiguredError,
}));

vi.mock('../lib/payments.js', () => ({
  paymentRegistry: { getPaymentProvider: mockGetPaymentProvider },
  paymentContext: mockPaymentContext,
  clearPaymentCaches: mockClearPaymentCaches,
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { paymentRoutes } from '../routes/payments.js';
import { db } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import { getUserSiteIds } from '../lib/site-access.js';

/** The payment context the routes build from the request logger. */
const CTX = { registry: 'registry', logger: expect.anything() };

function paymentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    sessionId: VALID_SESSION_ID,
    driverId: null,
    sitePaymentConfigId: null,
    stripePaymentIntentId: 'pi_test_123',
    stripeCustomerId: 'cus_test',
    paymentSource: null,
    currency: 'USD',
    preAuthAmountCents: 5000,
    capturedAmountCents: null,
    refundedAmountCents: 0,
    status: 'pre_authorized',
    failureReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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
      expect(response.json().stripeConnectedAccountId).toBe('acct_123');
      expect(response.json()).not.toHaveProperty('currency');
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
        preAuthAmountCents: 7500,
        platformFeePercent: null,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site existence pre-check
        [{ id: 'pc-1' }], // existing found
        [updated], // update returning
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
        payload: { preAuthAmountCents: 7500, isEnabled: true, currency: 'EUR' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().preAuthAmountCents).toBe(7500);
      const updateChain = vi.mocked(db.update).mock.results.at(-1)?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.not.objectContaining({ currency: expect.anything() }),
      );
      expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it('creates new payment config when none exists', async () => {
      const created = {
        id: 'pc-new',
        siteId: VALID_SITE_ID,
        stripeConnectedAccountId: null,
        preAuthAmountCents: 5000,
        platformFeePercent: null,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site existence pre-check
        [], // no existing
        [created], // insert returning
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe('pc-new');
      expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it('returns 404 without writing when the site does not exist', async () => {
      setupDbResults([]); // site existence pre-check

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
      expect(mockClearPaymentCaches).not.toHaveBeenCalled();
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
      expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
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
      expect(mockClearPaymentCaches).not.toHaveBeenCalled();
    });
  });

  // --- GET /v1/settings/stripe ---

  describe('GET /v1/settings/stripe', () => {
    it('returns stripe settings from database', async () => {
      const rows = [
        { key: 'stripe.publishableKey', value: 'pk_test_123' },
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
      expect(body).not.toHaveProperty('currency');
      expect(body).toHaveProperty('preAuthAmountCents');
      expect(body).toHaveProperty('platformFeePercent');
      expect(body.webhookSecret).toBeNull();
    });

    it('returns the decrypted webhook signing secret when set', async () => {
      setupDbResults([
        { key: 'stripe.secretKeyEnc', value: 'enc_sk' },
        { key: 'stripe.webhookSecretEnc', value: 'enc_whsec' },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().secretKey).toBe('decrypted:enc_sk');
      expect(response.json().webhookSecret).toBe('decrypted:enc_whsec');
    });
  });

  // --- PUT /v1/settings/stripe ---

  describe('PUT /v1/settings/stripe', () => {
    it('saves stripe settings and returns success', async () => {
      // 1 SELECT for the before-snapshot, 2 upserts (publishableKey,
      // preAuthAmountCents), then 2 parallel audit inserts via Promise.allSettled.
      setupDbResults([], [], [], [], []);
      vi.mocked(db.insert).mockClear();

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
      const written = vi
        .mocked(db.insert)
        .mock.results.flatMap(
          (res) =>
            (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
        )
        .map(([row]) => (row as { key?: string }).key);
      expect(written).toContain('stripe.publishableKey');
      expect(written).not.toContain('stripe.currency');
      expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it('stores the webhook signing secret encrypted under stripe.webhookSecretEnc', async () => {
      setupDbResults([], [], []);
      vi.mocked(db.insert).mockClear();

      const response = await app.inject({
        method: 'PUT',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
        payload: { webhookSecret: 'whsec_test_1' },
      });

      expect(response.statusCode).toBe(200);
      const rows = vi
        .mocked(db.insert)
        .mock.results.flatMap(
          (res) =>
            (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
        )
        .map(([row]) => row as { key?: string; value?: unknown });
      expect(rows).toContainEqual({ key: 'stripe.webhookSecretEnc', value: 'encrypted_value' });
      expect(rows.some((r) => r.value === 'whsec_test_1')).toBe(false);
    });

    function writtenRows(): Array<{ key?: string; value?: unknown }> {
      return vi
        .mocked(db.insert)
        .mock.results.flatMap(
          (res) =>
            (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
        )
        .map(([row]) => row as { key?: string; value?: unknown });
    }

    it('selects Stripe as the provider when a secret key is saved and no provider is set', async () => {
      setupDbResults([{ value: 'none' }], [], [], [], [], []);
      vi.mocked(db.insert).mockClear();

      const response = await app.inject({
        method: 'PUT',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
        payload: { secretKey: 'sk_test_new' },
      });

      expect(response.statusCode).toBe(200);
      expect(writtenRows()).toContainEqual({ key: 'payments.provider', value: 'stripe' });
      expect(writtenRows()).toContainEqual({
        key: 'stripe.secretKeyEnc',
        value: 'encrypted_value',
      });
      expect(mockClearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it('keeps another selected provider when a Stripe secret key is saved', async () => {
      setupDbResults([{ value: 'adyen' }], [], [], [], []);
      vi.mocked(db.insert).mockClear();

      const response = await app.inject({
        method: 'PUT',
        url: '/settings/stripe',
        headers: { authorization: 'Bearer ' + token },
        payload: { secretKey: 'sk_test_new' },
      });

      expect(response.statusCode).toBe(200);
      expect(writtenRows().map((r) => r.key)).not.toContain('payments.provider');
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
    const payload = {
      stripePaymentMethodId: 'pm_test',
      stripeCustomerId: 'cus_test',
      cardBrand: 'visa',
      cardLast4: '4242',
    };

    it('saves a payment method, adopting the setup customer, and returns 201', async () => {
      const method = {
        id: 1,
        driverId: VALID_DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        cardBrand: 'visa',
        cardLast4: '4242',
        isDefault: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockSaveDriverMethod.mockResolvedValueOnce({ status: 'saved', method });

      const response = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().isDefault).toBe(true);
      expect(response.json().stripePaymentMethodId).toBe('pm_test');
      expect(mockSaveDriverMethod).toHaveBeenCalledWith(
        {
          driverId: VALID_DRIVER_ID,
          customerId: 'cus_test',
          methodId: 'pm_test',
          adoptCustomer: true,
        },
        CTX,
      );
    });

    it.each([
      ['driver_not_found', 404, 'DRIVER_NOT_FOUND', 'Driver not found'],
      ['forbidden', 403, 'FORBIDDEN', 'Forbidden'],
      ['not_initialized', 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'No payment provider configured'],
      ['not_configured', 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'No payment provider configured'],
      ['verify_failed', 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'Could not verify payment method'],
    ])('maps the %s outcome to %i %s', async (status, statusCode, code, error) => {
      mockSaveDriverMethod.mockResolvedValueOnce(
        status === 'verify_failed' ? { status, reason: 'not attached' } : { status },
      );

      const response = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ error, code });
    });
  });

  // --- DELETE /v1/drivers/:id/payment-methods/:pmId ---

  describe('DELETE /v1/drivers/:id/payment-methods/:pmId', () => {
    it('removes the payment method even while in use and returns success', async () => {
      mockRemoveDriverMethod.mockResolvedValueOnce({ status: 'removed' });

      const response = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockRemoveDriverMethod).toHaveBeenCalledWith(
        { driverId: VALID_DRIVER_ID, methodRowId: 1, blockWhenInUse: false },
        CTX,
      );
    });

    it('returns 404 when payment method not found', async () => {
      mockRemoveDriverMethod.mockResolvedValueOnce({ status: 'not_found' });

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
        id: 1,
        driverId: VALID_DRIVER_ID,
        stripeCustomerId: 'cus_test',
        stripePaymentMethodId: 'pm_test',
        cardBrand: null,
        cardLast4: null,
        isDefault: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockSetDefaultDriverMethod.mockResolvedValueOnce(updated);

      const response = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/${VALID_PM_ID}/default`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().isDefault).toBe(true);
      expect(mockSetDefaultDriverMethod).toHaveBeenCalledWith(VALID_DRIVER_ID, 1);
    });

    it('returns 404 when payment method not found', async () => {
      mockSetDefaultDriverMethod.mockResolvedValueOnce(null);

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
      // First query joins session->station to derive siteId for the
      // site-access guard; second query fetches the payment record.
      setupDbResults([{ siteId: VALID_SITE_ID }], [record]);

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
    const sessionRow = { id: VALID_SESSION_ID, driverId: VALID_DRIVER_ID, siteId: VALID_SITE_ID };

    async function preAuthorize(payload: Record<string, unknown> = { paymentMethodId: 1 }) {
      return app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/pre-authorize`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });
    }

    it('places the hold with the operator trigger and returns the payment record', async () => {
      setupDbResults([sessionRow], [paymentRecord({ status: 'pre_authorized' })]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 1,
        paymentId: 'pi_test_123',
      });

      const response = await preAuthorize({ paymentMethodId: 1, amountCents: 2500 });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('pre_authorized');
      expect(response.json().stripePaymentIntentId).toBe('pi_test_123');
      expect(mockAuthorizeSessionHold).toHaveBeenCalledWith(
        {
          sessionId: VALID_SESSION_ID,
          driverId: VALID_DRIVER_ID,
          methodRowId: 1,
          siteId: VALID_SITE_ID,
          amountCents: 2500,
          trigger: 'operator',
        },
        CTX,
      );
    });

    it('omits amountCents when the body has none', async () => {
      setupDbResults([sessionRow], [paymentRecord({ status: 'pre_authorized' })]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 1,
        paymentId: 'pi_test_123',
      });

      await preAuthorize();

      const [input] = mockAuthorizeSessionHold.mock.calls[0] as [Record<string, unknown>];
      expect(input).not.toHaveProperty('amountCents');
    });

    it('returns the existing record when a retried request replays the same hold', async () => {
      setupDbResults([sessionRow], [paymentRecord({ status: 'pre_authorized' })]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'exists',
        paymentRecordId: 1,
        status: 'pre_authorized',
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe('1');
      expect(response.json().stripePaymentIntentId).toBe('pi_test_123');
    });

    it('returns 400 PRE_AUTH_FAILED when the session already has a non-hold record', async () => {
      setupDbResults([sessionRow], [paymentRecord({ status: 'captured' })]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'exists',
        paymentRecordId: 1,
        status: 'captured',
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PRE_AUTH_FAILED');
      expect(response.json().error).toBe('The session already has a payment record');
      expect(response.json().paymentRecord.status).toBe('captured');
    });

    it('returns 400 PRE_AUTH_FAILED with the failed record when the card is declined', async () => {
      setupDbResults(
        [sessionRow],
        [paymentRecord({ status: 'failed', failureReason: 'Your card was declined.' })],
      );
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'Your card was declined.',
        paymentRecordId: 1,
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'Your card was declined.',
        code: 'PRE_AUTH_FAILED',
        paymentRecord: { id: '1', status: 'failed' },
      });
    });

    it('returns 400 PRE_AUTH_FAILED with a null record when the decline wrote none', async () => {
      setupDbResults([sessionRow], []);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'Card cannot be used off session',
        paymentRecordId: null,
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Card cannot be used off session',
        code: 'PRE_AUTH_FAILED',
        paymentRecord: null,
      });
    });

    it('returns 404 when session not found', async () => {
      setupDbResults([]);

      const response = await preAuthorize();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });

    it('returns 404 when payment method not found', async () => {
      setupDbResults([sessionRow]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({ outcome: 'no_method' });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });

    it('returns 400 PAYMENT_PROVIDER_NOT_CONFIGURED when the pinned provider is unavailable', async () => {
      setupDbResults([sessionRow]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'not_configured',
        providerId: 'stripe',
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'No payment provider configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        paymentRecord: null,
      });
    });

    it('returns 500 when the hold could not be recorded', async () => {
      setupDbResults([sessionRow]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'record_failed',
        reason: 'insert failed',
      });

      const response = await preAuthorize();

      expect(response.statusCode).toBe(500);
    });
  });

  // --- POST /v1/sessions/:id/capture ---

  describe('POST /v1/sessions/:id/capture', () => {
    async function capture(payload: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/capture`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });
    }

    it('captures payment and returns updated record', async () => {
      mockCaptureSessionHold.mockResolvedValueOnce({
        status: 'captured',
        record: paymentRecord({ status: 'captured', capturedAmountCents: 1200 }),
      });

      const response = await capture();

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('captured');
      expect(response.json().capturedAmountCents).toBe(1200);
      expect(mockCaptureSessionHold).toHaveBeenCalledWith({ sessionId: VALID_SESSION_ID }, CTX);
    });

    it('passes a zero amount through and returns the cancelled record', async () => {
      mockCaptureSessionHold.mockResolvedValueOnce({
        status: 'cancelled',
        record: paymentRecord({ status: 'cancelled' }),
      });

      const response = await capture({ amountCents: 0 });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('cancelled');
      expect(mockCaptureSessionHold).toHaveBeenCalledWith(
        { sessionId: VALID_SESSION_ID, amountCents: 0 },
        CTX,
      );
    });

    it('returns 404 when no pre-authorized payment', async () => {
      mockCaptureSessionHold.mockResolvedValueOnce({ status: 'no_hold' });

      const response = await capture();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('NO_PRE_AUTH');
    });

    it('returns 400 when payment intent missing', async () => {
      mockCaptureSessionHold.mockResolvedValueOnce({ status: 'missing_payment_id' });

      const response = await capture();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MISSING_PAYMENT_INTENT');
    });

    it('returns 400 when the provider is not configured', async () => {
      mockCaptureSessionHold.mockResolvedValueOnce({
        status: 'not_configured',
        providerId: 'stripe',
      });

      const response = await capture();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'No payment provider configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });
  });

  // --- POST /v1/sessions/:id/refund ---

  describe('POST /v1/sessions/:id/refund', () => {
    async function refund(payload: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: `/sessions/${VALID_SESSION_ID}/refund`,
        headers: { authorization: 'Bearer ' + token },
        payload,
      });
    }

    it('refunds, returns the updated record and notifies the driver', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'refunded',
        record: paymentRecord({
          status: 'refunded',
          driverId: VALID_DRIVER_ID,
          capturedAmountCents: 1500,
          refundedAmountCents: 1500,
        }),
        refundedNowCents: 1500,
        full: true,
      });

      const response = await refund();

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('refunded');
      expect(mockRefundPaymentRecord).toHaveBeenCalledWith(
        {
          sessionId: VALID_SESSION_ID,
          actorUserId: VALID_USER_ID,
          actionReason: expect.any(Function),
        },
        CTX,
      );
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'payment.Refunded',
        VALID_DRIVER_ID,
        expect.objectContaining({
          amountCents: 1500,
          currency: 'USD',
          transactionId: VALID_SESSION_ID,
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('passes a partial amount and records the operator reason', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'refunded',
        record: paymentRecord({ status: 'partially_refunded', refundedAmountCents: 500 }),
        refundedNowCents: 500,
        full: false,
      });

      const response = await refund({ amountCents: 500, reason: 'Goodwill' });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('partially_refunded');
      const [request] = mockRefundPaymentRecord.mock.calls[0] as [
        { amountCents?: number; actionReason: (full: boolean) => string | null },
      ];
      expect(request.amountCents).toBe(500);
      expect(request.actionReason(false)).toBe('Goodwill');
      // No driver on the record: no notification.
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    });

    it('defaults the action reason to full or partial refund', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'refunded',
        record: paymentRecord({ status: 'refunded' }),
        refundedNowCents: 1500,
        full: true,
      });

      await refund();

      const [request] = mockRefundPaymentRecord.mock.calls[0] as [
        { actionReason: (full: boolean) => string | null },
      ];
      expect(request.actionReason(true)).toBe('Full refund');
      expect(request.actionReason(false)).toBe('Partial refund');
    });

    it('returns 404 without refunding when the session is on a site outside the operator access', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_000000000099']);

      const response = await refund();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_NOT_FOUND');
      expect(mockRefundPaymentRecord).not.toHaveBeenCalled();
    });

    it('returns 400 when no captured payment', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({ status: 'no_captured_payment' });

      const response = await refund();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('NO_CAPTURED_PAYMENT');
    });

    it('returns 400 when payment intent missing on refund', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({ status: 'missing_payment_id' });

      const response = await refund();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MISSING_PAYMENT_INTENT');
    });

    it('returns 400 when the provider is not configured', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'not_configured',
        providerId: 'stripe',
      });

      const response = await refund();

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    });

    it('returns 409 REFUND_EXCEEDS_REMAINING when amount exceeds remaining', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'exceeds_remaining',
        remainingCents: 1000,
        requestedCents: 5000,
        currency: 'USD',
      });

      const response = await refund({ amountCents: 5000 });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Refund amount 5000 exceeds remaining refundable balance 1000',
        code: 'REFUND_EXCEEDS_REMAINING',
      });
    });

    it('returns 409 REFUND_EXCEEDS_REMAINING when nothing is left to refund', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRefundPaymentRecord.mockResolvedValueOnce({
        status: 'nothing_refundable',
        remainingCents: 0,
      });

      const response = await refund();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Refund amount 0 exceeds remaining refundable balance 0',
        code: 'REFUND_EXCEEDS_REMAINING',
      });
    });
  });

  // --- POST /v1/payments/:id/retry-capture ---

  describe('POST /v1/payments/:id/retry-capture', () => {
    async function retry() {
      return app.inject({
        method: 'POST',
        url: '/payments/1/retry-capture',
        headers: { authorization: 'Bearer ' + token },
      });
    }

    it('recovers the shortfall and returns the record', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRetryShortfallForRecord.mockResolvedValueOnce({
        status: 'recovered',
        record: paymentRecord({ status: 'captured', capturedAmountCents: 2000 }),
        shortfallCents: 500,
        topUpId: 'pi_topup',
      });

      const response = await retry();

      expect(response.statusCode).toBe(200);
      expect(response.json().capturedAmountCents).toBe(2000);
      expect(mockRetryShortfallForRecord).toHaveBeenCalledWith(
        { recordId: 1, actorUserId: VALID_USER_ID },
        CTX,
      );
    });

    it('returns 404 without retrying when the payment is on a site outside the operator access', async () => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_000000000099']);

      const response = await retry();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_NOT_FOUND');
      expect(mockRetryShortfallForRecord).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: 'not_found' }, 404, { error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' }],
      [
        { status: 'not_recoverable', reason: 'No shortfall to recover' },
        409,
        { error: 'No shortfall to recover', code: 'PAYMENT_RECORD_NOT_RECOVERABLE' },
      ],
      [
        { status: 'not_configured', providerId: 'stripe' },
        409,
        { error: 'Payment provider not configured', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' },
      ],
      [
        { status: 'failed', reason: 'Your card was declined.' },
        502,
        {
          error: 'The payment provider rejected the top-up: Your card was declined.',
          code: 'PAYMENT_TOP_UP_FAILED',
        },
      ],
    ])('maps %o to %i', async (outcome, statusCode, body) => {
      setupDbResults([{ siteId: VALID_SITE_ID }]);
      mockRetryShortfallForRecord.mockResolvedValueOnce(outcome);

      const response = await retry();

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual(body);
    });
  });

  // --- POST /v1/payments/reconciliation/run ---

  describe('POST /v1/payments/reconciliation/run', () => {
    it('runs the reconciliation and returns its result', async () => {
      mockRunPaymentReconciliation.mockResolvedValueOnce({
        checked: 3,
        matched: 2,
        discrepancies: [
          { paymentRecordId: 7, localStatus: 'captured', providerStatus: 'refunded' },
        ],
        errors: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/payments/reconciliation/run',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ checked: 3, matched: 2, errors: [] });
      expect(response.json().discrepancies).toHaveLength(1);
      expect(mockRunPaymentReconciliation).toHaveBeenCalledWith(CTX);
    });
  });

  // --- POST /v1/drivers/:id/payment-methods/setup-intent ---

  describe('POST /v1/drivers/:id/payment-methods/setup-intent', () => {
    async function setupIntent() {
      return app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/payment-methods/setup-intent`,
        headers: { authorization: 'Bearer ' + token },
      });
    }

    it('starts a web setup for the driver and returns the Stripe fields', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'started',
        providerId: 'stripe',
        customerId: 'cus_test_123',
        session: {
          provider: 'stripe',
          clientSecret: 'seti_secret_123',
          customerId: 'cus_test_123',
          publishableKey: 'pk_test_123',
        },
      });

      const response = await setupIntent();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'stripe',
        clientSecret: 'seti_secret_123',
        customerId: 'cus_test_123',
        publishableKey: 'pk_test_123',
      });
      expect(mockStartDriverMethodSetup).toHaveBeenCalledWith(
        { driverId: VALID_DRIVER_ID, channel: 'web' },
        CTX,
      );
    });

    it('returns a null client secret and empty publishable key for a non-Stripe session', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'started',
        providerId: 'simulated',
        customerId: 'sim_cus_1',
        session: { provider: 'simulated' },
      });

      const response = await setupIntent();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'simulated',
        clientSecret: null,
        customerId: 'sim_cus_1',
        publishableKey: '',
      });
    });

    it('returns 404 when driver not found', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({ status: 'driver_not_found' });

      const response = await setupIntent();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 400 PAYMENT_PROVIDER_NOT_CONFIGURED when no provider is configured', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({ status: 'not_configured' });

      const response = await setupIntent();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'No payment provider configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });

    it('returns 400 PAYMENT_PROVIDER_NOT_CONFIGURED with the provider reason when the setup fails', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'failed',
        reason: 'Invalid API Key provided',
      });

      const response = await setupIntent();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'The payment provider rejected the request: Invalid API Key provided',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });
  });

  // --- POST /v1/settings/stripe/test ---

  describe('POST /v1/settings/stripe/test', () => {
    async function testConnection() {
      return app.inject({
        method: 'POST',
        url: '/settings/stripe/test',
        headers: { authorization: 'Bearer ' + token },
      });
    }

    it('returns success when Stripe connection works', async () => {
      const testConnectionMock = vi.fn().mockResolvedValue(undefined);
      mockGetPaymentProvider.mockResolvedValueOnce({ testConnection: testConnectionMock });

      const response = await testConnection();

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockGetPaymentProvider).toHaveBeenCalledWith('stripe');
      expect(testConnectionMock).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when Stripe is not configured', async () => {
      mockGetPaymentProvider.mockRejectedValueOnce(
        new MockPaymentProviderNotConfiguredError('stripe'),
      );

      const response = await testConnection();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Stripe is not configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });

    it('returns 400 when Stripe connection fails', async () => {
      mockGetPaymentProvider.mockResolvedValueOnce({
        testConnection: vi.fn().mockRejectedValue(new Error('Invalid API key')),
      });

      const response = await testConnection();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Invalid API key',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
    });

    it('returns a generic message when the connection test throws a non-Error', async () => {
      mockGetPaymentProvider.mockResolvedValueOnce({
        testConnection: vi.fn().mockRejectedValue('boom'),
      });

      const response = await testConnection();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Connection failed',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
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
