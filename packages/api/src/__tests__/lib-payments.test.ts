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
vi.stubEnv('API_PORT', '3001');
vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'k');

const { activePaymentProvider, paymentRegistry } = await import('../lib/payments.js');
const { setJobQueueResolver } = await import('@evtivity/lib/job-queues');

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

  it('adds the event to the worker payment-webhooks queue, so it waits while no worker runs', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const names: string[] = [];
    setJobQueueResolver((name) => {
      names.push(name);
      return { add, addBulk: vi.fn() };
    });
    try {
      await registryOptions.value!.simulated!.events!.deliver(delivery);
    } finally {
      setJobQueueResolver(null);
    }
    expect(names).toEqual(['payment-webhooks']);
    expect(add).toHaveBeenCalledWith(
      'deliver',
      { provider: 'simulated', ...delivery },
      { jobId: expect.stringMatching(/^simulated-[0-9a-f]{64}$/), delay: 30_000 },
    );
  });
});

describe('activePaymentProvider', () => {
  it('resolves through the shared resolver with this process registry and the caller logger', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const provider = { id: 'stripe' };
    mockResolveActiveProvider.mockResolvedValueOnce(provider);
    await expect(activePaymentProvider(logger)).resolves.toBe(provider);
    expect(mockResolveActiveProvider).toHaveBeenCalledWith({
      registry: paymentRegistry,
      logger,
      actor: { actor: 'system', actorLabel: 'payments' },
    });
  });
});
