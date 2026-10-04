// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { CreatePaymentRegistryOptions, SimulatedWebhookDelivery } from '@evtivity/payments';

const registryOptions = vi.hoisted(() => ({ value: null as CreatePaymentRegistryOptions | null }));
vi.mock('@evtivity/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/payments')>();
  return {
    ...actual,
    createPaymentRegistry: vi.fn((options: CreatePaymentRegistryOptions) => {
      registryOptions.value = options;
      return {};
    }),
  };
});
vi.stubEnv('SETTINGS_ENCRYPTION_KEY', 'k');

const { setSimulatedEventSink } = await import('../../lib/payments.js');

const delivery: SimulatedWebhookDelivery = {
  rawBody: '{"events":[]}',
  headers: { 'x-simulated-signature': 'f00d' },
  delaySeconds: 30,
};

describe('worker payment registry: simulated events', () => {
  it('passes a sink and a logger to the simulated provider', () => {
    expect(registryOptions.value?.simulated?.events).toBeDefined();
    expect(registryOptions.value?.simulated?.logger).toBeDefined();
  });

  it('rejects deliveries until the queue sink is set, then forwards to it', async () => {
    const sink = registryOptions.value!.simulated!.events!;
    await expect(sink.deliver(delivery)).rejects.toThrow('not connected');

    const deliver = vi.fn().mockResolvedValue(undefined);
    setSimulatedEventSink({ deliver });
    await sink.deliver(delivery);
    expect(deliver).toHaveBeenCalledWith(delivery);

    setSimulatedEventSink(null);
    await expect(sink.deliver(delivery)).rejects.toThrow('not connected');
  });
});
