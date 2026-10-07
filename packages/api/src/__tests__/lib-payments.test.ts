// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { CreatePaymentRegistryOptions, SimulatedWebhookDelivery } from '@evtivity/payments';
import type { PubSubClient } from '@evtivity/lib';

const registryOptions = vi.hoisted(() => ({ value: null as CreatePaymentRegistryOptions | null }));
const mockResolveActiveProvider = vi.hoisted(() => vi.fn());
vi.mock('@evtivity/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/payments')>();
  return {
    ...actual,
    createPaymentRegistry: vi.fn((options: CreatePaymentRegistryOptions) => {
      registryOptions.value = options;
      return {};
    }),
    resolveActiveProvider: mockResolveActiveProvider,
  };
});
vi.stubEnv('API_PORT', '3001');
vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'k');

const { activePaymentProvider, paymentRegistry } = await import('../lib/payments.js');
const { setPubSub } = await import('@evtivity/lib/pubsub-instance');

const delivery: SimulatedWebhookDelivery = {
  rawBody: '{"events":[]}',
  headers: { 'x-simulated-signature': 'f00d' },
  delaySeconds: 30,
};

describe('API payment registry: simulated events', () => {
  it('passes a sink and a logger to the simulated provider', () => {
    expect(registryOptions.value?.simulated?.events).toBeDefined();
    expect(registryOptions.value?.simulated?.logger).toBeDefined();
  });

  it('publishes on the payment webhook channel through the process pub/sub client', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    setPubSub({ publish } as unknown as PubSubClient);
    await registryOptions.value!.simulated!.events!.deliver(delivery);
    expect(publish).toHaveBeenCalledWith(
      'payment_webhook_deliveries',
      JSON.stringify({ provider: 'simulated', ...delivery }),
    );
  });
});

describe('activePaymentProvider', () => {
  it('resolves through the shared resolver with this process registry and the caller logger', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const provider = { id: 'stripe' };
    mockResolveActiveProvider.mockResolvedValueOnce(provider);
    await expect(activePaymentProvider(logger)).resolves.toBe(provider);
    expect(mockResolveActiveProvider).toHaveBeenCalledWith({ registry: paymentRegistry, logger });
  });
});
