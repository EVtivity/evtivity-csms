// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: vi.fn(() => mockLog),
}));

const mockRun = vi.fn();
const mockRecord = vi.fn();
vi.mock('@evtivity/services/fleet-invoice-run', () => ({
  fleetInvoiceJobId: (fleetId: string, period: string) => `fleet-invoice.${fleetId}.${period}`,
  runScheduledFleetInvoice: (...args: unknown[]) => mockRun(...args) as unknown,
  recordFleetInvoiceRunFailure: (...args: unknown[]) => mockRecord(...args) as unknown,
}));

vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/templates'] }));

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
let capturedFailed: ((job: Job | undefined, err: Error) => void) | undefined;
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown, _name: string, processor: (job: Job) => Promise<void>) {
    capturedProcessor = processor;
    return {
      on: vi.fn((event: string, handler: (job: Job | undefined, err: Error) => void) => {
        if (event === 'failed') capturedFailed = handler;
      }),
    };
  }),
}));

vi.mock('../job-logger.js', () => ({
  logJobStarted: vi.fn().mockResolvedValue(1),
  logJobCompleted: vi.fn().mockResolvedValue(undefined),
  logJobFailed: vi.fn().mockResolvedValue(undefined),
}));

const {
  createFleetInvoiceWorker,
  enqueueFleetInvoice,
  handleFleetInvoiceJobFailed,
  isFinalFailure,
  setFleetInvoiceQueue,
} = await import('../fleet-invoice-worker.js');
const { logJobFailed } = await import('../job-logger.js');
const { FLEET_INVOICE_JOB_ATTEMPTS, FLEET_INVOICE_JOB_BACKOFF_MS } = await import('../queues.js');

const data = { fleetId: 'flt_1', period: '2026-09' };

// BullMQ 6 fails a job that stalled more than maxStalledCount times when a
// worker picks it up again: an UnrecoverableError with this message, moved to
// failed with attempts left (Job.moveToFailed sets finishedOn).
function stalledError(): Error {
  const err = new Error('job stalled more than allowable limit');
  err.name = 'UnrecoverableError';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  setFleetInvoiceQueue(null);
  mockRecord.mockResolvedValue('not_invoiced');
});

describe('fleet invoice queue options', () => {
  it('retries 6 times from 5 minutes, about 2.5 hours in all', () => {
    expect(FLEET_INVOICE_JOB_ATTEMPTS).toBe(6);
    expect(FLEET_INVOICE_JOB_BACKOFF_MS).toBe(300_000);
    // Exponential: 5, 10, 20, 40, 80 minutes between the 6 attempts.
    let total = 0;
    for (let retry = 0; retry < FLEET_INVOICE_JOB_ATTEMPTS - 1; retry += 1) {
      total += FLEET_INVOICE_JOB_BACKOFF_MS * 2 ** retry;
    }
    expect(total / 60_000).toBe(155);
  });
});

describe('enqueueFleetInvoice', () => {
  it('adds the job under the deterministic id per fleet and month', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    setFleetInvoiceQueue({ add } as unknown as Queue);
    await enqueueFleetInvoice(data);
    expect(add).toHaveBeenCalledWith('fleet-invoice', data, {
      jobId: 'fleet-invoice.flt_1.2026-09',
    });
  });

  it('throws when the queue is not bound', async () => {
    await expect(enqueueFleetInvoice(data)).rejects.toThrow('Fleet invoice queue is not set');
  });
});

describe('createFleetInvoiceWorker', () => {
  it('runs the scheduled invoice of the job with the template dirs', async () => {
    createFleetInvoiceWorker({});
    mockRun.mockResolvedValue({ status: 'nothing_to_bill' });
    await capturedProcessor?.({ name: 'fleet-invoice', data } as Job);
    expect(mockRun).toHaveBeenCalledWith(
      'flt_1',
      '2026-09',
      { templatesDirs: ['/templates'] },
      mockLog,
    );
  });

  it('records a failed run and rethrows so BullMQ retries', async () => {
    createFleetInvoiceWorker({});
    mockRun.mockRejectedValue(new Error('db down'));
    await expect(capturedProcessor?.({ name: 'fleet-invoice', data } as Job)).rejects.toThrow(
      'db down',
    );
    expect(logJobFailed).toHaveBeenCalledWith(1, expect.any(Number), 'db down');
  });

  it('records the failure from the failed event of the last attempt', async () => {
    createFleetInvoiceWorker({});
    capturedFailed?.(
      { data, attemptsMade: 6, opts: { attempts: 6 }, finishedOn: 1 } as unknown as Job,
      new Error('db down'),
    );
    await vi.waitFor(() => {
      expect(mockRecord).toHaveBeenCalledWith('flt_1', '2026-09', 'db down', mockLog);
    });
  });

  it('records the failure of a job that stalled past the limit', async () => {
    createFleetInvoiceWorker({});
    capturedFailed?.(
      { data, attemptsMade: 1, opts: { attempts: 6 }, finishedOn: 1 } as unknown as Job,
      stalledError(),
    );
    await vi.waitFor(() => {
      expect(mockRecord).toHaveBeenCalledWith(
        'flt_1',
        '2026-09',
        'job stalled more than allowable limit',
        mockLog,
      );
    });
  });
});

describe('handleFleetInvoiceJobFailed', () => {
  it('only warns while attempts remain (BullMQ retries: no finishedOn)', async () => {
    await handleFleetInvoiceJobFailed(
      { data, attemptsMade: 1, opts: { attempts: 6 } },
      new Error('db down'),
      mockLog,
    );
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('records the failure once the attempts are used up', async () => {
    await handleFleetInvoiceJobFailed(
      { data, attemptsMade: 6, opts: { attempts: 6 }, finishedOn: Date.now() },
      new Error('db down'),
      mockLog,
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('records the failure of a job failed for a stall with attempts left', async () => {
    await handleFleetInvoiceJobFailed(
      { data, attemptsMade: 2, opts: { attempts: 6 }, finishedOn: Date.now() },
      stalledError(),
      mockLog,
    );
    expect(mockRecord).toHaveBeenCalledWith(
      'flt_1',
      '2026-09',
      'job stalled more than allowable limit',
      mockLog,
    );
  });
});

describe('isFinalFailure', () => {
  it('is final when BullMQ moved the job to failed (finishedOn set)', () => {
    // Stalled past maxStalledCount: failed with attempts left.
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 6 }, finishedOn: 1 })).toBe(true);
    // Attempts used up.
    expect(isFinalFailure({ attemptsMade: 6, opts: { attempts: 6 }, finishedOn: 1 })).toBe(true);
  });

  it('is not final while BullMQ retries (no finishedOn, attempts left)', () => {
    expect(isFinalFailure({ attemptsMade: 5, opts: { attempts: 6 } })).toBe(false);
  });

  it('treats used attempts as final and a job without attempts as a single attempt', () => {
    expect(isFinalFailure({ attemptsMade: 6, opts: { attempts: 6 } })).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: {} })).toBe(true);
  });
});
