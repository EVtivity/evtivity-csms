// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
const lockState = { held: false, signal: new AbortController().signal };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
  withLock: vi.fn(
    async (_redis: unknown, _key: string, fn: (signal: AbortSignal) => Promise<unknown>) =>
      lockState.held ? { acquired: false } : { acquired: true, result: await fn(lockState.signal) },
  ),
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

const mockSelectWhere = vi.fn(() => Promise.resolve([{ siteId: 'site-1' }, { siteId: 'site-2' }]));
vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: () => mockSelectWhere(),
      })),
    })),
  },
  siteLoadManagement: { siteId: 'siteId', isEnabled: 'isEnabled' },
  client: {},
  loadManagementCycleStart: () => Promise.resolve('2026-11-24 10:00:00+00'),
  recomputeRequestedSince: (...args: unknown[]) => mockRecomputeRequestedSince(...args),
  markLoadManagementRecomputeRequested: (...args: unknown[]) => mockMarkRequested(...args),
  takeLoadManagementFence: (...args: unknown[]) => mockTakeFence(...args),
  runWithLoadManagementFence: (fence: unknown, fn: () => Promise<unknown>) =>
    mockRunWithFence(fence, fn),
}));
const mockRecomputeRequestedSince = vi.fn().mockResolvedValue(false);
const mockMarkRequested = vi.fn().mockResolvedValue(undefined);
const mockTakeFence = vi.fn().mockResolvedValue(5);
const mockRunWithFence = vi.fn((_fence: unknown, fn: () => Promise<unknown>) => fn());

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

const mockLogJobStarted = vi.fn().mockResolvedValue(55);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

const mockRunLoadManagementCycle = vi.fn().mockResolvedValue({ failedSites: 0, logFailures: 0 });
vi.mock('@evtivity/services/load-management.service', () => ({
  runLoadManagementCycle: (...args: unknown[]) => mockRunLoadManagementCycle(...args),
}));

