// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setJobQueueResolver } from '@evtivity/lib/job-queues';
import { PAYMENT_WEBHOOK_QUEUE } from '@evtivity/lib/worker-queues';
import {
  deferredSimulatedSink,
  PAYMENT_WEBHOOK_JOB_NAME,
  paymentWebhookJobId,
  queueSimulatedSink,
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

describe('queueSimulatedSink', () => {
  const add = vi.fn();
  const queueNames: string[] = [];

  beforeEach(() => {
    add.mockReset().mockResolvedValue(undefined);
    queueNames.length = 0;
    setJobQueueResolver((name) => {
      queueNames.push(name);
      return { add, addBulk: vi.fn() };
    });
  });

  afterEach(() => {
    setJobQueueResolver(null);
  });

  it('adds the delivery to the payment-webhooks queue, delayed, job id from the signed body', async () => {
    await queueSimulatedSink().deliver(delivery);
    expect(queueNames).toEqual([PAYMENT_WEBHOOK_QUEUE]);
    const message = { provider: 'simulated' as const, ...delivery };
    expect(add).toHaveBeenCalledWith(PAYMENT_WEBHOOK_JOB_NAME, message, {
      jobId: paymentWebhookJobId(message),
      delay: 30_000,
    });
  });

  it('keys the job on the provider and the body hash, not the delay (P7)', () => {
    const message = { provider: 'simulated' as const, ...delivery };
    const expected = `simulated-${createHash('sha256').update(delivery.rawBody).digest('hex')}`;
    expect(paymentWebhookJobId(message)).toBe(expected);
    expect(paymentWebhookJobId({ ...message, delaySeconds: 3 })).toBe(expected);
  });

  it('passes an add failure to the provider, which logs it and succeeds (P9)', async () => {
    const warn = vi.fn();
    add.mockRejectedValue(new Error('redis down'));
    const provider = new SimulatedPaymentProvider({
      encryptionKey: KEY,
      events: queueSimulatedSink(),
      logger: { warn },
    });
    const result = await provider.capture(captureInput('pi_sim_dispute_5000_abc'));
    expect(result.state).toBe('succeeded');
    expect(add).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventIds: expect.any(Array) }),
      'Simulated payment event not delivered',
    );
  });

  it('carries the sync-mode dispute of the dispute card, signed for the pipeline', async () => {
    const provider = new SimulatedPaymentProvider({
      encryptionKey: KEY,
      events: queueSimulatedSink(),
      disputeDelaySeconds: 30,
    });
    await provider.capture(captureInput('pi_sim_dispute_5000_abc'));
    const message = add.mock.calls[0]![1] as SimulatedWebhookDelivery & { provider: string };
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
