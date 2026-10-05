// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Mock } from 'vitest';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const WEBHOOK_URL = 'https://csms.example.com/v1/webhooks/payments/adyen';

const {
  mockSettingsRows,
  mockGetPaymentProvider,
  mockWritePaymentSettings,
  mockRequestHasPermission,
} = vi.hoisted(() => ({
  mockSettingsRows: { rows: [] as Array<{ key: string; value: unknown }> },
  mockGetPaymentProvider: vi.fn(),
  mockWritePaymentSettings: vi.fn(),
  mockRequestHasPermission: vi.fn(async (_request: unknown, _permission: string) => true),
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(mockSettingsRows.rows),
  };
  return { ...actual, db: { select: vi.fn(() => chain) } };
});

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

vi.mock('../lib/payments.js', () => ({
  paymentRegistry: { getPaymentProvider: mockGetPaymentProvider },
}));

vi.mock('../lib/payment-settings-writes.js', () => ({
  writePaymentSettings: mockWritePaymentSettings,
}));

import { decryptString, encryptString } from '@evtivity/lib';
import {
  AdyenApiError,
  AdyenPaymentProvider,
  PaymentProviderNotConfiguredError,
  PaymentProviderPermissionError,
  WebhookExistsError,
} from '@evtivity/payments';
import { registerAuth } from '../plugins/auth.js';
import { config } from '../lib/config.js';
import { adyenSettingsRoutes } from '../routes/adyen-settings.js';

const ENCRYPTION_KEY = config.SETTINGS_ENCRYPTION_KEY;

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;

interface FakeProvider {
  testConnection: AsyncMock;
  getCredentialInfo: AsyncMock;
  listWebhooks: AsyncMock;
  registerWebhook: AsyncMock;
  sendTestWebhook: AsyncMock;
}

/** An AdyenPaymentProvider instance (the route checks the class) with mocked methods. */
function fakeProvider(): FakeProvider {
  const provider = Object.create(AdyenPaymentProvider.prototype) as FakeProvider;
  provider.testConnection = vi.fn().mockResolvedValue(undefined);
  provider.getCredentialInfo = vi.fn().mockResolvedValue({
    roles: ['Checkout webservice role', 'Management API - Webhooks read and write'],
    allowedOrigins: [],
  });
  provider.listWebhooks = vi.fn().mockResolvedValue([]);
  provider.registerWebhook = vi.fn();
  provider.sendTestWebhook = vi
    .fn()
    .mockResolvedValue({ status: 'success', responseCode: '200', output: '[accepted]' });
  mockGetPaymentProvider.mockResolvedValue(provider);
  return provider;
}

