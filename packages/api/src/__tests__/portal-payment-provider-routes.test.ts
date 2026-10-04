// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { mockActivePaymentProvider } = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  activePaymentProvider: mockActivePaymentProvider,
}));

import { registerAuth } from '../plugins/auth.js';
import { portalPaymentProviderRoutes } from '../routes/portal/payment-provider.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalPaymentProviderRoutes);
  await app.ready();
  return app;
}

function provider(clientConfig: Record<string, unknown>, nativeMobileSheet: boolean): unknown {
  return {
    id: clientConfig['provider'],
    clientConfig: () => clientConfig,
    capabilities: {
      savedMethods: true,
      clientActions: true,
      nativeMobileSheet,
      manualCapture: true,
      marketplaceSplit: 'destination_charge',
    },
  };
}

describe('GET /portal/payment-provider', () => {
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
    mockActivePaymentProvider.mockReset();
  });

  function get(token: string | null) {
    return app.inject({
      method: 'GET',
      url: '/portal/payment-provider',
      ...(token != null ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  it('returns 401 without a token', async () => {
    expect((await get(null)).statusCode).toBe(401);
  });

  it('returns 403 with an operator token', async () => {
    const operatorToken = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
    expect((await get(operatorToken)).statusCode).toBe(403);
    expect(mockActivePaymentProvider).not.toHaveBeenCalled();
  });

  it('reports payments off when no provider is active', async () => {
    mockActivePaymentProvider.mockResolvedValue(null);
    const response = await get(driverToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paymentEnabled: false, provider: null, capabilities: null });
  });

  it('returns the Stripe client config and the client capabilities', async () => {
    mockActivePaymentProvider.mockResolvedValue(
      provider({ provider: 'stripe', publishableKey: 'pk_test_1' }, true),
    );
    const response = await get(driverToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      paymentEnabled: true,
      provider: { provider: 'stripe', publishableKey: 'pk_test_1' },
      capabilities: { savedMethods: true, clientActions: true, nativeMobileSheet: true },
    });
  });

  it('returns the simulated client config with its test cards', async () => {
    const config = {
      provider: 'simulated',
      resultMode: 'sync',
      testCards: [{ number: '4242424242424242', label: 'Success', scenario: 'success' }],
    };
    mockActivePaymentProvider.mockResolvedValue(provider(config, false));
    const response = await get(driverToken);
    expect(response.json()).toMatchObject({
      paymentEnabled: true,
      provider: config,
      capabilities: { nativeMobileSheet: false },
    });
  });
});
