// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
}));

const mockRunMaintenanceFanout = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/services/maintenance.service.js', () => ({
  runMaintenanceFanout: (...args: unknown[]) => mockRunMaintenanceFanout(...args),
  MAINTENANCE_FANOUT_CHANNEL: 'maintenance_fanout',
}));

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

const mockLogJobStarted = vi.fn().mockResolvedValue(88);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

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
  mockLogJobStarted.mockResolvedValue(88);
  mockLogJobCompleted.mockClear();
  mockLogJobFailed.mockClear();
  mockLogJobFailed.mockResolvedValue(undefined);
  mockRunMaintenanceFanout.mockClear();
  mockRunMaintenanceFanout.mockResolvedValue(undefined);
});

describe('createMaintenanceFanoutWorker', () => {
  it('wires the Worker to the maintenance-fanout queue with concurrency 1 so fan-outs serialize in enqueue order', async () => {
    const { Worker } = await import('bullmq');
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');

    createMaintenanceFanoutWorker({});

    expect(Worker).toHaveBeenCalledWith(
      'maintenance-fanout',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    const connection = { host: 'redis-y' } as never;

    createMaintenanceFanoutWorker(connection);

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('processor logs start, runs the fan-out, then logs completion', async () => {
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    createMaintenanceFanoutWorker({});

    const data = { eventId: 'mne_1', phase: 'enter' };
    const job = makeJob('maintenance-fanout', data);
    await capturedProcessor?.(job);

    expect(mockLogJobStarted).toHaveBeenCalledWith('maintenance-fanout', 'maintenance-fanout');
    expect(mockRunMaintenanceFanout).toHaveBeenCalledWith(data, mockLog);
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(88);
    expect(mockLogJobFailed).not.toHaveBeenCalled();
  });

  it('processor logs failure and rethrows when the fan-out throws', async () => {
    mockRunMaintenanceFanout.mockRejectedValueOnce(new Error('fanout failed'));
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    createMaintenanceFanoutWorker({});

    const job = makeJob('maintenance-fanout', { eventId: 'mne_2', phase: 'release' });
    await expect(capturedProcessor?.(job)).rejects.toThrow('fanout failed');

    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('fanout failed');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();
  });

  it('processor uses "Unknown error" when a non-Error is thrown', async () => {
    mockRunMaintenanceFanout.mockRejectedValueOnce('weird');
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    createMaintenanceFanoutWorker({});

    const job = makeJob('maintenance-fanout', { eventId: 'mne_3', phase: 'add' });
    await expect(capturedProcessor?.(job)).rejects.toBe('weird');

    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('takes and releases a per-site lock when a lock client is provided', async () => {
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    const lockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    };
    createMaintenanceFanoutWorker({}, lockRedis as never);

    const data = { eventId: 'mne_1', siteId: 'sit_1', phase: 'enter' };
    await capturedProcessor?.(makeJob('maintenance-fanout', data));

    expect(lockRedis.set).toHaveBeenCalledWith('mfl:sit_1', expect.any(String), 'PX', 60000, 'NX');
    expect(mockRunMaintenanceFanout).toHaveBeenCalledWith(data, mockLog);
    // release-if-owner is the last eval call
    const lastEval = lockRedis.eval.mock.calls.at(-1);
    expect(lastEval?.[2]).toBe('mfl:sit_1');
  });

  it('falls back to the eventId lock key when the job carries no siteId', async () => {
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    const lockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    };
    createMaintenanceFanoutWorker({}, lockRedis as never);

    await capturedProcessor?.(
      makeJob('maintenance-fanout', { eventId: 'mne_2', phase: 'release' }),
    );

    expect(lockRedis.set).toHaveBeenCalledWith('mfl:mne_2', expect.any(String), 'PX', 60000, 'NX');
  });

  it('releases the lock even when the fan-out throws', async () => {
    mockRunMaintenanceFanout.mockRejectedValueOnce(new Error('boom'));
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    const lockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    };
    createMaintenanceFanoutWorker({}, lockRedis as never);

    await expect(
      capturedProcessor?.(makeJob('maintenance-fanout', { eventId: 'mne_3', phase: 'enter' })),
    ).rejects.toThrow('boom');

    const lastEval = lockRedis.eval.mock.calls.at(-1);
    expect(lastEval?.[2]).toBe('mfl:mne_3');
  });

  it('registers a failed listener that logs jobs and ignores null jobs', async () => {
    const { createMaintenanceFanoutWorker } = await import('../maintenance-fanout-worker.js');
    createMaintenanceFanoutWorker({});

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    failedHandler?.(makeJob('maintenance-fanout', {}), new Error('boom'));
    expect(mockLog.error).toHaveBeenCalledWith(
      { jobName: 'maintenance-fanout', error: expect.any(Error) },
      'Maintenance fan-out job failed',
    );

    mockLog.error.mockClear();
    failedHandler?.(null, new Error('boom'));
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});

describe('startMaintenanceFanoutBridge', () => {
  function makeQueue() {
    return { add: vi.fn().mockResolvedValue(undefined) };
  }

  it('subscribes to maintenance_fanout and returns a stop function', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = makeQueue();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockResolvedValue({ unsubscribe });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    const stop = await startMaintenanceFanoutBridge(pubsub, queue as never);

    expect(subscribe).toHaveBeenCalledWith('maintenance_fanout', expect.any(Function));
    expect(mockLog.info).toHaveBeenCalledWith('Maintenance fan-out bridge started');

    await stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('Maintenance fan-out bridge stopped');
  });

  it('enqueues an enter job with a deterministic jobId', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = makeQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startMaintenanceFanoutBridge(pubsub, queue as never);
    handler?.(JSON.stringify({ eventId: 'mne_9', phase: 'enter' }));
    await Promise.resolve();

    expect(queue.add).toHaveBeenCalledWith(
      'maintenance-fanout',
      { eventId: 'mne_9', phase: 'enter' },
      { jobId: 'mf.mne_9.enter' },
    );
  });

  it('includes a sorted station-id hash in the jobId for add/remove', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = makeQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startMaintenanceFanoutBridge(pubsub, queue as never);
    // Same set, different order -> identical jobId so a duplicate publish dedups.
    handler?.(JSON.stringify({ eventId: 'mne_9', phase: 'add', stationDbIds: ['sta_2', 'sta_1'] }));
    await Promise.resolve();

    expect(queue.add).toHaveBeenCalledWith(
      'maintenance-fanout',
      expect.objectContaining({ eventId: 'mne_9', phase: 'add' }),
      { jobId: 'mf.mne_9.add.sta_1,sta_2' },
    );
  });

  it('appends the nonce to the jobId so repeated reasserts for one station enqueue separately', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = makeQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startMaintenanceFanoutBridge(pubsub, queue as never);
    handler?.(
      JSON.stringify({
        eventId: 'mne_9',
        phase: 'reassert',
        stationDbIds: ['sta_1'],
        nonce: 'k2j4h',
      }),
    );
    await Promise.resolve();

    expect(queue.add).toHaveBeenCalledWith(
      'maintenance-fanout',
      expect.objectContaining({ phase: 'reassert' }),
      { jobId: 'mf.mne_9.reassert.sta_1.k2j4h' },
    );
  });

  it('warns and skips enqueue on a malformed payload', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = makeQueue();
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startMaintenanceFanoutBridge(pubsub, queue as never);
    handler?.('{not valid json');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.any(String) }),
      'Malformed maintenance_fanout payload',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('logs an error when enqueue fails (fail-open)', async () => {
    const { startMaintenanceFanoutBridge } = await import('../maintenance-fanout-worker.js');
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis down')) };
    let handler: ((payload: string) => void) | undefined;
    const subscribe = vi.fn((_ch: string, h: (p: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });
    const pubsub = { subscribe, publish: vi.fn() } as never;

    await startMaintenanceFanoutBridge(pubsub, queue as never);
    handler?.(JSON.stringify({ eventId: 'mne_x', phase: 'enter' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'mne_x' }),
      'Failed to enqueue maintenance-fanout job',
    );
  });
});
