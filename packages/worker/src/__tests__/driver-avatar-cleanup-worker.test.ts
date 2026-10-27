// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
mockLog.child.mockReturnValue(mockLog);
vi.mock('@evtivity/lib', () => ({ createLogger: vi.fn(() => mockLog) }));
vi.mock('../lib/config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'key' } }));

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
const workerCtorCalls: string[] = [];
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown, name: string, processor: (job: Job) => Promise<void>) {
    capturedProcessor = processor;
    workerCtorCalls.push(name);
    return { on: vi.fn() };
  }),
}));

const mockRun = vi.fn();
const mockLoadS3 = vi.fn();
vi.mock('@evtivity/services/avatar-storage', () => ({
  runAvatarCleanupJob: (...args: unknown[]) => mockRun(...args),
}));
vi.mock('@evtivity/services/s3-storage', () => ({
  loadS3Config: (...args: unknown[]) => mockLoadS3(...args),
}));

const { createDriverAvatarCleanupWorker } = await import('../driver-avatar-cleanup-worker.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.child.mockReturnValue(mockLog);
  workerCtorCalls.length = 0;
  mockRun.mockResolvedValue(undefined);
  mockLoadS3.mockResolvedValue({ bucket: 'b' });
});

describe('createDriverAvatarCleanupWorker', () => {
  it('runs each job of the driver-avatar-cleanup queue with the current S3 config', async () => {
    createDriverAvatarCleanupWorker({});
    expect(workerCtorCalls).toEqual(['driver-avatar-cleanup']);
    const data = { driverId: 'drv_1', buckets: [] };
    await capturedProcessor?.({ id: 'j1', name: 'purge-driver', data } as unknown as Job);
    expect(mockLoadS3).toHaveBeenCalledWith('key');
    expect(mockRun).toHaveBeenCalledWith('purge-driver', data, { bucket: 'b' }, mockLog);
  });

  it('lets a storage failure throw, so the queue retries the job', async () => {
    createDriverAvatarCleanupWorker({});
    mockRun.mockRejectedValue(new Error('s3 down'));
    await expect(
      capturedProcessor?.({ id: 'j2', name: 'delete-object', data: {} } as unknown as Job),
    ).rejects.toThrow('s3 down');
  });
});
