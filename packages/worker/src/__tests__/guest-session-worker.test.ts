// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
}));

// Capture the Worker processor and the .on() handlers.
let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
const onHandlers = new Map<string, (...args: unknown[]) => void>();
const mockWorkerOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  onHandlers.set(event, handler);
});
const workerCtorCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn(function (
    this: unknown,
    name: string,
    processor: (job: Job) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    capturedProcessor = processor;
    workerCtorCalls.push({ name, opts });
    return { on: mockWorkerOn };
  }),
}));

const mockLogJobStarted = vi.fn().mockResolvedValue(33);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

const mockHandleGuestSessionEvent = vi.fn().mockResolvedValue(undefined);
const mockFailExhaustedGuestCapture = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/payments', () => ({
  handleGuestSessionEvent: (...args: unknown[]) => mockHandleGuestSessionEvent(...args),
  failExhaustedGuestCapture: (...args: unknown[]) => mockFailExhaustedGuestCapture(...args),
}));

const guestDeps = { registry: 'registry', logger: mockLog, templatesDirs: ['tpl'] };
const paymentCtx = { registry: 'registry', logger: mockLog };
const mockGuestEventDeps = vi.fn(() => guestDeps);
const mockPaymentContext = vi.fn(() => paymentCtx);
vi.mock('../lib/payments.js', () => ({
  guestEventDeps: (...args: unknown[]) => mockGuestEventDeps(...(args as [])),
  paymentContext: (...args: unknown[]) => mockPaymentContext(...(args as [])),
}));

function makeJob(
  name: string,
  data: unknown = {},
  opts: Record<string, unknown> = { attempts: 3 },
  attemptsMade = 3,
): Job {
  return { name, data, opts, attemptsMade } as unknown as Job;
}

// Drains the fire-and-forget cleanup promise in the failed listener.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  capturedProcessor = undefined;
  onHandlers.clear();
  workerCtorCalls.length = 0;
  mockLogJobStarted.mockResolvedValue(33);
  mockLogJobCompleted.mockResolvedValue(undefined);
  mockLogJobFailed.mockResolvedValue(undefined);
  mockHandleGuestSessionEvent.mockResolvedValue(undefined);
  mockFailExhaustedGuestCapture.mockResolvedValue(undefined);
});

describe('startGuestSessionBridge', () => {
  it('enqueues a job with sessionId as jobId on TransactionEnded', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'TransactionEnded', sessionId: 'ses_abc123' }));
        return Promise.resolve({ unsubscribe });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);

    expect(add).toHaveBeenCalledWith(
      'guest-session-ended',
      { sessionId: 'ses_abc123' },
      expect.objectContaining({ jobId: 'guest-session-ended-ses_abc123', attempts: 3 }),
    );
    expect(mockLog.info).toHaveBeenCalledWith('Guest session bridge started');
  });

  it('enqueues a job on TransactionStarted with idToken', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(
          JSON.stringify({
            type: 'TransactionStarted',
            idToken: { idToken: 'TOKEN123', type: 'ISO14443' },
          }),
        );
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);

    expect(add).toHaveBeenCalledWith(
      'guest-session-started',
      expect.objectContaining({ event: expect.objectContaining({ type: 'TransactionStarted' }) }),
      expect.objectContaining({ jobId: 'guest-session-started-TOKEN123', attempts: 3 }),
    );
  });

  it('ignores unrelated events', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'StationConnected', stationId: 'STATION-1' }));
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    expect(add).not.toHaveBeenCalled();
  });

  it('ignores TransactionStarted without an idToken', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'TransactionStarted' }));
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    expect(add).not.toHaveBeenCalled();
  });

  it('ignores TransactionEnded without a sessionId', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'TransactionEnded' }));
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    expect(add).not.toHaveBeenCalled();
  });

  it('silently drops a malformed JSON payload', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler('{not json');
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    expect(add).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('logs an error when the ended enqueue fails (fail-open)', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'TransactionEnded', sessionId: 'ses_x' }));
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    await flushMicrotasks();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to enqueue guest-session-ended job',
    );
  });

  it('logs an error when the started enqueue fails (fail-open)', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    const pubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(
          JSON.stringify({ type: 'TransactionStarted', idToken: { idToken: 'T1', type: 'Local' } }),
        );
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(pubsub, { add } as never);
    await flushMicrotasks();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to enqueue guest-session-started job',
    );
  });

  it('returns a stop function that unsubscribes', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const pubsub = {
      subscribe: () => Promise.resolve({ unsubscribe }),
    } as never;

    const stop = await startGuestSessionBridge(pubsub, { add: vi.fn() } as never);
    await stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('Guest session bridge stopped');
  });
});

