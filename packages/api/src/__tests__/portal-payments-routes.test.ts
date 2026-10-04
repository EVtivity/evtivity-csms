// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DriverPaymentMethod } from '@evtivity/payments';

const {
  mockListDriverMethods,
  mockStartDriverMethodSetup,
  mockSaveDriverMethod,
  mockRemoveDriverMethod,
  mockSetDefaultDriverMethod,
  mockSubmitDriverMethodSetup,
  mockContinueDriverMethodSetup,
  mockPaymentContext,
  mockGetMobileAppConfig,
} = vi.hoisted(() => ({
  mockListDriverMethods: vi.fn(),
  mockStartDriverMethodSetup: vi.fn(),
  mockSaveDriverMethod: vi.fn(),
  mockRemoveDriverMethod: vi.fn(),
  mockSetDefaultDriverMethod: vi.fn(),
  mockSubmitDriverMethodSetup: vi.fn(),
  mockContinueDriverMethodSetup: vi.fn(),
  mockPaymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
  mockGetMobileAppConfig: vi.fn(),
}));

vi.mock('@evtivity/payments', () => ({
  listDriverMethods: mockListDriverMethods,
  startDriverMethodSetup: mockStartDriverMethodSetup,
  saveDriverMethod: mockSaveDriverMethod,
  removeDriverMethod: mockRemoveDriverMethod,
  setDefaultDriverMethod: mockSetDefaultDriverMethod,
  submitDriverMethodSetup: mockSubmitDriverMethodSetup,
  continueDriverMethodSetup: mockContinueDriverMethodSetup,
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  getMobileAppConfig: mockGetMobileAppConfig,
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: mockPaymentContext,
}));

import { registerAuth } from '../plugins/auth.js';
import { portalPaymentRoutes } from '../routes/portal/payments.js';
import { config as apiConfig } from '../lib/config.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const DRIVER_ID = 'drv_000000000001';
const VALID_PM_ID = '1';

const CTX = { registry: 'registry', logger: expect.anything() };

function methodRow(overrides: Partial<DriverPaymentMethod> = {}): DriverPaymentMethod {
  return {
    id: 1,
    driverId: DRIVER_ID,
    stripeCustomerId: 'cus_123',
    stripePaymentMethodId: 'pm_123',
    provider: 'stripe',
    providerCustomerId: 'cus_123',
    providerPaymentMethodId: 'pm_123',
    cardBrand: 'visa',
    cardLast4: '4242',
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalPaymentRoutes);
  await app.ready();
  return app;
}

