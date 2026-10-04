// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
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
  PAYMENT_WEBHOOK_CHANNEL: 'payment_webhook_deliveries',
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

const {
  createPaymentWebhookWorker,
  paymentWebhookJobId,
  queueSimulatedSink,
  startPaymentWebhookBridge,
} = await import('../payment-webhook-worker.js');

const signed = {
  rawBody: '{"events":[{"eventId":"evt_sim_1"}]}',
  headers: { 'content-type': 'application/json', 'x-simulated-signature': 'f00d' },
  delaySeconds: 30,
};
const delivery = { provider: 'simulated' as const, ...signed };
const expectedJobId = `simulated-${crypto.createHash('sha256').update(delivery.rawBody).digest('hex')}`;

function makeQueue(): { queue: Queue; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn().mockResolvedValue({ id: 'job' });
  return { queue: { add } as unknown as Queue, add };
}

function makePubsub(): {
  pubsub: PubSubClient;
  handler: () => (payload: string) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((payload: string) => void) | undefined;
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const pubsub = {
    subscribe: vi.fn((_channel: string, h: (payload: string) => void) => {
      captured = h;
      return Promise.resolve({ unsubscribe });
    }),
  } as unknown as PubSubClient;
  return {
    pubsub,
    handler: () => {
      if (captured == null) throw new Error('not subscribed');
      return captured;
    },
    unsubscribe,
  };
}

function processor(): (job: Job) => Promise<void> {
  if (capturedProcessor == null) throw new Error('worker not created');
  return capturedProcessor;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedProcessor = undefined;
  workerCtorCalls.length = 0;
  mockLogJobStarted.mockResolvedValue(41);
  mockIngest.mockResolvedValue({ ack: { status: 200 }, applied: 1, duplicates: 0, notices: [] });
});

describe('paymentWebhookJobId', () => {
  it('is the provider plus the SHA-256 of the body, so replicas dedupe (P7)', () => {
    expect(paymentWebhookJobId(delivery)).toBe(expectedJobId);
    expect(paymentWebhookJobId({ ...delivery, delaySeconds: 3 })).toBe(expectedJobId);
  });
});

describe('startPaymentWebhookBridge', () => {
  it('subscribes to the payment webhook channel', async () => {
    const { pubsub } = makePubsub();
    const { queue } = makeQueue();
    await startPaymentWebhookBridge(pubsub, queue);
    expect(pubsub.subscribe).toHaveBeenCalledWith(
      'payment_webhook_deliveries',
      expect.any(Function),
    );
  });

  it('adds a delayed job with the deterministic job id', async () => {
    const { pubsub, handler } = makePubsub();
    const { queue, add } = makeQueue();
    await startPaymentWebhookBridge(pubsub, queue);
    handler()(JSON.stringify(delivery));
    await flush();
    expect(add).toHaveBeenCalledWith('deliver', delivery, {
      jobId: expectedJobId,
      delay: 30_000,
    });
  });

  it('drops malformed messages with a warning', async () => {
    const { pubsub, handler } = makePubsub();
    const { queue, add } = makeQueue();
    await startPaymentWebhookBridge(pubsub, queue);
    handler()('not json');
    handler()(JSON.stringify({ ...delivery, provider: 'stripe' }));
    handler()(JSON.stringify({ ...delivery, delaySeconds: -1 }));
    handler()(JSON.stringify({ ...delivery, rawBody: '' }));
    await flush();
    expect(add).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(4);
  });

  it('logs a failed enqueue', async () => {
    const { pubsub, handler } = makePubsub();
    const { queue, add } = makeQueue();
    add.mockRejectedValueOnce(new Error('redis down'));
    await startPaymentWebhookBridge(pubsub, queue);
    handler()(JSON.stringify(delivery));
    await flush();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to enqueue payment webhook delivery',
    );
  });

  it('unsubscribes on stop', async () => {
    const { pubsub, unsubscribe } = makePubsub();
    const { queue } = makeQueue();
    const stop = await startPaymentWebhookBridge(pubsub, queue);
    await stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('queueSimulatedSink', () => {
  it('enqueues the worker’s own simulated events directly, without pub/sub', async () => {
    const { queue, add } = makeQueue();
    await queueSimulatedSink(queue).deliver(signed);
    expect(add).toHaveBeenCalledWith('deliver', delivery, {
      jobId: expectedJobId,
      delay: 30_000,
    });
  });

  it('rejects when the enqueue fails, so the provider logs it', async () => {
    const { queue, add } = makeQueue();
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(queueSimulatedSink(queue).deliver(signed)).rejects.toThrow('redis down');
  });
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
