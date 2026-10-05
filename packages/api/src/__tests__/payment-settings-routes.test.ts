// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PaymentProviderUpgradePendingError } from '@evtivity/payments';
import type { ProviderCatalogEntry } from '@evtivity/payments';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

const {
  granted,
  mockDescribePaymentProviders,
  mockGetPlatformFeePercent,
  mockRegistrySettings,
  mockWritePaymentSettings,
} = vi.hoisted(() => ({
  granted: new Set<string>(),
  mockDescribePaymentProviders: vi.fn(),
  mockGetPlatformFeePercent: vi.fn(),
  mockRegistrySettings: vi.fn(),
  mockWritePaymentSettings: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getPlatformFeePercent: mockGetPlatformFeePercent };
});

vi.mock('@evtivity/payments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, describePaymentProviders: mockDescribePaymentProviders };
});

// The RBAC middleware is replaced with a permission check against `granted`.
vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (permission: string) =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      if (!granted.has(permission)) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  paymentRegistry: { settings: mockRegistrySettings },
}));

vi.mock('../lib/payment-settings-writes.js', () => ({
  writePaymentSettings: mockWritePaymentSettings,
}));

const WATCH_STORE = { get: vi.fn(), set: vi.fn() };
vi.mock('../lib/provider-switch.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, providerSwitchStore: () => WATCH_STORE };
});

import { registerAuth } from '../plugins/auth.js';
import { paymentSettingsRoutes } from '../routes/payment-settings.js';

const CAPABILITIES: ProviderCatalogEntry['capabilities'] = {
  savedMethods: true,
  clientActions: true,
  nativeMobileSheet: false,
  marketplaceSplit: 'none',
};

const CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'stripe',
    configured: true,
    selectable: true,
    reason: null,
    upgradePending: null,
    capabilities: { ...CAPABILITIES, marketplaceSplit: 'destination_charge' },
  },
  {
    id: 'adyen',
    configured: true,
    selectable: false,
    reason: 'requires_upgrade',
    upgradePending: null,
    capabilities: CAPABILITIES,
  },
];

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(paymentSettingsRoutes);
  await app.ready();
  return app;
}