function makeJob(name: string, data: unknown = {}): Job {
  return { name, data } as unknown as Job;
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let loadManagementWorkerModule: typeof import('../load-management-worker.js');
let bullmqModule: typeof import('bullmq');
beforeAll(async () => {
  loadManagementWorkerModule = await import('../load-management-worker.js');
  bullmqModule = await import('bullmq');
}, 30_000);

beforeEach(() => {
  capturedProcessor = undefined;
  onHandlers.clear();
  workerCtorCalls.length = 0;
  mockWorkerOn.mockClear();
  mockLog.info.mockClear();
  mockLog.error.mockClear();
  mockSelectWhere.mockClear();
  mockSelectWhere.mockResolvedValue([{ siteId: 'site-1' }, { siteId: 'site-2' }]);
  mockLogJobStarted.mockClear();
  mockLogJobStarted.mockResolvedValue(55);
  mockLogJobCompleted.mockClear();
  mockLogJobCompleted.mockResolvedValue(undefined);
  mockLogJobFailed.mockClear();
  mockLogJobFailed.mockResolvedValue(undefined);
  mockRunLoadManagementCycle.mockClear();
  mockRunLoadManagementCycle.mockResolvedValue({ failedSites: 0, logFailures: 0 });
  mockRecomputeRequestedSince.mockReset();
  mockRecomputeRequestedSince.mockResolvedValue(false);
  lockState.held = false;
});

describe('enqueueLoadManagementJobs', () => {
  it('enqueues one job per enabled site, deduplicated while queued and removed once finished', async () => {
    const { enqueueLoadManagementJobs } = loadManagementWorkerModule;
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueLoadManagementJobs({ add } as never);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-1' },
      expect.objectContaining({
        jobId: 'load-management-site-1',
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    expect(add).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-2' },
      expect.objectContaining({
        jobId: 'load-management-site-2',
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('enqueues nothing when no sites have load management enabled', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    const { enqueueLoadManagementJobs } = loadManagementWorkerModule;
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueLoadManagementJobs({ add } as never);

    expect(add).not.toHaveBeenCalled();
  });
});

describe('createLoadManagementWorker', () => {
  it('wires the Worker to the load-management queue with concurrency 20 (I/O-bound cycles)', async () => {
    const { Worker } = bullmqModule;
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    expect(Worker).toHaveBeenCalledWith(
      'load-management',
      expect.any(Function),
      expect.objectContaining({ concurrency: 20 }),
    );
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    const connection = { host: 'redis-load' } as never;
    createLoadManagementWorker(connection, { add: vi.fn() } as never, { lockRedis: {} as never });

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('coordinator job fans out per-site jobs and never starts a per-site job log', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    const add = vi.fn().mockResolvedValue(undefined);
    createLoadManagementWorker({}, { add } as never, { lockRedis: {} as never });

    await capturedProcessor?.(makeJob('load-management-coordinator'));

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-1' },
      expect.objectContaining({ jobId: 'load-management-site-1' }),
    );
    // Coordinator returns before the per-site logging path.
    expect(mockLogJobStarted).not.toHaveBeenCalled();
    expect(mockRunLoadManagementCycle).not.toHaveBeenCalled();
  });

  it('per-site job runs the allocation cycle and logs start then completion', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    await capturedProcessor?.(makeJob('load-management', { siteId: 'site-42' }));

    expect(mockLogJobStarted).toHaveBeenCalledWith('load-management:site-42', 'load-management');
    expect(mockLog.info).toHaveBeenCalledWith(
      { siteId: 'site-42', job: 'load-management' },
      'Processing load management for site',
    );
    expect(mockRunLoadManagementCycle).toHaveBeenCalledWith(mockLog, 'site-42', {
      allowSimulatedEnergyAssets: false,
    });
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(55);
    expect(typeof mockLogJobCompleted.mock.calls[0]?.[1]).toBe('number');
    expect(mockLogJobFailed).not.toHaveBeenCalled();
  });

  it('passes the simulated energy asset gate of the worker to the cycle', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, {
      allowSimulatedEnergyAssets: true,
      lockRedis: {} as never,
    });

    await capturedProcessor?.(makeJob('load-management', { siteId: 'site-43' }));

    expect(mockRunLoadManagementCycle).toHaveBeenCalledWith(mockLog, 'site-43', {
      allowSimulatedEnergyAssets: true,
    });
  });

  it('records the job as failed when the cycle reports a failed site, without rethrowing', async () => {
    mockRunLoadManagementCycle.mockResolvedValueOnce({ failedSites: 1 });
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    await capturedProcessor?.(makeJob('load-management', { siteId: 'site-8' }));

    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Load management cycle failed');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();
  });

  it('per-site job logs failure and rethrows when the cycle throws', async () => {
    mockRunLoadManagementCycle.mockRejectedValueOnce(new Error('allocation failed'));
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    await expect(
      capturedProcessor?.(makeJob('load-management', { siteId: 'site-7' })),
    ).rejects.toThrow('allocation failed');

    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[0]).toBe(55);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('allocation failed');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();
  });

  it('per-site job uses "Unknown error" when a non-Error is thrown', async () => {
    mockRunLoadManagementCycle.mockRejectedValueOnce('weird');
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    await expect(
      capturedProcessor?.(makeJob('load-management', { siteId: 'site-8' })),
    ).rejects.toBe('weird');

    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('per-site job swallows a logJobFailed write error but rethrows the original', async () => {
    mockRunLoadManagementCycle.mockRejectedValueOnce(new Error('original'));
    mockLogJobFailed.mockRejectedValueOnce(new Error('log write failed'));
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    await expect(
      capturedProcessor?.(makeJob('load-management', { siteId: 'site-9' })),
    ).rejects.toThrow('original');
  });
});

describe('load-management-worker failed listener', () => {
  it('logs the failed job with its siteId', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    failedHandler?.(makeJob('load-management', { siteId: 'site-fail' }), new Error('boom'));

    expect(mockLog.error).toHaveBeenCalledWith(
      { err: expect.any(Error), siteId: 'site-fail' },
      'Load management job failed',
    );
  });

  it('ignores a null job', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });

    const failedHandler = onHandlers.get('failed');
    failedHandler?.(null, new Error('boom'));

    expect(mockLog.error).not.toHaveBeenCalled();
  });
});

