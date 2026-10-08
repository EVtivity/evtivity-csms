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

describe('fleet billing fan-out worker', () => {
  it('runs the fan-out for the job', async () => {
    mockRun.mockResolvedValue({ members: 2, notified: 1 });
    createFleetBillingFanoutWorker({});
    await capturedProcessor?.({ name: 'fleet-billing-fanout', data: job } as unknown as Job);
    expect(mockRun).toHaveBeenCalledWith('client', job, mockLog);
  });

  it('fails the job when the member list cannot be read', async () => {
    mockRun.mockRejectedValue(new Error('db down'));
    createFleetBillingFanoutWorker({});
    await expect(
      capturedProcessor?.({ name: 'fleet-billing-fanout', data: job } as unknown as Job),
    ).rejects.toThrow('db down');
  });
});
