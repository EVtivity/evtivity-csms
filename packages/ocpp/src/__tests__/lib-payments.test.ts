// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { CreatePaymentRegistryOptions, SimulatedWebhookDelivery } from '@evtivity/payments';

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
vi.stubEnv('OCPP_PORT', '8080');
vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'k');

const { activePaymentProvider, paymentRegistry, setPaymentPubSub } =
  await import('../lib/payments.js');

const delivery: SimulatedWebhookDelivery = {
  rawBody: '{"events":[]}',
  headers: { 'x-simulated-signature': 'f00d' },
  delaySeconds: 30,
};

describe('OCPP payment registry: simulated events', () => {
  it('passes a sink and a logger to the simulated provider', () => {
    expect(registryOptions.value?.simulated?.events).toBeDefined();
    expect(registryOptions.value?.simulated?.logger).toBeDefined();
  });

  it('rejects deliveries until the pub/sub client is set, then publishes on the channel', async () => {
    const sink = registryOptions.value!.simulated!.events!;
    await expect(sink.deliver(delivery)).rejects.toThrow('not connected');

    const publish = vi.fn().mockResolvedValue(undefined);
    setPaymentPubSub({ publish });
    await sink.deliver(delivery);
    expect(publish).toHaveBeenCalledWith(
      'payment_webhook_deliveries',
      JSON.stringify({ provider: 'simulated', ...delivery }),
    );

    setPaymentPubSub(null);
    await expect(sink.deliver(delivery)).rejects.toThrow('not connected');
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
