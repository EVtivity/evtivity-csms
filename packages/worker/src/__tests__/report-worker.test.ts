// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@evtivity/lib', () => ({ createLogger: vi.fn(() => mockLog) }));

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock('@evtivity/services/report.service', () => ({
  REPORT_GENERATE_CHANNEL: 'report_generate',
  generateReport: mockGenerate,
  reportJobId: (id: string) => `report-${id}`,
}));

interface BullState {
  processor?: (job: Job) => Promise<void>;
  name: string;
  opts: Record<string, unknown>;
  onFailed?: (job: Job | undefined, err: Error) => void;
}
const bull = vi.hoisted((): BullState => ({ name: '', opts: {} }));
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (
    this: unknown,
    name: string,
    processor: (job: Job) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    bull.processor = processor;
    bull.name = name;
    bull.opts = opts;
    return {
      on: (event: string, handler: (job: Job | undefined, err: Error) => void) => {
        if (event === 'failed') bull.onFailed = handler;
      },
    };
  }),
}));

const { mockStarted, mockCompleted, mockFailed } = vi.hoisted(() => ({
  mockStarted: vi.fn(),
  mockCompleted: vi.fn(),
  mockFailed: vi.fn(),
}));
vi.mock('../job-logger.js', () => ({
  logJobStarted: mockStarted,
  logJobCompleted: mockCompleted,
  logJobFailed: mockFailed,
}));

import {
  createReportWorker,
  enqueueReport,
  setReportQueue,
  startReportBridge,
} from '../report-worker.js';

function bridgeWith(): {
  deliver: (payload: string) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  start: () => Promise<() => Promise<void>>;
} {
  let callback: ((payload: string) => void) | undefined;
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const pubsub = {
    subscribe: vi.fn((channel: string, cb: (payload: string) => void) => {
      expect(channel).toBe('report_generate');
      callback = cb;
      return Promise.resolve({ unsubscribe });
    }),
  } as unknown as PubSubClient;
  return {
    deliver: (payload) => callback?.(payload),
    unsubscribe,
    start: () => startReportBridge(pubsub),
  };
}

const add = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue(undefined);
  setReportQueue({ add } as unknown as Queue);
  mockStarted.mockResolvedValue(7);
  mockCompleted.mockResolvedValue(undefined);
  mockFailed.mockResolvedValue(undefined);
});

describe('enqueueReport', () => {
  it('adds one job per report under its job id', async () => {
    await enqueueReport('rpt_1');
    expect(add).toHaveBeenCalledWith(
      'report-generate',
      { reportId: 'rpt_1' },
      { jobId: 'report-rpt_1' },
    );
  });
});

describe('startReportBridge', () => {
  it('queues each announced report', async () => {
    const bridge = bridgeWith();
    await bridge.start();
    bridge.deliver(JSON.stringify({ reportId: 'rpt_2' }));

    expect(add).toHaveBeenCalledWith(
      'report-generate',
      { reportId: 'rpt_2' },
      { jobId: 'report-rpt_2' },
    );
  });

  it('drops a malformed message', async () => {
    const bridge = bridgeWith();
    await bridge.start();
    bridge.deliver('not json');
    bridge.deliver(JSON.stringify({ reportId: '' }));

    expect(add).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });

  it('logs a failed enqueue', async () => {
    add.mockRejectedValueOnce(new Error('redis down'));
    const bridge = bridgeWith();
    await bridge.start();
    bridge.deliver(JSON.stringify({ reportId: 'rpt_3' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'rpt_3' }),
      'Failed to queue report generation',
    );
  });

  it('unsubscribes on stop', async () => {
    const bridge = bridgeWith();
    const stop = await bridge.start();
    await stop();
    expect(bridge.unsubscribe).toHaveBeenCalled();
  });
});

describe('createReportWorker', () => {
  const job = { id: 'report-rpt_1', name: 'report-generate' };

  it('generates one report at a time on the reports queue and logs the job', async () => {
    createReportWorker({ host: 'localhost' });
    expect(bull.name).toBe('reports');
    expect(bull.opts['concurrency']).toBe(1);
    mockGenerate.mockResolvedValueOnce(undefined);

    await bull.processor?.({ ...job, data: { reportId: 'rpt_1' } } as Job);

    expect(mockGenerate).toHaveBeenCalledWith('rpt_1');
    expect(mockStarted).toHaveBeenCalledWith('report-generate', 'reports');
    expect(mockCompleted).toHaveBeenCalledWith(7, expect.any(Number));
  });

  it('records the failure and rethrows', async () => {
    createReportWorker({ host: 'localhost' });
    mockGenerate.mockRejectedValueOnce(new Error('db down'));
    mockFailed.mockRejectedValueOnce(new Error('log table down'));

    await expect(bull.processor?.({ ...job, data: { reportId: 'rpt_1' } } as Job)).rejects.toThrow(
      'db down',
    );
    expect(mockFailed).toHaveBeenCalledWith(7, expect.any(Number), 'db down');
    expect(mockLog.warn).toHaveBeenCalled();

    bull.onFailed?.(job as Job, new Error('db down'));
    bull.onFailed?.(undefined, new Error('ignored'));
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