describe('Portal payment routes - handler logic', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  function authHeaders(): { authorization: string } {
    return { authorization: `Bearer ${driverToken}` };
  }

  describe('GET /v1/portal/payment-methods', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/payment-methods' });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(mockListDriverMethods).not.toHaveBeenCalled();
    });

    it('returns empty array when no payment methods', async () => {
      mockListDriverMethods.mockResolvedValueOnce([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      expect(mockListDriverMethods).toHaveBeenCalledWith(DRIVER_ID, CTX);
    });

    it('returns payment methods without provider identifiers', async () => {
      mockListDriverMethods.mockResolvedValueOnce([
        methodRow(),
        methodRow({ id: 2, isDefault: false, cardBrand: 'mastercard', cardLast4: '5555' }),
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/payment-methods',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Array<Record<string, unknown>>>();
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: '1',
        driverId: DRIVER_ID,
        cardBrand: 'visa',
        cardLast4: '4242',
        isDefault: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(body[1]).toMatchObject({ id: '2', isDefault: false, cardLast4: '5555' });
      for (const row of body) {
        expect(row).not.toHaveProperty('stripeCustomerId');
        expect(row).not.toHaveProperty('stripePaymentMethodId');
        expect(row).not.toHaveProperty('providerCustomerId');
        expect(row).not.toHaveProperty('providerPaymentMethodId');
      }
    });
  });

  describe('POST /v1/portal/payment-methods/setup-intent', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
      });
      expect(response.statusCode).toBe(401);
    });

    it('starts a web setup and returns the Stripe fields', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'started',
        providerId: 'stripe',
        customerId: 'cus_123',
        session: {
          provider: 'stripe',
          clientSecret: 'seti_secret_test',
          customerId: 'cus_123',
          publishableKey: 'pk_test_123',
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'stripe',
        clientSecret: 'seti_secret_test',
        customerId: 'cus_123',
        publishableKey: 'pk_test_123',
        session: {
          provider: 'stripe',
          clientSecret: 'seti_secret_test',
          customerId: 'cus_123',
          publishableKey: 'pk_test_123',
        },
      });
      expect(mockStartDriverMethodSetup).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, channel: 'web' },
        CTX,
      );
    });

    it('returns the provider session and empty Stripe fields for a non-Stripe session', async () => {
      const session = {
        provider: 'adyen',
        customerId: 'drv_1',
        clientKey: 'test_CLIENTKEY',
        environment: 'test',
        countryCode: 'NL',
        currency: 'EUR',
        paymentMethodsResponse: { paymentMethods: [{ type: 'scheme' }] },
      };
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'started',
        providerId: 'adyen',
        customerId: 'drv_1',
        session,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'adyen',
        clientSecret: null,
        customerId: 'drv_1',
        publishableKey: '',
        session,
      });
    });

    it('returns 404 when driver not found', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({ status: 'driver_not_found' });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
    });

    it('returns 400 when no payment provider is configured', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({ status: 'not_configured' });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Payment provider not configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });

    it('returns 400 with a generic message when the provider setup fails', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'failed',
        reason: 'No such customer: cus_secret_detail',
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup-intent',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Payment setup failed',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
      expect(response.body).not.toContain('cus_secret_detail');
    });
  });

  describe('POST /v1/portal/payment-methods/ephemeral-key', () => {
    const url = '/portal/payment-methods/ephemeral-key?stripeVersion=2026-01-28.clover';

    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a request without stripeVersion', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/ephemeral-key',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(mockStartDriverMethodSetup).not.toHaveBeenCalled();
    });

    it('starts a native setup and returns the ephemeral key', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({
        status: 'started',
        providerId: 'stripe',
        customerId: 'cus_123',
        session: {
          provider: 'stripe',
          clientSecret: 'seti_secret_native',
          customerId: 'cus_123',
          publishableKey: 'pk_test_123',
          ephemeralKey: 'ek_test_123',
        },
      });
      const response = await app.inject({ method: 'POST', url, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'stripe',
        ephemeralKey: 'ek_test_123',
        customerId: 'cus_123',
        publishableKey: 'pk_test_123',
        setupIntentClientSecret: 'seti_secret_native',
      });
      expect(mockStartDriverMethodSetup).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, channel: 'native', nativeSdkVersion: '2026-01-28.clover' },
        CTX,
      );
    });

    it('returns 404 when driver not found', async () => {
      mockStartDriverMethodSetup.mockResolvedValueOnce({ status: 'driver_not_found' });
      const response = await app.inject({ method: 'POST', url, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
    });

    it.each([
      ['not configured', { status: 'not_configured' }],
      ['failed', { status: 'failed', reason: 'boom' }],
      [
        'started without an ephemeral key',
        {
          status: 'started',
          providerId: 'simulated',
          customerId: 'sim_cus_1',
          session: { provider: 'simulated' },
        },
      ],
    ])(
      'returns 400 PAYMENT_PROVIDER_NOT_CONFIGURED when the setup is %s',
      async (_label, outcome) => {
        mockStartDriverMethodSetup.mockResolvedValueOnce(outcome);
        const response = await app.inject({ method: 'POST', url, headers: authHeaders() });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: 'Payment provider not configured',
          code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
        });
      },
    );
  });

  describe('POST /v1/portal/payment-methods', () => {
    const payload = {
      stripePaymentMethodId: 'pm_new',
      stripeCustomerId: 'cus_123',
      cardBrand: 'amex',
      cardLast4: '0005',
    };

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        payload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 with invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: authHeaders(),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(mockSaveDriverMethod).not.toHaveBeenCalled();
    });

    it('saves the method with the driver customer and never the client card details', async () => {
      mockSaveDriverMethod.mockResolvedValueOnce({
        status: 'saved',
        method: methodRow({ id: 3, stripePaymentMethodId: 'pm_new' }),
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: authHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        id: '3',
        cardBrand: 'visa',
        cardLast4: '4242',
        isDefault: true,
      });
      expect(body).not.toHaveProperty('stripePaymentMethodId');
      expect(mockSaveDriverMethod).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, customerId: 'cus_123', methodId: 'pm_new', adoptCustomer: false },
        CTX,
      );
    });

    it.each([
      ['driver_not_found', 404, { error: 'Driver not found', code: 'DRIVER_NOT_FOUND' }],
      ['forbidden', 403, { error: 'Forbidden', code: 'FORBIDDEN' }],
      [
        'not_initialized',
        400,
        { error: 'Payment setup not initialized', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' },
      ],
      [
        'not_configured',
        400,
        { error: 'Payment provider not configured', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' },
      ],
      [
        'verify_failed',
        400,
        { error: 'Could not verify payment method', code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' },
      ],
    ])('maps the %s outcome to %i', async (status, statusCode, body) => {
      mockSaveDriverMethod.mockResolvedValueOnce(
        status === 'verify_failed' ? { status, reason: 'pm belongs to cus_other' } : { status },
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods',
        headers: authHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual(body);
    });
  });

  describe('POST /v1/portal/payment-methods/setup/submit and setup/details', () => {
    const ATTEMPT = '0b6f3c2e-6a51-4a55-9a77-2f4d3d6c1e10';

    function post(step: 'submit' | 'details', payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: `/portal/payment-methods/setup/${step}`,
        headers: authHeaders(),
        payload,
      });
    }

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/payment-methods/setup/submit',
        payload: { provider: 'simulated', attemptId: ATTEMPT, payload: {} },
      });
      expect(response.statusCode).toBe(401);
      expect(mockSubmitDriverMethodSetup).not.toHaveBeenCalled();
    });

    it('rejects a body without a UUID attemptId', async () => {
      const response = await post('submit', { provider: 'simulated', attemptId: 'x', payload: {} });
      expect(response.statusCode).toBe(400);
      expect(mockSubmitDriverMethodSetup).not.toHaveBeenCalled();
    });

    it('submits for the driver without adopting a customer and returns 201 without provider ids', async () => {
      mockSubmitDriverMethodSetup.mockResolvedValueOnce({ status: 'saved', method: methodRow() });
      const response = await post('submit', {
        provider: 'simulated',
        attemptId: ATTEMPT,
        payload: { testCard: '4242424242424242' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.status).toBe('saved');
      expect(body.method).toMatchObject({ id: '1', cardLast4: '4242', isDefault: true });
      expect(body.method).not.toHaveProperty('providerCustomerId');
      expect(body.method).not.toHaveProperty('stripePaymentMethodId');
      expect(mockSubmitDriverMethodSetup).toHaveBeenCalledWith(
        {
          driverId: DRIVER_ID,
          providerId: 'simulated',
          attemptId: ATTEMPT,
          payload: { testCard: '4242424242424242' },
          adoptCustomer: false,
        },
        CTX,
      );
    });

    it('passes the browser with a return URL built from PORTAL_URL', async () => {
      const action = { provider: 'adyen', data: { type: 'redirect' } };
      mockSubmitDriverMethodSetup.mockResolvedValueOnce({ status: 'action_required', action });
      const origin = new URL(apiConfig.PORTAL_URL).origin;
      const response = await post('submit', {
        provider: 'adyen',
        attemptId: ATTEMPT,
        payload: { paymentMethod: { type: 'scheme' }, currency: 'EUR' },
        browser: { origin, info: { language: 'en' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'action_required', action });
      const returnUrl = new URL('/payments/return', apiConfig.PORTAL_URL);
      returnUrl.searchParams.set('flow', 'method');
      returnUrl.searchParams.set('provider', 'adyen');
      returnUrl.searchParams.set('attemptId', ATTEMPT);
      expect(mockSubmitDriverMethodSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          browser: { origin, returnUrl: returnUrl.toString(), info: { language: 'en' } },
        }),
        CTX,
      );
    });

    it('refuses a browser origin other than the portal', async () => {
      const response = await post('submit', {
        provider: 'adyen',
        attemptId: ATTEMPT,
        payload: {},
        browser: { origin: 'https://evil.example' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(mockSubmitDriverMethodSetup).not.toHaveBeenCalled();
    });

    describe('from the mobile app', () => {
      const apps = { urlSchemes: ['evtivity'], androidPackageNames: ['com.evtivity.driver'] };
      const payload = { paymentMethod: { type: 'scheme' }, currency: 'EUR' };

      it.each([
        ['ios', 'evtivity://payments/adyen'],
        ['android', 'adyencheckout://com.evtivity.driver'],
        ['android', 'evtivity://payments/adyen'],
      ] as const)(
        'passes the %s channel and the SDK return URL %s',
        async (platform, returnUrl) => {
          mockGetMobileAppConfig.mockResolvedValueOnce(apps);
          const action = { provider: 'adyen', data: { type: 'redirect' } };
          mockSubmitDriverMethodSetup.mockResolvedValueOnce({ status: 'action_required', action });
          const response = await post('submit', {
            provider: 'adyen',
            attemptId: ATTEMPT,
            payload,
            browser: { platform, returnUrl, info: { userAgent: 'app' } },
          });
          expect(response.statusCode).toBe(200);
          expect(mockSubmitDriverMethodSetup).toHaveBeenCalledWith(
            expect.objectContaining({
              browser: { channel: platform, returnUrl, info: { userAgent: 'app' } },
            }),
            CTX,
          );
        },
      );

      it.each([
        ['ios', 'adyencheckout://com.evtivity.driver'],
        ['android', 'adyencheckout://com.other.app'],
        ['android', 'adyencheckout://com.evtivity.driver/path'],
        ['android', 'adyencheckout://user@com.evtivity.driver'],
        ['ios', 'otherapp://payments/adyen'],
        ['ios', 'https://portal.example/payments/return'],
        ['ios', 'not a url'],
      ] as const)('refuses the %s return URL %s', async (platform, returnUrl) => {
        mockGetMobileAppConfig.mockResolvedValueOnce(apps);
        const response = await post('submit', {
          provider: 'adyen',
          attemptId: ATTEMPT,
          payload,
          browser: { platform, returnUrl },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('VALIDATION_ERROR');
        expect(mockSubmitDriverMethodSetup).not.toHaveBeenCalled();
      });

      it('refuses every app return URL when no app build is configured', async () => {
        mockGetMobileAppConfig.mockResolvedValueOnce({ urlSchemes: [], androidPackageNames: [] });
        const response = await post('submit', {
          provider: 'adyen',
          attemptId: ATTEMPT,
          payload,
          browser: { platform: 'ios', returnUrl: 'evtivity://payments/adyen' },
        });
        expect(response.statusCode).toBe(400);
        expect(mockSubmitDriverMethodSetup).not.toHaveBeenCalled();
      });
    });

    it('returns 200 with the action', async () => {
      const action = { provider: 'simulated', data: { challenge: 'method_setup', methodId: 'm' } };
      mockSubmitDriverMethodSetup.mockResolvedValueOnce({ status: 'action_required', action });
      const response = await post('submit', {
        provider: 'simulated',
        attemptId: ATTEMPT,
        payload: { testCard: '4000002500003155' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'action_required', action });
    });

    it('continues with the details', async () => {
      mockContinueDriverMethodSetup.mockResolvedValueOnce({ status: 'saved', method: methodRow() });
      const details = { methodId: 'm', outcome: 'approve' };
      const response = await post('details', {
        provider: 'simulated',
        attemptId: ATTEMPT,
        details,
      });
      expect(response.statusCode).toBe(201);
      expect(mockContinueDriverMethodSetup).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, providerId: 'simulated', attemptId: ATTEMPT, details },
        CTX,
      );
    });

    it.each([
      [{ status: 'refused', reason: 'card_declined' }, 400, 'PAYMENT_FAILED'],
      [{ status: 'invalid', reason: 'Unknown test card' }, 400, 'VALIDATION_ERROR'],
      [{ status: 'not_configured' }, 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED'],
      [{ status: 'provider_mismatch' }, 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED'],
      [{ status: 'not_initialized' }, 400, 'PAYMENT_PROVIDER_NOT_CONFIGURED'],
      [{ status: 'forbidden' }, 403, 'FORBIDDEN'],
      [{ status: 'driver_not_found' }, 404, 'DRIVER_NOT_FOUND'],
    ])('maps %j to %i %s', async (outcome, status, code) => {
      mockSubmitDriverMethodSetup.mockResolvedValueOnce(outcome);
      const response = await post('submit', {
        provider: 'simulated',
        attemptId: ATTEMPT,
        payload: {},
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code);
      if (outcome.status === 'refused') {
        expect(response.json().details).toEqual({ reason: 'card_declined' });
      }
    });
  });

  describe('DELETE /v1/portal/payment-methods/:pmId', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when payment method not found', async () => {
      mockRemoveDriverMethod.mockResolvedValueOnce({ status: 'not_found' });
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'Payment method not found',
        code: 'PAYMENT_METHOD_NOT_FOUND',
      });
    });

    it('returns 409 when the method holds an active session payment', async () => {
      mockRemoveDriverMethod.mockResolvedValueOnce({ status: 'in_use' });
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Payment method is in use by an active charging session',
        code: 'PAYMENT_METHOD_IN_USE',
      });
    });

    it('removes the method, blocking removal while it is in use', async () => {
      mockRemoveDriverMethod.mockResolvedValueOnce({ status: 'removed' });
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/payment-methods/${VALID_PM_ID}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(mockRemoveDriverMethod).toHaveBeenCalledWith(
        { driverId: DRIVER_ID, methodRowId: 1, blockWhenInUse: true },
        CTX,
      );
    });

    it('rejects a non-numeric method id', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/portal/payment-methods/abc',
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(mockRemoveDriverMethod).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /v1/portal/payment-methods/:pmId/default', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when payment method not found', async () => {
      mockSetDefaultDriverMethod.mockResolvedValueOnce(null);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'Payment method not found',
        code: 'PAYMENT_METHOD_NOT_FOUND',
      });
    });

    it('sets payment method as default', async () => {
      mockSetDefaultDriverMethod.mockResolvedValueOnce(methodRow({ isDefault: true }));
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/payment-methods/${VALID_PM_ID}/default`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ id: '1', isDefault: true });
      expect(body).not.toHaveProperty('stripeCustomerId');
      expect(body).not.toHaveProperty('providerCustomerId');
      expect(mockSetDefaultDriverMethod).toHaveBeenCalledWith(DRIVER_ID, 1);
    });
  });
});
