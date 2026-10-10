// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: vi.fn(() => mockLog),
}));

vi.mock('@evtivity/database', () => ({ client: 'client' }));

const mockRun = vi.fn();
vi.mock('@evtivity/services/fleet-billing-notice', () => ({
  FLEET_BILLING_FANOUT_CHANNEL: 'fleet_billing_fanout',
  fleetBillingFanoutJobId: (job: { fleetId: string; enabled: boolean; changedAt: string }) =>
    `fbf.${job.fleetId}.${job.enabled ? 'on' : 'off'}.${String(Date.parse(job.changedAt))}`,
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

const { startFleetBillingFanoutBridge, createFleetBillingFanoutWorker } =
  await import('../fleet-billing-fanout-worker.js');

const job = { fleetId: 'flt_A', enabled: true, changedAt: '2026-10-07T12:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
});

async function bridge(): Promise<{
  deliver: (payload: string) => void;
  add: ReturnType<typeof vi.fn>;
}> {
  let handler: ((payload: string) => void) | undefined;
  const pubsub = {
    subscribe: vi.fn((_channel: string, h: (payload: string) => void) => {
      handler = h;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    }),
  } as unknown as PubSubClient;
  const add = vi.fn().mockResolvedValue(undefined);
  await startFleetBillingFanoutBridge(pubsub, { add } as unknown as Queue);
  return { deliver: (payload) => handler?.(payload), add };
}

describe('fleet billing fan-out bridge', () => {
  it('enqueues one job per fleet and change with the deterministic job id', async () => {
    const { deliver, add } = await bridge();
    deliver(JSON.stringify(job));
    expect(add).toHaveBeenCalledWith('fleet-billing-fanout', job, {
      jobId: `fbf.flt_A.on.${String(Date.parse(job.changedAt))}`,
    });
  });

  it('ignores a malformed or invalid payload', async () => {
    const { deliver, add } = await bridge();
    deliver('not json');
    deliver(JSON.stringify({ fleetId: 'flt_A' }));
    expect(add).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });
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
