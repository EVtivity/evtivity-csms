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
}));

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

const mockRunLoadManagementCycle = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/services/load-management.service.js', () => ({
  runLoadManagementCycle: (...args: unknown[]) => mockRunLoadManagementCycle(...args),
}));

function makeJob(name: string, data: unknown = {}): Job {
  return { name, data } as unknown as Job;
}

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
  mockRunLoadManagementCycle.mockResolvedValue(undefined);
});

describe('enqueueLoadManagementJobs', () => {
  it('enqueues one job per enabled site with deduplication jobId', async () => {
    const { enqueueLoadManagementJobs } = await import('../load-management-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueLoadManagementJobs({ add } as never);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-1' },
      expect.objectContaining({ jobId: 'load-management-site-1', attempts: 1 }),
    );
    expect(add).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-2' },
      expect.objectContaining({ jobId: 'load-management-site-2', attempts: 1 }),
    );
  });

  it('enqueues nothing when no sites have load management enabled', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    const { enqueueLoadManagementJobs } = await import('../load-management-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueLoadManagementJobs({ add } as never);

    expect(add).not.toHaveBeenCalled();
  });
});

describe('createLoadManagementWorker', () => {
  it('wires the Worker to the load-management queue with concurrency 5', async () => {
    const { Worker } = await import('bullmq');
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    expect(Worker).toHaveBeenCalledWith(
      'load-management',
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 }),
    );
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    const connection = { host: 'redis-load' } as never;
    createLoadManagementWorker(connection, { add: vi.fn() } as never);

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('coordinator job fans out per-site jobs and never starts a per-site job log', async () => {
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    const add = vi.fn().mockResolvedValue(undefined);
    createLoadManagementWorker({}, { add } as never);

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
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    await capturedProcessor?.(makeJob('load-management', { siteId: 'site-42' }));

    expect(mockLogJobStarted).toHaveBeenCalledWith('load-management:site-42', 'load-management');
    expect(mockLog.info).toHaveBeenCalledWith(
      { siteId: 'site-42' },
      'Processing load management for site',
    );
    expect(mockRunLoadManagementCycle).toHaveBeenCalledWith(mockLog, 'site-42');
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(55);
    expect(typeof mockLogJobCompleted.mock.calls[0]?.[1]).toBe('number');
    expect(mockLogJobFailed).not.toHaveBeenCalled();
  });

  it('per-site job logs failure and rethrows when the cycle throws', async () => {
    mockRunLoadManagementCycle.mockRejectedValueOnce(new Error('allocation failed'));
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

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
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    await expect(
      capturedProcessor?.(makeJob('load-management', { siteId: 'site-8' })),
    ).rejects.toBe('weird');

    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('per-site job swallows a logJobFailed write error but rethrows the original', async () => {
    mockRunLoadManagementCycle.mockRejectedValueOnce(new Error('original'));
    mockLogJobFailed.mockRejectedValueOnce(new Error('log write failed'));
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    await expect(
      capturedProcessor?.(makeJob('load-management', { siteId: 'site-9' })),
    ).rejects.toThrow('original');
  });
});

describe('load-management-worker failed listener', () => {
  it('logs the failed job with its siteId', async () => {
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    failedHandler?.(makeJob('load-management', { siteId: 'site-fail' }), new Error('boom'));

    expect(mockLog.error).toHaveBeenCalledWith(
      { err: expect.any(Error), siteId: 'site-fail' },
      'Load management job failed',
    );
  });

  it('ignores a null job', async () => {
    const { createLoadManagementWorker } = await import('../load-management-worker.js');
    createLoadManagementWorker({}, { add: vi.fn() } as never);

    const failedHandler = onHandlers.get('failed');
    failedHandler?.(null, new Error('boom'));

    expect(mockLog.error).not.toHaveBeenCalled();
  });
});