describe('runSiteCycle (event-driven recompute)', () => {
  const deps = () => ({
    lockRedis: {} as never,
    loadQueue: { add: vi.fn().mockResolvedValue(undefined) },
    cycle: vi.fn().mockResolvedValue({ failedSites: 0, logFailures: 0 }),
  });

  it('queues the follow-up id when a recompute was asked while the event job ran', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    mockRecomputeRequestedSince.mockResolvedValueOnce(true);
    const result = await runSiteCycle(
      'site-1',
      { name: 'load-management-recompute', id: 'load-management-event-site-1' },
      d,
    );
    expect(result.ran).toBe(true);
    expect(d.loadQueue.add).toHaveBeenCalledWith(
      'load-management-recompute',
      { siteId: 'site-1', trigger: 'follow_up' },
      expect.objectContaining({ jobId: 'load-management-followup-site-1', delay: 500 }),
    );
  });

  it('queues the event id after a follow-up or a periodic tick', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    mockRecomputeRequestedSince.mockResolvedValue(true);
    await runSiteCycle(
      'site-1',
      { name: 'load-management-recompute', id: 'load-management-followup-site-1' },
      d,
    );
    await runSiteCycle('site-1', { name: 'load-management', id: 'load-management-site-1' }, d);
    expect(d.loadQueue.add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).toEqual([
      'load-management-event-site-1',
      'load-management-event-site-1',
    ]);
  });

  it('queues nothing when no event came in while it ran', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    await runSiteCycle(
      'site-1',
      { name: 'load-management-recompute', id: 'load-management-event-site-1' },
      d,
    );
    expect(d.loadQueue.add).not.toHaveBeenCalled();
    expect(d.cycle).toHaveBeenCalledWith('site-1');
  });

  it('runs no second cycle of a site while one holds its lock, and asks for one after it (review item 9)', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    lockState.held = true;
    const result = await runSiteCycle(
      'site-1',
      { name: 'load-management', id: 'load-management-site-1' },
      d,
    );
    expect(result.ran).toBe(false);
    expect(d.cycle).not.toHaveBeenCalled();
    // A busy periodic tick is never dropped: the running cycle queues one follow-up for it.
    expect(mockMarkRequested).toHaveBeenCalledWith(expect.anything(), 'site-1');
    expect(d.loadQueue.add).not.toHaveBeenCalled();
  });

  it('runs the cycle under the fence it raised, with the lease signal of its lock', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    await runSiteCycle('site-1', { name: 'load-management', id: 'x' }, d);
    expect(mockTakeFence).toHaveBeenCalledWith(expect.anything(), 'site-1');
    expect(mockRunWithFence).toHaveBeenCalledWith(
      { siteId: 'site-1', fence: 5, signal: lockState.signal },
      expect.any(Function),
    );
    expect(d.cycle).toHaveBeenCalledWith('site-1');
  });

  it('runs the cycle unfenced for a site without a load management row', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    mockTakeFence.mockResolvedValueOnce(null);
    const d = deps();
    await runSiteCycle('site-1', { name: 'load-management', id: 'x' }, d);
    expect(mockRunWithFence).not.toHaveBeenCalled();
    expect(d.cycle).toHaveBeenCalledWith('site-1');
  });

  it('holds the site lock on a 15 s lease, renewed while the cycle runs', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const { withLock } = await import('@evtivity/lib');
    const d = deps();
    await runSiteCycle('site-1', { name: 'load-management', id: 'x' }, d);
    await runSiteCycle(
      'site-1',
      { name: 'load-management-recompute', id: 'load-management-event-site-1' },
      d,
    );
    const opts = vi.mocked(withLock).mock.calls.map((c) => c[3]);
    // Neither waits for the lock: a busy run frees its worker slot at once.
    expect(opts).toEqual([
      { ttlMs: 15_000, acquireTimeoutMs: 0 },
      { ttlMs: 15_000, acquireTimeoutMs: 0 },
    ]);
  });

  it('requeues a recompute that finds its site busy, with a delay, instead of waiting (review item 5)', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const d = deps();
    lockState.held = true;
    const result = await runSiteCycle(
      'site-1',
      { name: 'load-management-recompute', id: 'load-management-event-site-1' },
      d,
    );
    expect(result.ran).toBe(false);
    expect(d.cycle).not.toHaveBeenCalled();
    // It holds no slot and queues no job: the running cycle runs the follow-up.
    expect(mockMarkRequested).toHaveBeenCalledWith(expect.anything(), 'site-1');
    expect(d.loadQueue.add).not.toHaveBeenCalled();
  });

  it('rethrows any other lock error, and a tick never queues on a lock error', async () => {
    const { runSiteCycle } = loadManagementWorkerModule;
    const { withLock } = await import('@evtivity/lib');
    const d = deps();
    vi.mocked(withLock).mockRejectedValueOnce(new Error('Connection is closed'));
    await expect(
      runSiteCycle('site-1', { name: 'load-management-recompute', id: 'e' }, d),
    ).rejects.toThrow('Connection is closed');
    vi.mocked(withLock).mockRejectedValueOnce(new Error('Timed out acquiring lock x'));
    await expect(runSiteCycle('site-1', { name: 'load-management', id: 't' }, d)).rejects.toThrow(
      'Timed out',
    );
    expect(d.loadQueue.add).not.toHaveBeenCalled();
  });

  it('records a failed allocation log write as its own failed job row', async () => {
    const { createLoadManagementWorker } = loadManagementWorkerModule;
    createLoadManagementWorker({}, { add: vi.fn() } as never, { lockRedis: {} as never });
    mockRunLoadManagementCycle.mockResolvedValueOnce({ failedSites: 0, logFailures: 1 });
    await capturedProcessor?.(makeJob('load-management', { siteId: 'site-1' }));
    expect(mockLogJobStarted).toHaveBeenCalledWith(
      'load-allocation-log:site-1',
      'load-allocation-log',
    );
    expect(mockLogJobFailed).toHaveBeenCalledWith(55, 0, 'Load allocation log write failed');
  });
});