describe('Payment settings routes', () => {
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
    granted.clear();
    granted.add('payments:read');
    granted.add('payments:write');
    mockDescribePaymentProviders.mockResolvedValue(CATALOG);
    mockGetPlatformFeePercent.mockResolvedValue(2.5);
    mockRegistrySettings.mockResolvedValue({
      provider: 'stripe',
      preAuthAmountCents: 7500,
      simulated: { resultMode: 'sync', asyncDelaySeconds: 5, randomFailureRate: 0.1 },
    });
    mockWritePaymentSettings.mockResolvedValue(undefined);
  });

  function call(method: 'GET' | 'PUT', payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url: '/settings/payments',
      headers: { authorization: 'Bearer ' + token },
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/settings/payments' });
    expect(response.statusCode).toBe(401);
  });

  describe('GET /settings/payments', () => {
    it('returns the provider, amounts, simulated settings and the provider catalog', async () => {
      const response = await call('GET');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: 'stripe',
        preAuthAmountCents: 7500,
        platformFeePercent: 2.5,
        simulated: { resultMode: 'sync', asyncDelaySeconds: 5, randomFailureRate: 0.1 },
        providers: CATALOG,
      });
      expect(mockGetPlatformFeePercent).toHaveBeenCalledWith(null);
      expect(mockDescribePaymentProviders).toHaveBeenCalledWith(expect.anything(), WATCH_STORE);
    });

    it('returns 403 without payments:read', async () => {
      granted.delete('payments:read');
      const response = await call('GET');
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PUT /settings/payments', () => {
    it('selects a configured, selectable provider through writePaymentSettings', async () => {
      const response = await call('PUT', { provider: 'stripe' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'payments.provider', value: 'stripe' },
      ]);
    });

    it('turns payments off with none without reading the catalog', async () => {
      const response = await call('PUT', { provider: 'none' });
      expect(response.statusCode).toBe(200);
      expect(mockDescribePaymentProviders).not.toHaveBeenCalled();
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'payments.provider', value: 'none' },
      ]);
    });

    it('selects configured Adyen through writePaymentSettings when the guard allows it', async () => {
      mockDescribePaymentProviders.mockResolvedValue([
        { ...CATALOG[1], selectable: true, reason: null },
      ]);
      const response = await call('PUT', { provider: 'adyen' });
      expect(response.statusCode).toBe(200);
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'payments.provider', value: 'adyen' },
      ]);
    });

    it('answers 409 with the guard details while old processes block Adyen', async () => {
      const details = {
        legacyConnections: 2,
        hosts: ['10.0.0.7'],
        lastLegacySeenAt: '2026-10-04T11:59:00.000Z',
        watchCheckedAt: '2026-10-04T11:59:30.000Z',
      };
      mockDescribePaymentProviders.mockResolvedValue([{ ...CATALOG[1], upgradePending: details }]);
      mockWritePaymentSettings.mockRejectedValue(
        new PaymentProviderUpgradePendingError('adyen', details),
      );
      const response = await call('PUT', { provider: 'adyen' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error:
          'A process older than v0.1.38 is still connected. Finish the upgrade, then select Adyen.',
        code: 'PAYMENT_PROVIDER_UPGRADE_PENDING',
        details,
      });
      // writePaymentSettings runs the guard again at write time.
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'payments.provider', value: 'adyen' },
      ]);
    });

    it('passes other write errors on as 500', async () => {
      mockWritePaymentSettings.mockRejectedValue(new Error('db down'));
      const response = await call('PUT', { provider: 'stripe' });
      expect(response.statusCode).toBe(500);
    });

    it('refuses a provider without credentials', async () => {
      mockDescribePaymentProviders.mockResolvedValue([
        { ...CATALOG[0], configured: false, selectable: false, reason: 'not_configured' },
      ]);
      const response = await call('PUT', { provider: 'stripe' });
      expect(response.statusCode).toBe(400);
      expect(response.json().details).toEqual({
        provider: 'Payment provider stripe is not configured',
      });
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('refuses the simulated provider where it is not registered', async () => {
      const response = await call('PUT', { provider: 'simulated' });
      expect(response.statusCode).toBe(400);
      expect(response.json().details).toEqual({
        provider: 'Payment provider simulated is not available',
      });
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('refuses an unknown provider id', async () => {
      const response = await call('PUT', { provider: 'bogus' });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('writes the amounts to the payments.* keys only', async () => {
      const response = await call('PUT', { preAuthAmountCents: 2500, platformFeePercent: 7.5 });
      expect(response.statusCode).toBe(200);
      expect(mockDescribePaymentProviders).not.toHaveBeenCalled();
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'payments.preAuthAmountCents', value: 2500 },
        { key: 'payments.platformFeePercent', value: 7.5 },
      ]);
    });

    it('writes the given simulated settings only', async () => {
      const response = await call('PUT', {
        simulated: { resultMode: 'sync', randomFailureRate: 0 },
      });
      expect(response.statusCode).toBe(200);
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'simulated.resultMode', value: 'sync' },
        { key: 'simulated.randomFailureRate', value: 0 },
      ]);
    });

    it('accepts the async result mode (P10 Part A)', async () => {
      const response = await call('PUT', { simulated: { resultMode: 'async' } });
      expect(response.statusCode).toBe(200);
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), [
        { key: 'simulated.resultMode', value: 'async' },
      ]);
    });

    it.each([
      [{ preAuthAmountCents: 0 }],
      [{ preAuthAmountCents: 1_000_001 }],
      [{ preAuthAmountCents: 10.5 }],
      [{ platformFeePercent: -1 }],
      [{ platformFeePercent: 101 }],
      [{ simulated: { resultMode: 'queued' } }],
      [{ simulated: { asyncDelaySeconds: 3601 } }],
      [{ simulated: { randomFailureRate: 1.5 } }],
    ])('refuses an out-of-range value %j', async (payload) => {
      const response = await call('PUT', payload);
      expect(response.statusCode).toBe(400);
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });

    it('writes nothing for an empty body', async () => {
      const response = await call('PUT', {});
      expect(response.statusCode).toBe(200);
      expect(mockWritePaymentSettings).toHaveBeenCalledWith(expect.anything(), []);
    });

    it('returns 403 without payments:write', async () => {
      granted.delete('payments:write');
      const response = await call('PUT', { provider: 'stripe' });
      expect(response.statusCode).toBe(403);
      expect(mockWritePaymentSettings).not.toHaveBeenCalled();
    });
  });
});