describe('createGuestSessionWorker', () => {
  it('wires the Worker to the guest-session-events queue with concurrency 10', async () => {
    const { Worker } = await import('bullmq');
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    expect(Worker).toHaveBeenCalledWith(
      'guest-session-events',
      expect.any(Function),
      expect.objectContaining({ concurrency: 10 }),
    );
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    const connection = { host: 'redis-guest' } as never;
    createGuestSessionWorker(connection);

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('processes a guest-session-started job by forwarding the event', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    const event = { type: 'TransactionStarted', idToken: { idToken: 'T', type: 'Local' } };
    await capturedProcessor?.(makeJob('guest-session-started', { event }));

    expect(mockLogJobStarted).toHaveBeenCalledWith('guest-session-started', 'guest-session-events');
    expect(mockHandleGuestSessionEvent).toHaveBeenCalledWith(event, guestDeps);
    expect(mockGuestEventDeps).toHaveBeenCalledWith(mockLog);
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(33);
    expect(mockLogJobFailed).not.toHaveBeenCalled();
  });

  it('processes a guest-session-ended job by synthesizing a TransactionEnded event', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    await capturedProcessor?.(makeJob('guest-session-ended', { sessionId: 'ses_42' }));

    expect(mockHandleGuestSessionEvent).toHaveBeenCalledWith(
      { type: 'TransactionEnded', sessionId: 'ses_42' },
      guestDeps,
    );
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
  });

  it('completes without invoking the handler for an unknown job name', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    await capturedProcessor?.(makeJob('something-else', {}));

    expect(mockHandleGuestSessionEvent).not.toHaveBeenCalled();
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
  });

  it('logs failure and rethrows when the handler throws', async () => {
    mockHandleGuestSessionEvent.mockRejectedValueOnce(new Error('finalize failed'));
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    await expect(
      capturedProcessor?.(makeJob('guest-session-ended', { sessionId: 'ses_z' })),
    ).rejects.toThrow('finalize failed');

    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[0]).toBe(33);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('finalize failed');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();
  });

  it('uses "Unknown error" when the handler throws a non-Error', async () => {
    mockHandleGuestSessionEvent.mockRejectedValueOnce('weird');
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    await expect(
      capturedProcessor?.(makeJob('guest-session-ended', { sessionId: 'ses_w' })),
    ).rejects.toBe('weird');

    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('swallows a logJobFailed write error but still rethrows the handler error', async () => {
    mockHandleGuestSessionEvent.mockRejectedValueOnce(new Error('original'));
    mockLogJobFailed.mockRejectedValueOnce(new Error('log write failed'));
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    await expect(
      capturedProcessor?.(makeJob('guest-session-ended', { sessionId: 'ses_q' })),
    ).rejects.toThrow('original');
  });
});

describe('guest-session-worker failed listener (exhausted-retry cleanup)', () => {
  it('fails the guest capture with the error message after the final retry', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    failedHandler?.(
      makeJob('guest-session-ended', { sessionId: 'ses_1' }, { attempts: 3 }, 3),
      new Error('capture failed'),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).toHaveBeenCalledWith(
      'ses_1',
      'capture failed',
      paymentCtx,
    );
    expect(mockPaymentContext).toHaveBeenCalledWith(mockLog);
    expect(mockLog.error).toHaveBeenCalledWith(
      { jobName: 'guest-session-ended', attemptsMade: 3, error: expect.any(Error) },
      'Guest session job failed',
    );
  });

  it('cuts the failure reason to 500 characters', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', { sessionId: 'ses_long' }, { attempts: 3 }, 3),
      new Error('x'.repeat(600)),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture.mock.calls[0]?.[1]).toBe('x'.repeat(500));
  });

  it('uses "Unknown error" as the failure reason when the rejection is not an Error', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', { sessionId: 'ses_ne' }, { attempts: 3 }, 3),
      'string-failure',
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).toHaveBeenCalledWith(
      'ses_ne',
      'Unknown error',
      paymentCtx,
    );
  });

  it('does not run cleanup before the final retry is exhausted', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', { sessionId: 'ses_1' }, { attempts: 3 }, 1),
      new Error('transient'),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).not.toHaveBeenCalled();
  });

  it('does not run cleanup for a started job', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-started', { event: {} }, { attempts: 3 }, 3),
      new Error('boom'),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).not.toHaveBeenCalled();
  });

  it('skips cleanup when the ended job carries no sessionId', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', {}, { attempts: 3 }, 3),
      new Error('boom'),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).not.toHaveBeenCalled();
  });

  it('logs a cleanup error when the exhausted-capture cleanup rejects', async () => {
    mockFailExhaustedGuestCapture.mockRejectedValueOnce(new Error('db down'));
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', { sessionId: 'ses_db' }, { attempts: 3 }, 3),
      new Error('boom'),
    );
    await flushMicrotasks();

    expect(mockLog.error).toHaveBeenCalledWith(
      { sessionId: 'ses_db', err: expect.any(Error) },
      'Failed to clean up after exhausted guest capture retries',
    );
  });

  it('defaults maxAttempts to 1 when opts.attempts is absent', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    // attemptsMade 1 >= default maxAttempts 1 -> cleanup runs.
    onHandlers.get('failed')?.(
      makeJob('guest-session-ended', { sessionId: 'ses_def' }, {}, 1),
      new Error('boom'),
    );
    await flushMicrotasks();

    expect(mockFailExhaustedGuestCapture).toHaveBeenCalledWith('ses_def', 'boom', paymentCtx);
  });

  it('ignores a null job', async () => {
    const { createGuestSessionWorker } = await import('../guest-session-worker.js');
    createGuestSessionWorker({});

    onHandlers.get('failed')?.(null, new Error('boom'));

    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockFailExhaustedGuestCapture).not.toHaveBeenCalled();
  });
});
