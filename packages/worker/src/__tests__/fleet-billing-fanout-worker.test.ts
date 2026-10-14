// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: vi.fn(() => mockLog),
}));

vi.mock('@evtivity/database', () => ({ client: 'client' }));

const mockRun = vi.fn();
vi.mock('@evtivity/services/fleet-billing-notice', () => ({
  runFleetBillingFanout: (...args: unknown[]) => mockRun(...args) as unknown,
}));

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown, _name: string, processor: (job: Job) => Promise<void>) {
    capturedProcessor = processor;
    return { on: vi.fn() };
  }),
}));

vi.mock('../job-logger.js', () => ({
  logJobStarted: vi.fn().mockResolvedValue(1),
  logJobCompleted: vi.fn().mockResolvedValue(undefined),
  logJobFailed: vi.fn().mockResolvedValue(undefined),
}));

const { createFleetBillingFanoutWorker } = await import('../fleet-billing-fanout-worker.js');

const job = { fleetId: 'flt_A', enabled: true, changedAt: '2026-10-07T12:00:00.000Z' };
beforeEach(() => {
  vi.clearAllMocks();
});

function makeLockRedis(setResults: Array<string | null> = []) {
  const set = vi.fn();
  for (const r of setResults) set.mockResolvedValueOnce(r);
  set.mockResolvedValue('OK');
  return { set, eval: vi.fn().mockResolvedValue(1) };
}

describe('fleet billing fan-out worker', () => {
  it('runs the fan-out for the job under the per-fleet lock', async () => {
    mockRun.mockResolvedValue({ members: 2, notified: 1 });
    const lockRedis = makeLockRedis();
    createFleetBillingFanoutWorker({}, lockRedis as never);
    await capturedProcessor?.({ name: 'fleet-billing-fanout', data: job } as unknown as Job);
    expect(mockRun).toHaveBeenCalledWith('client', job, mockLog);
    expect(lockRedis.set).toHaveBeenCalledWith(
      `wkl:fleet-billing:${job.fleetId}`,
      expect.any(String),
      'PX',
      60000,
      'NX',
    );
    // Released after the run, with the owner token.
    const token = lockRedis.set.mock.calls[0]?.[1] as string;
    expect(lockRedis.eval.mock.calls.at(-1)?.slice(1)).toEqual([
      1,
      `wkl:fleet-billing:${job.fleetId}`,
      token,
    ]);
  });

  it('waits while another replica runs a fan-out of the same fleet', async () => {
    vi.useFakeTimers();
    try {
      mockRun.mockReset();
      mockRun.mockResolvedValue({ members: 1, notified: 1 });
      const lockRedis = makeLockRedis([null]);
      createFleetBillingFanoutWorker({}, lockRedis as never);
      const done = capturedProcessor?.({
        name: 'fleet-billing-fanout',
        data: job,
      } as unknown as Job);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(mockRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the job when the member list cannot be read and releases the lock', async () => {
    mockRun.mockRejectedValue(new Error('db down'));
    const lockRedis = makeLockRedis();
    createFleetBillingFanoutWorker({}, lockRedis as never);
    await expect(
      capturedProcessor?.({ name: 'fleet-billing-fanout', data: job } as unknown as Job),
    ).rejects.toThrow('db down');
    expect(lockRedis.eval).toHaveBeenCalled();
  });

  it('builds the lock key from the fleet id', async () => {
    const { fleetBillingFanoutLockKey } = await import('../fleet-billing-fanout-worker.js');
    expect(fleetBillingFanoutLockKey('flt_abc')).toBe('wkl:fleet-billing:flt_abc');
  });
});
