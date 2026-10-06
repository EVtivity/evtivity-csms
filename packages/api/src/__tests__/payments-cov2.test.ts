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

const { mockRequestHasPermission } = vi.hoisted(() => ({
  mockRequestHasPermission: vi.fn(async (_request: unknown, _permission: string) => true),
}));

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
  requestHasPermission: mockRequestHasPermission,
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
    reservations: {},
    settingAuditLog: {},
    siteAuditLog: {},
    writeAudit: vi.fn(async () => undefined),
    pgErrorCode: (err: unknown) => (err as { code?: string }).code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
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

vi.mock('@evtivity/lib', async () => ({
  formatCurrencyAmount: (
    await vi.importActual<typeof import('@evtivity/lib/currency')>('@evtivity/lib/currency')
  ).formatCurrencyAmount,
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
  mockDispatchFeeRefundNotification,
  mockRetryShortfallForRecord,
  mockRunPaymentReconciliation,
  mockSaveDriverMethod,
  mockRemoveDriverMethod,
  mockSetDefaultDriverMethod,
  mockStartDriverMethodSetup,
  mockSubmitDriverMethodSetup,
  mockContinueDriverMethodSetup,
  mockGetPaymentProvider,
  mockClearPaymentCaches,
  mockPaymentContext,
  MockPaymentProviderNotConfiguredError,
  MockWebhookExistsError,
  MockPaymentProviderPermissionError,
  mockSetSitePayoutAccountId,
  mockRevokePayoutInvites,
} = vi.hoisted(() => {
  class MockPaymentProviderNotConfiguredError extends Error {
    readonly providerId: string;
    constructor(providerId: string) {
      super(`Payment provider ${providerId} is not configured`);
      this.providerId = providerId;
    }
  }
  class MockWebhookExistsError extends Error {
    constructor(
      readonly providerId: string,
      readonly endpoints: unknown[],
      readonly otherEndpoints: unknown[] = [],
    ) {
      super(`An EVtivity webhook already exists for ${providerId}`);
    }
  }
  class MockPaymentProviderPermissionError extends Error {
    constructor(
      readonly providerId: string,
      readonly permission: string,
    ) {
      super(`The ${providerId} credential lacks a required permission: ${permission}`);
    }
  }
  return {
    MockWebhookExistsError,
    MockPaymentProviderPermissionError,
    mockAuthorizeSessionHold: vi.fn(),
    mockCaptureSessionHold: vi.fn(),
    mockRefundPaymentRecord: vi.fn(),
    mockDispatchFeeRefundNotification: vi.fn(() => Promise.resolve()),
    mockRetryShortfallForRecord: vi.fn(),
    mockRunPaymentReconciliation: vi.fn(),
    mockSaveDriverMethod: vi.fn(),
    mockRemoveDriverMethod: vi.fn(),
    mockSetDefaultDriverMethod: vi.fn(),
    mockStartDriverMethodSetup: vi.fn(),
    mockSubmitDriverMethodSetup: vi.fn(),
    mockContinueDriverMethodSetup: vi.fn(),
    mockSetSitePayoutAccountId: vi.fn(),
    mockRevokePayoutInvites: vi.fn(),
    mockGetPaymentProvider: vi.fn(),
    mockClearPaymentCaches: vi.fn(),
    mockPaymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
    MockPaymentProviderNotConfiguredError,
  };
});

vi.mock('@evtivity/payments', async () => ({
  // Pure URL matching: the real implementation.
  partitionWebhookEndpoints: (await import('../../../payments/src/webhook-endpoint-url.js'))
    .partitionWebhookEndpoints,
  authorizeSessionHold: mockAuthorizeSessionHold,
  captureSessionHold: mockCaptureSessionHold,
  refundPaymentRecord: mockRefundPaymentRecord,
  dispatchFeeRefundNotification: mockDispatchFeeRefundNotification,
  retryShortfallForRecord: mockRetryShortfallForRecord,
  runPaymentReconciliation: mockRunPaymentReconciliation,
  saveDriverMethod: mockSaveDriverMethod,
  removeDriverMethod: mockRemoveDriverMethod,
  setDefaultDriverMethod: mockSetDefaultDriverMethod,
  startDriverMethodSetup: mockStartDriverMethodSetup,
  submitDriverMethodSetup: mockSubmitDriverMethodSetup,
  continueDriverMethodSetup: mockContinueDriverMethodSetup,
  setSitePayoutAccountId: mockSetSitePayoutAccountId,
  PaymentProviderNotConfiguredError: MockPaymentProviderNotConfiguredError,
  WebhookExistsError: MockWebhookExistsError,
  PaymentProviderPermissionError: MockPaymentProviderPermissionError,
  STRIPE_PLATFORM_EVENTS: [
    'payment_intent.payment_failed',
    'charge.refunded',
    'charge.dispute.created',
  ],
  STRIPE_CONNECT_EVENTS: ['account.updated'],
  STRIPE_WEBHOOK_API_VERSION: '2026-09-30.endive',
}));

vi.mock('../lib/payments.js', () => ({
  paymentRegistry: { getPaymentProvider: mockGetPaymentProvider },
  paymentContext: mockPaymentContext,
  clearPaymentCaches: mockClearPaymentCaches,
}));

vi.mock('../services/payout-onboarding.service.js', () => ({
  revokePayoutInvites: mockRevokePayoutInvites,
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

const { mockHoldFeeCheck } = vi.hoisted(() => ({
  mockHoldFeeCheck: vi.fn(async () => ({ sessionFeeCents: 0, holdBelowSessionFee: false })),
}));
vi.mock('../lib/hold-fee-check.js', () => ({ holdFeeCheck: mockHoldFeeCheck }));

import { registerAuth } from '../plugins/auth.js';
import { paymentRoutes } from '../routes/payments.js';
import { config as apiConfig } from '../lib/config.js';
import { db } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import { getUserSiteIds } from '../lib/site-access.js';
import { inArray } from 'drizzle-orm';

/** The payment context the routes build from the request logger. */
const CTX = { registry: 'registry', logger: expect.anything() };

function paymentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    sessionId: VALID_SESSION_ID,
    driverId: null,
    sitePaymentConfigId: null,
    provider: 'stripe',
    providerPaymentId: 'pi_test_123',
    providerCustomerId: 'cus_test',
    providerPaymentMethodId: 'pm_test',
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

const SITE_CONFIG = {
  id: 'pc-1',
  siteId: VALID_SITE_ID,
  payoutAccountId: null,
  preAuthAmountCents: 5000,
  platformFeePercent: null,
  isEnabled: true,
  payoutAccountStatus: null,
  payoutAccountDetails: null,
  payoutAccountCheckedAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const OTHER_SITE = 'sit_000000000099';

describe('payment routes - site scope, FK races, provider gaps', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    headers = {
      authorization: `Bearer ${app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.mocked(getUserSiteIds).mockResolvedValue(null);
  });

  describe('site payment config scoped to the operator sites', () => {
    it('GET returns 404 PAYMENT_CONFIG_NOT_FOUND for a site outside access', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'No payment config for this site',
        code: 'PAYMENT_CONFIG_NOT_FOUND',
      });
    });

    it('PUT returns 404 for a site outside access without writing', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
        payload: { isEnabled: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PAYMENT_CONFIG_NOT_FOUND');
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('DELETE returns 404 for a site outside access without deleting', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PAYMENT_CONFIG_NOT_FOUND');
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('GET /sites/payment-configs returns [] for an operator without sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/sites/payment-configs', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('GET /sites/payment-configs filters to the operator sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([VALID_SITE_ID]);
      setupDbResults([SITE_CONFIG]);
      const res = await app.inject({ method: 'GET', url: '/sites/payment-configs', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([expect.objectContaining({ id: 'pc-1', siteId: VALID_SITE_ID })]);
      expect(inArray).toHaveBeenCalledWith(undefined, [VALID_SITE_ID]);
    });
  });

  describe('PUT creating a site payment config', () => {
    it('maps a foreign key race on insert to 404 SITE_NOT_FOUND', async () => {
      setupDbResults([{ id: VALID_SITE_ID }], []);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        const chain = makeChain();
        chain['then'] = (_r?: unknown, reject?: (e: unknown) => unknown) =>
          Promise.reject(Object.assign(new Error('fk'), { code: '23503' })).catch(reject);
        return chain as never;
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
        payload: { isEnabled: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      expect(mockClearPaymentCaches).not.toHaveBeenCalled();
    });

    it('rethrows other insert errors as 500', async () => {
      setupDbResults([{ id: VALID_SITE_ID }], []);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        const chain = makeChain();
        chain['then'] = (_r?: unknown, reject?: (e: unknown) => unknown) =>
          Promise.reject(new Error('boom')).catch(reject);
        return chain as never;
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
        payload: { isEnabled: true },
      });
      expect(res.statusCode).toBe(500);
    });

    it('stores a connected account given on create and returns the re-read config', async () => {
      const withAccount = {
        ...SITE_CONFIG,
        payoutAccountId: 'acct_1',
        payoutAccountStatus: 'onboarding',
      };
      setupDbResults([{ id: VALID_SITE_ID }], [], [SITE_CONFIG], [withAccount]);
      mockSetSitePayoutAccountId.mockResolvedValue(true);
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
        payload: {
          payoutAccountId: '  acct_1 ',
          preAuthAmountCents: 4000,
          platformFeePercent: 2.5,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        payoutAccountId: 'acct_1',
        payoutAccountStatus: 'onboarding',
      });
      expect(mockSetSitePayoutAccountId).toHaveBeenCalledWith(VALID_SITE_ID, 'acct_1', CTX);
      expect(mockRevokePayoutInvites).toHaveBeenCalledWith(VALID_SITE_ID);
      const insertChain = vi.mocked(db.insert).mock.results[0]?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith({
        siteId: VALID_SITE_ID,
        preAuthAmountCents: 4000,
        platformFeePercent: '2.5',
        isEnabled: true,
      });
    });
  });

  describe('DELETE site payment config errors', () => {
    it('answers 409 SITE_PAYMENT_CONFIG_IN_USE when payments reference the config', async () => {
      vi.mocked(db.delete).mockImplementationOnce(() => {
        const chain = makeChain();
        chain['then'] = (_r?: unknown, reject?: (e: unknown) => unknown) =>
          Promise.reject(Object.assign(new Error('fk'), { code: '23503' })).catch(reject);
        return chain as never;
      });
      const res = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SITE_PAYMENT_CONFIG_IN_USE');
      expect(mockRevokePayoutInvites).not.toHaveBeenCalled();
    });

    it('rethrows other delete errors as 500', async () => {
      vi.mocked(db.delete).mockImplementationOnce(() => {
        const chain = makeChain();
        chain['then'] = (_r?: unknown, reject?: (e: unknown) => unknown) =>
          Promise.reject(new Error('boom')).catch(reject);
        return chain as never;
      });
      const res = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}/payment-config`,
        headers,
      });
      expect(res.statusCode).toBe(500);
    });
  });

  it('PUT /settings/stripe fails with 500 when SETTINGS_ENCRYPTION_KEY is empty', async () => {
    const original = apiConfig.SETTINGS_ENCRYPTION_KEY;
    (apiConfig as { SETTINGS_ENCRYPTION_KEY: string }).SETTINGS_ENCRYPTION_KEY = '';
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/stripe',
        headers,
        payload: { secretKey: 'sk_test_x' },
      });
      expect(res.statusCode).toBe(500);
      expect(db.insert).not.toHaveBeenCalled();
    } finally {
      (apiConfig as { SETTINGS_ENCRYPTION_KEY: string }).SETTINGS_ENCRYPTION_KEY = original;
    }
  });

  describe('Stripe webhook calls on a provider without webhook support', () => {
    const URL = 'https://csms.example.com/v1/webhooks/payments/stripe';

    it('GET /settings/stripe/webhook answers 400 PAYMENT_PROVIDER_CONNECTION_FAILED', async () => {
      mockGetPaymentProvider.mockResolvedValueOnce({ id: 'stripe' });
      const res = await app.inject({ method: 'GET', url: '/settings/stripe/webhook', headers });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Payment provider stripe cannot list webhooks',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
    });

    it('POST /settings/stripe/webhook answers 400 PAYMENT_PROVIDER_CONNECTION_FAILED', async () => {
      mockGetPaymentProvider.mockResolvedValueOnce({ id: 'stripe' });
      const res = await app.inject({
        method: 'POST',
        url: '/settings/stripe/webhook',
        headers,
        payload: { url: URL, replace: false },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Payment provider stripe cannot register webhooks',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  it('POST /drivers/:id/payment-methods/setup/details continues the setup and returns 201', async () => {
    const ATTEMPT = '0b6f3c2e-6a51-4a55-9a77-2f4d3d6c1e10';
    const method = {
      id: 2,
      driverId: VALID_DRIVER_ID,
      provider: 'simulated',
      providerCustomerId: 'cus_sim_1',
      providerPaymentMethodId: 'pm_sim_1',
      cardBrand: 'visa',
      cardLast4: '4242',
      isDefault: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    mockContinueDriverMethodSetup.mockResolvedValueOnce({ status: 'saved', method });
    const res = await app.inject({
      method: 'POST',
      url: `/drivers/${VALID_DRIVER_ID}/payment-methods/setup/details`,
      headers,
      payload: {
        provider: 'simulated',
        attemptId: ATTEMPT,
        details: { methodId: 'm1', outcome: 'approve' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'saved', method: { id: '2' } });
    expect(mockContinueDriverMethodSetup).toHaveBeenCalledWith(
      {
        driverId: VALID_DRIVER_ID,
        providerId: 'simulated',
        attemptId: ATTEMPT,
        details: { methodId: 'm1', outcome: 'approve' },
      },
      CTX,
    );
  });

  it('POST /sessions/:id/refund answers 200 when the refund notification fails', async () => {
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
      pendingCents: 0,
      refundStatus: 'succeeded',
      full: true,
    });
    vi.mocked(dispatchDriverNotification).mockImplementationOnce(() =>
      Promise.reject(new Error('smtp')),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${VALID_SESSION_ID}/refund`,
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      expect.anything(),
      'payment.Refunded',
      VALID_DRIVER_ID,
      expect.objectContaining({ amountCents: 1500 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('GET /reservations/:id/fee-payments answers 404 for an unknown reservation', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: '/reservations/rsv_000000000001/fee-payments',
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
  });

  it('GET /sessions/:id/payment answers 404 for a session on a site outside access', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([OTHER_SITE]);
    setupDbResults([{ siteId: VALID_SITE_ID }]);
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${VALID_SESSION_ID}/payment`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'No payment record for this session',
      code: 'PAYMENT_NOT_FOUND',
    });
  });

  describe('GET /payments/reconciliation', () => {
    it('returns the page of runs with the total', async () => {
      const run = {
        id: 3,
        checkedCount: 10,
        matchedCount: 9,
        discrepancyCount: 1,
        errorCount: 0,
        discrepancies: [],
        errors: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      setupDbResults([run], [{ count: 4 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/payments/reconciliation?page=2&limit=1',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        data: [expect.objectContaining({ id: '3', matchedCount: 9 })],
        total: 4,
      });
    });

    it('returns total 0 when the count query has no row', async () => {
      setupDbResults([], []);
      const res = await app.inject({ method: 'GET', url: '/payments/reconciliation', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  it('GET /payments returns an empty page for an operator without sites', async () => {
    vi.mocked(getUserSiteIds).mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/payments', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
});