function endpoint(active: boolean): Record<string, unknown> {
  return {
    id: 'WBHK1',
    url: WEBHOOK_URL,
    scope: 'standard',
    enabledEvents: ['AUTHORISATION'],
    apiVersion: null,
    active,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(adyenSettingsRoutes);
  await app.ready();
  return app;
}

describe('Adyen settings routes', () => {
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
    vi.clearAllMocks();
    mockSettingsRows.rows = [];
    mockWritePaymentSettings.mockResolvedValue(undefined);
  });

  function call(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: 'Bearer ' + token },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  /** The pairs passed to writePaymentSettings, as a key -> value map. */
  function written(): Map<string, unknown> {
    const pairs = mockWritePaymentSettings.mock.calls[0]?.[1] as
      | Array<{ key: string; value: unknown }>
      | undefined;
    return new Map((pairs ?? []).map((p) => [p.key, p.value]));
  }

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/settings/adyen' });
    expect(response.statusCode).toBe(401);
  });

  describe('GET /settings/adyen', () => {
    it('returns plain settings and the secrets decrypted to a caller with settings.system:read', async () => {
      mockSettingsRows.rows = [
        { key: 'adyen.apiKeyEnc', value: encryptString('AQE_key', ENCRYPTION_KEY) },
        { key: 'adyen.merchantAccount', value: 'EVtivityECOM' },
        { key: 'adyen.clientKey', value: 'test_CLIENT' },
        { key: 'adyen.environment', value: 'live' },
        { key: 'adyen.liveUrlPrefix', value: '1797a841fbb37ca7-AdyenDemo' },
        { key: 'adyen.liveRegion', value: 'us' },
        { key: 'adyen.hmacKeyEnc', value: encryptString('ABCDEF0123', ENCRYPTION_KEY) },
        { key: 'adyen.hmacKeyPreviousEnc', value: '' },
        { key: 'adyen.webhookUsername', value: 'evtivity-abc' },
        { key: 'adyen.webhookPasswordEnc', value: encryptString('pw-1', ENCRYPTION_KEY) },
        { key: 'adyen.authorisationAdjustment', value: true },
      ];
      const response = await call('GET', '/settings/adyen');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        merchantAccount: 'EVtivityECOM',
        environment: 'live',
        liveUrlPrefix: '1797a841fbb37ca7-AdyenDemo',
        liveRegion: 'us',
        clientKey: 'test_CLIENT',
        webhookUsername: 'evtivity-abc',
        authorisationAdjustment: true,
        apiKey: 'AQE_key',
        apiKeyConfigured: true,
        hmacKey: 'ABCDEF0123',
        hmacKeyConfigured: true,
        hmacKeyPreviousConfigured: false,
        webhookPassword: 'pw-1',
        webhookPasswordConfigured: true,
        webhookUrlPath: '/v1/webhooks/payments/adyen',
      });
      expect(mockRequestHasPermission).toHaveBeenCalledWith(
        expect.anything(),
        'settings.system:read',
      );
    });

    it('returns only whether each secret is stored without settings.system:read', async () => {
      // Also the answer for an API key whose scope leaves settings.system:read out:
      // requestHasPermission applies the key scope like authorize().
      mockRequestHasPermission.mockResolvedValueOnce(false);
      const apiKeyCipher = encryptString('AQE_key', ENCRYPTION_KEY);
      mockSettingsRows.rows = [
        { key: 'adyen.apiKeyEnc', value: apiKeyCipher },
        { key: 'adyen.merchantAccount', value: 'EVtivityECOM' },
        { key: 'adyen.hmacKeyEnc', value: encryptString('ABCDEF0123', ENCRYPTION_KEY) },
        { key: 'adyen.hmacKeyPreviousEnc', value: encryptString('0123', ENCRYPTION_KEY) },
        { key: 'adyen.webhookPasswordEnc', value: '' },
      ];
      const response = await call('GET', '/settings/adyen');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        merchantAccount: 'EVtivityECOM',
        apiKey: null,
        apiKeyConfigured: true,
        hmacKey: null,
        hmacKeyConfigured: true,
        hmacKeyPreviousConfigured: true,
        webhookPassword: null,
        webhookPasswordConfigured: false,
      });
      expect(response.body).not.toContain('AQE_key');
      expect(response.body).not.toContain('ABCDEF0123');
      expect(response.body).not.toContain(apiKeyCipher);
    });

    it('returns the defaults when nothing is stored', async () => {
      const response = await call('GET', '/settings/adyen');
      expect(response.json()).toMatchObject({
        merchantAccount: null,
        environment: 'test',
        liveRegion: 'eu',
        apiKey: null,
        apiKeyConfigured: false,
        hmacKey: null,
        hmacKeyConfigured: false,
        webhookPassword: null,
        webhookPasswordConfigured: false,
        authorisationAdjustment: false,
      });
    });
  });

  describe('PUT /settings/adyen', () => {
    it('encrypts secrets, stores plain fields, and writes through writePaymentSettings', async () => {
      const response = await call('PUT', '/settings/adyen', {
        apiKey: 'AQE_key',
        merchantAccount: 'EVtivityECOM',
        clientKey: 'test_CLIENT',
        environment: 'test',
        liveRegion: 'eu',
        hmacKey: 'ABCDEF0123',
        webhookUsername: 'user',
        webhookPassword: 'pw',
        authorisationAdjustment: false,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      const pairs = written();
      expect(decryptString(pairs.get('adyen.apiKeyEnc') as string, ENCRYPTION_KEY)).toBe('AQE_key');
      expect(decryptString(pairs.get('adyen.hmacKeyEnc') as string, ENCRYPTION_KEY)).toBe(
        'ABCDEF0123',
      );
      expect(decryptString(pairs.get('adyen.webhookPasswordEnc') as string, ENCRYPTION_KEY)).toBe(
        'pw',
      );
      expect(pairs.get('adyen.merchantAccount')).toBe('EVtivityECOM');
      expect(pairs.get('adyen.clientKey')).toBe('test_CLIENT');
      expect(pairs.get('adyen.webhookUsername')).toBe('user');
      expect(pairs.get('adyen.authorisationAdjustment')).toBe(false);
      expect(pairs.has('payments.provider')).toBe(false);
    });

    it('writes only the given fields, and an empty secret clears it', async () => {
      await call('PUT', '/settings/adyen', { apiKey: '' });
      expect([...written().entries()]).toEqual([['adyen.apiKeyEnc', '']]);
    });

    it('refuses live without a live URL prefix', async () => {
      const response = await call('PUT', '/settings/adyen', { environment: 'live' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { liveUrlPrefix: expect.any(String) },
      });
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('accepts live with a stored prefix, and refuses clearing the prefix while live', async () => {
      mockSettingsRows.rows = [
        { key: 'adyen.environment', value: 'live' },
        { key: 'adyen.liveUrlPrefix', value: '1797a841fbb37ca7-AdyenDemo' },
      ];
      expect((await call('PUT', '/settings/adyen', { environment: 'live' })).statusCode).toBe(200);
      expect((await call('PUT', '/settings/adyen', { liveUrlPrefix: '' })).statusCode).toBe(400);
    });

    it.each([
      [{ environment: 'staging' }],
      [{ liveUrlPrefix: 'not a prefix' }],
      [{ liveRegion: 'mars' }],
      [{ merchantAccount: '' }],
      [{ hmacKey: 'not-hex' }],
    ])('refuses %j', async (payload) => {
      const response = await call('PUT', '/settings/adyen', payload);
      expect(response.statusCode).toBe(400);
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });
  });

  describe('POST /settings/adyen/test', () => {
    it('tests the connection and reports the webhook role', async () => {
      const provider = fakeProvider();
      const response = await call('POST', '/settings/adyen/test');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        roles: ['Checkout webservice role', 'Management API - Webhooks read and write'],
        webhookRoleGranted: true,
      });
      expect(mockGetPaymentProvider).toHaveBeenCalledWith('adyen');
      expect(provider.testConnection).toHaveBeenCalledTimes(1);
    });

    it('reports no roles when /me cannot be read', async () => {
      const provider = fakeProvider();
      provider.getCredentialInfo.mockRejectedValue(
        new PaymentProviderPermissionError('adyen', 'Management API'),
      );
      const response = await call('POST', '/settings/adyen/test');
      expect(response.json()).toEqual({ success: true, roles: [], webhookRoleGranted: false });
    });

    it('answers 400 PAYMENT_PROVIDER_NOT_CONFIGURED without credentials', async () => {
      mockGetPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
      const response = await call('POST', '/settings/adyen/test');
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Adyen is not configured',
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    });

    it('answers 400 PAYMENT_PROVIDER_CONNECTION_FAILED when Checkout refuses', async () => {
      const provider = fakeProvider();
      provider.testConnection.mockRejectedValue(
        new AdyenApiError(401, { message: 'HTTP Status Response - Unauthorized' }),
      );
      const response = await call('POST', '/settings/adyen/test');
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'HTTP Status Response - Unauthorized',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
    });
  });

  describe('GET /settings/adyen/webhook', () => {
    it('lists the EVtivity webhooks and the stored flags', async () => {
      const provider = fakeProvider();
      provider.listWebhooks.mockResolvedValue([endpoint(true)]);
      mockSettingsRows.rows = [{ key: 'adyen.hmacKeyEnc', value: 'cipher' }];
      const response = await call('GET', '/settings/adyen/webhook');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        endpoints: [endpoint(true)],
        otherEndpoints: [],
        hmacKeyConfigured: true,
        webhookPasswordConfigured: false,
      });
      expect(body.events).toContain('EXPIRE');
    });

    it("with url, lists other deployments' EVtivity webhooks apart", async () => {
      const provider = fakeProvider();
      const other = {
        ...endpoint(true),
        id: 'WBHK_OTHER',
        url: 'https://dev.example.com/v1/webhooks/payments/adyen',
      };
      provider.listWebhooks.mockResolvedValue([other, endpoint(true)]);
      const response = await call(
        'GET',
        `/settings/adyen/webhook?url=${encodeURIComponent(WEBHOOK_URL)}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        endpoints: [endpoint(true)],
        otherEndpoints: [other],
      });
    });

    it('accepts an http url query (a local or plain-HTTP deployment) for the split', async () => {
      const provider = fakeProvider();
      const local = { ...endpoint(true), url: 'http://localhost:7100/v1/webhooks/payments/adyen' };
      provider.listWebhooks.mockResolvedValue([local, endpoint(true)]);
      const response = await call(
        'GET',
        `/settings/adyen/webhook?url=${encodeURIComponent('http://localhost:7100/v1/webhooks/payments/adyen')}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        endpoints: [local],
        otherEndpoints: [endpoint(true)],
      });
    });

    it('answers 400 VALIDATION_ERROR for an invalid url query', async () => {
      const provider = fakeProvider();
      const response = await call(
        'GET',
        `/settings/adyen/webhook?url=${encodeURIComponent('https://csms.example.com/v1/webhooks/payments/stripe')}`,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(provider.listWebhooks).not.toHaveBeenCalled();
    });

    it('answers 400 PAYMENT_PROVIDER_PERMISSION_MISSING for a credential without the role', async () => {
      const provider = fakeProvider();
      provider.listWebhooks.mockRejectedValue(
        new PaymentProviderPermissionError('adyen', 'Management API - Webhooks read and write'),
      );
      const response = await call('GET', '/settings/adyen/webhook');
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'PAYMENT_PROVIDER_PERMISSION_MISSING',
        permission: 'Management API - Webhooks read and write',
      });
    });
  });

  describe('POST /settings/adyen/webhook', () => {
    function registration(activate = vi.fn().mockResolvedValue(undefined)) {
      return {
        endpoints: [endpoint(false)],
        settings: [
          { key: 'adyen.webhookUsername', value: 'evtivity-abc', secret: false },
          { key: 'adyen.webhookPasswordEnc', value: 'plain-password', secret: true },
          { key: 'adyen.hmacKeyEnc', value: 'ABCDEF', secret: true },
          { key: 'adyen.hmacKeyPreviousEnc', value: '', secret: true },
        ],
        activate,
      };
    }

    it('registers, stores encrypted credentials, then activates and sends a test event', async () => {
      const provider = fakeProvider();
      const order: string[] = [];
      const activate = vi.fn(() => {
        order.push('activate');
        return Promise.resolve();
      });
      mockWritePaymentSettings.mockImplementation(() => {
        order.push('store');
        return Promise.resolve();
      });
      provider.sendTestWebhook.mockImplementation(() => {
        order.push('test');
        return Promise.resolve({ status: 'success', responseCode: '200', output: '[accepted]' });
      });
      provider.registerWebhook.mockResolvedValue(registration(activate));

      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        endpoints: [endpoint(true)],
        test: { status: 'success', responseCode: '200' },
      });
      expect(provider.registerWebhook).toHaveBeenCalledWith({ url: WEBHOOK_URL, replace: false });
      expect(order).toEqual(['store', 'activate', 'test']);
      expect(provider.sendTestWebhook).toHaveBeenCalledWith('WBHK1');

      const pairs = written();
      expect(pairs.get('adyen.webhookUsername')).toBe('evtivity-abc');
      expect(pairs.get('adyen.webhookPasswordEnc')).not.toBe('plain-password');
      expect(decryptString(pairs.get('adyen.webhookPasswordEnc') as string, ENCRYPTION_KEY)).toBe(
        'plain-password',
      );
      expect(decryptString(pairs.get('adyen.hmacKeyEnc') as string, ENCRYPTION_KEY)).toBe('ABCDEF');
      expect(pairs.get('adyen.hmacKeyPreviousEnc')).toBe('');
      expect(response.body).not.toContain('plain-password');
      expect(response.body).not.toContain('ABCDEF');
    });

    it('passes replace through', async () => {
      const provider = fakeProvider();
      provider.registerWebhook.mockResolvedValue(registration());
      await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL, replace: true });
      expect(provider.registerWebhook).toHaveBeenCalledWith({ url: WEBHOOK_URL, replace: true });
    });

    it('does not activate when storing the credentials fails', async () => {
      const provider = fakeProvider();
      const activate = vi.fn();
      provider.registerWebhook.mockResolvedValue(registration(activate));
      mockWritePaymentSettings.mockRejectedValue(new Error('db down'));
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(500);
      expect(activate).not.toHaveBeenCalled();
      expect(provider.sendTestWebhook).not.toHaveBeenCalled();
    });

    it('still succeeds when the test delivery cannot be requested', async () => {
      const provider = fakeProvider();
      provider.registerWebhook.mockResolvedValue(registration());
      provider.sendTestWebhook.mockRejectedValue(new AdyenApiError(500, {}));
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(200);
      expect(response.json().test).toEqual({ status: 'failed', responseCode: null });
    });

    it('answers 400 VALIDATION_ERROR for a URL that is not https or has another path', async () => {
      const provider = fakeProvider();
      for (const url of [
        'http://csms.example.com/v1/webhooks/payments/adyen',
        'https://csms.example.com/v1/webhooks/payments/stripe',
      ]) {
        const response = await call('POST', '/settings/adyen/webhook', { url });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: 'VALIDATION_ERROR',
          details: { url: expect.any(String) },
        });
      }
      expect(provider.registerWebhook).not.toHaveBeenCalled();
    });

    it('answers 409 PAYMENT_WEBHOOK_EXISTS with the existing endpoints', async () => {
      const provider = fakeProvider();
      provider.registerWebhook.mockRejectedValue(
        new WebhookExistsError(
          'adyen',
          [endpoint(true) as never],
          [{ ...endpoint(false), id: 'WBHK_OTHER' } as never],
        ),
      );
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'PAYMENT_WEBHOOK_EXISTS',
        endpoints: [endpoint(true)],
        otherEndpoints: [{ ...endpoint(false), id: 'WBHK_OTHER' }],
      });
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('answers 400 PAYMENT_PROVIDER_PERMISSION_MISSING', async () => {
      const provider = fakeProvider();
      provider.registerWebhook.mockRejectedValue(
        new PaymentProviderPermissionError('adyen', 'Management API - Webhooks read and write'),
      );
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_PROVIDER_PERMISSION_MISSING');
    });

    it('answers 400 PAYMENT_PROVIDER_CONNECTION_FAILED when Adyen refuses the URL', async () => {
      const provider = fakeProvider();
      provider.registerWebhook.mockRejectedValue(
        new AdyenApiError(422, { title: 'Invalid webhook information provided.' }),
      );
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Invalid webhook information provided.',
        code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
      });
    });

    it('answers 400 PAYMENT_PROVIDER_NOT_CONFIGURED without credentials', async () => {
      mockGetPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('adyen'));
      const response = await call('POST', '/settings/adyen/webhook', { url: WEBHOOK_URL });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    });
  });
});
