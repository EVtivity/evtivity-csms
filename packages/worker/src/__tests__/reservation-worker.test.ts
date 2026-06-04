// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
}));

// Capture the Worker processor and the event handlers registered via .on().
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

const mockLogJobStarted = vi.fn().mockResolvedValue(77);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

const mockHandleReservationActivate = vi.fn().mockResolvedValue(undefined);
vi.mock('../handlers/reservation-activate.js', () => ({
  handleReservationActivate: (...args: unknown[]) => mockHandleReservationActivate(...args),
}));

const mockPubsub = {
  publish: vi.fn(),
  subscribe: vi.fn(),
} as never;

function makeJob(name: string, data: unknown): Job {
  return { name, data } as unknown as Job;
}

beforeEach(() => {
  capturedProcessor = undefined;
  onHandlers.clear();
  workerCtorCalls.length = 0;
  mockWorkerOn.mockClear();
  mockLog.info.mockClear();
  mockLog.error.mockClear();
  mockLog.warn.mockClear();
  mockLogJobStarted.mockClear();
  mockLogJobStarted.mockResolvedValue(77);
  mockLogJobCompleted.mockClear();
  mockLogJobFailed.mockClear();
  mockLogJobFailed.mockResolvedValue(undefined);
  mockHandleReservationActivate.mockClear();
  mockHandleReservationActivate.mockResolvedValue(undefined);
});

describe('createReservationWorker', () => {
  it('wires the Worker to the reservations queue with concurrency 5', async () => {
    const { Worker } = await import('bullmq');
    const { createReservationWorker } = await import('../reservation-worker.js');

    createReservationWorker({}, mockPubsub);

    expect(Worker).toHaveBeenCalledWith(
      'reservations',
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 }),
    );
    expect(workerCtorCalls[0]?.opts).toMatchObject({ concurrency: 5 });
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createReservationWorker } = await import('../reservation-worker.js');
    const connection = { host: 'redis-x' } as never;

    createReservationWorker(connection, mockPubsub);

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('processor logs start, runs the handler, then logs completion', async () => {
    const { createReservationWorker } = await import('../reservation-worker.js');
    createReservationWorker({}, mockPubsub);

    const job = makeJob('reservation-activate', { reservationDbId: 'rsv_1' });
    await capturedProcessor?.(job);

    expect(mockLogJobStarted).toHaveBeenCalledWith('reservation-activate', 'reservations');
    expect(mockHandleReservationActivate).toHaveBeenCalledWith(job, mockPubsub);
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(77);
    expect(typeof mockLogJobCompleted.mock.calls[0]?.[1]).toBe('number');
    expect(mockLogJobFailed).not.toHaveBeenCalled();
  });

  it('processor logs failure and rethrows when the handler throws an Error', async () => {
    mockHandleReservationActivate.mockRejectedValueOnce(new Error('activate failed'));
    const { createReservationWorker } = await import('../reservation-worker.js');
    createReservationWorker({}, mockPubsub);

    const job = makeJob('reservation-activate', { reservationDbId: 'rsv_2' });
    await expect(capturedProcessor?.(job)).rejects.toThrow('activate failed');

    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[0]).toBe(77);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('activate failed');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();
  });

  it('processor uses "Unknown error" when a non-Error is thrown', async () => {
    mockHandleReservationActivate.mockRejectedValueOnce('weird');
    const { createReservationWorker } = await import('../reservation-worker.js');
    createReservationWorker({}, mockPubsub);

    const job = makeJob('reservation-activate', { reservationDbId: 'rsv_3' });
    await expect(capturedProcessor?.(job)).rejects.toBe('weird');

    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('processor swallows a logJobFailed error but still rethrows the original', async () => {
    mockHandleReservationActivate.mockRejectedValueOnce(new Error('original'));
    mockLogJobFailed.mockRejectedValueOnce(new Error('log write failed'));
    const { createReservationWorker } = await import('../reservation-worker.js');
    createReservationWorker({}, mockPubsub);

    const job = makeJob('reservation-activate', { reservationDbId: 'rsv_4' });
    await expect(capturedProcessor?.(job)).rejects.toThrow('original');
  });

  it('registers a failed listener that logs jobs and ignores null jobs', async () => {
    const { createReservationWorker } = await import('../reservation-worker.js');
    createReservationWorker({}, mockPubsub);

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    failedHandler?.(makeJob('reservation-activate', {}), new Error('boom'));
    expect(mockLog.error).toHaveBeenCalledWith(
      { jobName: 'reservation-activate', error: expect.any(Error) },
      'Reservation job failed',
    );

    mockLog.error.mockClear();
    failedHandler?.(null, new Error('boom'));
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});

describe('startReservationBridge', () => {
  function makeReservationQueue() {
    return { add: vi.fn().mockResolvedValue(undefined) };
  }

  it('subscribes to reservation_schedule and returns a stop function', async () => {
    const { startReservationBridge } = await import('../reservation-worker.js');
    const queue = makeReservationQueue();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockResolvedValue({ unsubscribe });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    const stop = await startReservationBridge(pubsub, queue as never);

    expect(subscribe).toHaveBeenCalledWith('reservation_schedule', expect.any(Function));
    expect(mockLog.info).toHaveBeenCalledWith('Reservation schedule bridge started');

    await stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('Reservation schedule bridge stopped');
  });

  it('enqueues a delayed reservation-activate job on a valid payload', async () => {
    const { startReservationBridge } = await import('../reservation-worker.js');
    const queue = makeReservationQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startReservationBridge(pubsub, queue as never);
    handler?.(JSON.stringify({ reservationDbId: 'rsv_9', delayMs: 60000 }));
    await Promise.resolve();

    expect(queue.add).toHaveBeenCalledWith(
      'reservation-activate',
      { reservationDbId: 'rsv_9' },
      expect.objectContaining({
        jobId: 'reservation-activate-rsv_9',
        delay: 60000,
        attempts: 3,
      }),
    );
  });

  it('warns and skips enqueue on a malformed payload', async () => {
    const { startReservationBridge } = await import('../reservation-worker.js');
    const queue = makeReservationQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startReservationBridge(pubsub, queue as never);
    handler?.('{not valid json');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.any(String) }),
      'Malformed reservation_schedule payload',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('logs an error when enqueue fails (fail-open)', async () => {
    const { startReservationBridge } = await import('../reservation-worker.js');
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis down')) };
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startReservationBridge(pubsub, queue as never);
    handler?.(JSON.stringify({ reservationDbId: 'rsv_x', delayMs: 1000 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ reservationDbId: 'rsv_x' }),
      'Failed to enqueue reservation-activate job',
    );
  });
});
