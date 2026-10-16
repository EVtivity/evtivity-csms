// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
mockLog.child.mockReturnValue(mockLog);
vi.mock('@evtivity/lib', () => ({ createLogger: vi.fn(() => mockLog) }));
vi.mock('@evtivity/database', () => ({ client: 'sql-client' }));

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
vi.mock('@evtivity/services/refused-start-stop', () => ({
  REFUSED_START_STOP_JOB: 'refused-start-stop',
  runRefusedStartStop: (...args: unknown[]) => mockRun(...args),
}));

const { createPaymentStopWorker } = await import('../payment-stop-worker.js');

const pubsub = { publish: vi.fn() } as unknown as PubSubClient;
const target = {
  sessionId: 'sess-1',
  transactionId: '5001',
  ocppStationId: 'KEBA-1',
  stationDbId: 'station-uuid',
};

function processor(): (job: Job) => Promise<void> {
  if (capturedProcessor == null) throw new Error('worker not created');
  return capturedProcessor;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.child.mockReturnValue(mockLog);
  workerCtorCalls.length = 0;
  mockRun.mockResolvedValue('stopped');
});

describe('createPaymentStopWorker', () => {
  it('runs the refused start stop of the payment-stops queue', async () => {
    createPaymentStopWorker({}, pubsub);
    expect(workerCtorCalls).toEqual(['payment-stops']);
    await processor()({ id: 'j1', name: 'refused-start-stop', data: target } as unknown as Job);
    expect(mockRun).toHaveBeenCalledWith({ sql: 'sql-client', pubsub, logger: mockLog }, target);
  });

  it('drops an unknown job name without running a stop', async () => {
    createPaymentStopWorker({}, pubsub);
    await processor()({ id: 'j2', name: 'other', data: target } as unknown as Job);
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('rethrows a failed stop so the queue retries it', async () => {
    createPaymentStopWorker({}, pubsub);
    mockRun.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      processor()({ id: 'j3', name: 'refused-start-stop', data: target } as unknown as Job),
    ).rejects.toThrow('redis down');
  });
});
