// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import {
  deferredSimulatedSink,
  PAYMENT_WEBHOOK_CHANNEL,
  pubsubSimulatedSink,
} from '../simulated-delivery.js';
import { SimulatedPaymentProvider } from '../providers/simulated/index.js';
import type { SimulatedWebhookDelivery } from '../providers/simulated/index.js';
import type { CaptureInput } from '../types.js';

const KEY = 'test-settings-encryption-key';

const delivery: SimulatedWebhookDelivery = {
  rawBody: '{"events":[]}',
  headers: { 'content-type': 'application/json', 'x-simulated-signature': 'abc' },
  delaySeconds: 30,
};

function captureInput(paymentId: string): CaptureInput {
  return {
    idempotencyKey: 'capture_1',
    paymentId,
    amountCents: 3000,
    currency: 'USD',
    merchantReference: 'sess_1',
    payoutAccountId: null,
    feeTax: 0,
    platformFeePercent: 0,
  };
}

describe('pubsubSimulatedSink', () => {
  it('publishes the delivery with its provider on the payment webhook channel', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await pubsubSimulatedSink({ publish }).deliver(delivery);
    expect(PAYMENT_WEBHOOK_CHANNEL).toBe('payment_webhook_deliveries');
    expect(publish).toHaveBeenCalledWith(
      'payment_webhook_deliveries',
      JSON.stringify({ provider: 'simulated', ...delivery }),
    );
  });

  it('passes a publish failure to the provider, which logs it and succeeds (P9)', async () => {
    const warn = vi.fn();
    const publish = vi.fn().mockRejectedValue(new Error('redis down'));
    const provider = new SimulatedPaymentProvider({
      encryptionKey: KEY,
      events: pubsubSimulatedSink({ publish }),
      logger: { warn },
    });
    const result = await provider.capture(captureInput('pi_sim_dispute_5000_abc'));
    expect(result.state).toBe('succeeded');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventIds: expect.any(Array) }),
      'Simulated payment event not delivered',
    );
  });

  it('carries the sync-mode dispute of the dispute card, signed for the pipeline', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const provider = new SimulatedPaymentProvider({
      encryptionKey: KEY,
      events: pubsubSimulatedSink({ publish }),
      disputeDelaySeconds: 30,
    });
    await provider.capture(captureInput('pi_sim_dispute_5000_abc'));
    const message = JSON.parse(publish.mock.calls[0]![1] as string) as SimulatedWebhookDelivery & {
      provider: string;
    };
    expect(message.provider).toBe('simulated');
    expect(message.delaySeconds).toBe(30);
    expect(provider.verifyWebhook(message.rawBody, message.headers)[0]).toMatchObject({
      type: 'payment.disputed',
      paymentId: 'pi_sim_dispute_5000_abc',
    });
  });
});

describe('deferredSimulatedSink', () => {
  it('rejects until a sink is bound, so the provider logs the lost event', async () => {
    const sink = deferredSimulatedSink();
    await expect(sink.deliver(delivery)).rejects.toThrow('Simulated event sink is not connected');
  });

  it('forwards to the bound sink', async () => {
    const sink = deferredSimulatedSink();
    const deliver = vi.fn().mockResolvedValue(undefined);
    sink.bind({ deliver });
    await sink.deliver(delivery);
    expect(deliver).toHaveBeenCalledWith(delivery);
  });

  it('rejects again after unbinding (shutdown)', async () => {
    const sink = deferredSimulatedSink();
    sink.bind({ deliver: vi.fn().mockResolvedValue(undefined) });
    sink.bind(null);
    await expect(sink.deliver(delivery)).rejects.toThrow('Simulated event sink is not connected');
  });
});
