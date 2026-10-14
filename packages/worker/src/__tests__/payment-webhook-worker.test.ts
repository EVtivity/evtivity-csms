// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
}));

class MockUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
const workerCtorCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
vi.mock('bullmq', () => ({
  UnrecoverableError: MockUnrecoverableError,
  Worker: vi.fn(function (
    this: unknown,
    name: string,
    processor: (job: Job) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    capturedProcessor = processor;
    workerCtorCalls.push({ name, opts });
    return { on: vi.fn() };
  }),
}));

const mockLogJobStarted = vi.fn().mockResolvedValue(41);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

class MockWebhookSignatureError extends Error {}
class MockWebhookNotConfiguredError extends Error {}
const mockIngest = vi.fn();
const mockDispatchNotices = vi.fn();
vi.mock('@evtivity/payments', () => ({
  ingestPaymentWebhook: (...args: unknown[]) => mockIngest(...args),
  dispatchPaymentWebhookNotices: (...args: unknown[]) => mockDispatchNotices(...args),
  WebhookSignatureError: MockWebhookSignatureError,
  WebhookNotConfiguredError: MockWebhookNotConfiguredError,
}));

const paymentCtx = { registry: 'registry', logger: mockLog };
vi.mock('../lib/payments.js', () => ({
  PAYMENT_TEMPLATES_DIRS: ['/templates'],
  paymentContext: () => paymentCtx,
}));

const { createPaymentWebhookWorker } = await import('../payment-webhook-worker.js');

const signed = {
  rawBody: '{"events":[{"eventId":"evt_sim_1"}]}',
  headers: { 'content-type': 'application/json', 'x-simulated-signature': 'f00d' },
  delaySeconds: 30,
};
const delivery = { provider: 'simulated' as const, ...signed };

function processor(): (job: Job) => Promise<void> {
  if (capturedProcessor == null) throw new Error('worker not created');
  return capturedProcessor;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedProcessor = undefined;
  workerCtorCalls.length = 0;
  mockLogJobStarted.mockResolvedValue(41);
  mockIngest.mockResolvedValue({ ack: { status: 200 }, applied: 1, duplicates: 0, notices: [] });
});

describe('createPaymentWebhookWorker', () => {
  function job(): Job {
    return { id: 'j1', name: 'deliver', data: delivery, attemptsMade: 0 } as unknown as Job;
  }

  it('processes the payment-webhooks queue', () => {
    createPaymentWebhookWorker({}, null);
    expect(workerCtorCalls[0]?.name).toBe('payment-webhooks');
  });

  it('ingests the body through the webhook pipeline', async () => {
    createPaymentWebhookWorker({}, null);
    await processor()(job());
    expect(mockIngest).toHaveBeenCalledWith(
      'simulated',
      delivery.rawBody,
      delivery.headers,
      paymentCtx,
    );
    expect(mockLogJobStarted).toHaveBeenCalledWith('deliver', 'payment-webhooks');
    expect(mockLogJobCompleted).toHaveBeenCalledWith(41, expect.any(Number));
  });

  it('tells the driver and the operator UI what the events changed', async () => {
    const pubsub = { publish: vi.fn() } as unknown as PubSubClient;
    createPaymentWebhookWorker({}, pubsub);
    const notices = [{ kind: 'record_changed', record: { id: 1 } }];
    mockIngest.mockResolvedValueOnce({ applied: 1, duplicates: 0, notices });
    await processor()(job());
    expect(mockDispatchNotices).toHaveBeenCalledWith(notices, {
      templatesDirs: ['/templates'],
      pubsub,
      logger: mockLog,
    });
  });

  it('dispatches nothing without notices', async () => {
    createPaymentWebhookWorker({}, null);
    mockIngest.mockResolvedValueOnce({ applied: 1, duplicates: 0, notices: [] });
    await processor()(job());
    expect(mockDispatchNotices).not.toHaveBeenCalled();
  });

  it('does not retry a bad signature', async () => {
    createPaymentWebhookWorker({}, null);
    mockIngest.mockRejectedValueOnce(new MockWebhookSignatureError('Invalid signature'));
    await expect(processor()(job())).rejects.toBeInstanceOf(MockUnrecoverableError);
    expect(mockLog.error).toHaveBeenCalled();
    expect(mockLogJobFailed).toHaveBeenCalledWith(41, expect.any(Number), 'Invalid signature');
  });

  it('does not retry when the provider is not configured in this process', async () => {
    createPaymentWebhookWorker({}, null);
    mockIngest.mockRejectedValueOnce(new MockWebhookNotConfiguredError('not configured'));
    await expect(processor()(job())).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('rethrows other errors so BullMQ retries', async () => {
    createPaymentWebhookWorker({}, null);
    const dbDown = new Error('db down');
    mockIngest.mockRejectedValueOnce(dbDown);
    await expect(processor()(job())).rejects.toBe(dbDown);
    expect(mockLogJobFailed).toHaveBeenCalledWith(41, expect.any(Number), 'db down');
  });
});
