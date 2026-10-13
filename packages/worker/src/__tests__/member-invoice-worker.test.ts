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
  memberInvoiceJobId: (fleetId: string, driverId: string, period: string, batchId?: string) =>
    `member-invoice.${fleetId}.${driverId}.${period}${batchId == null ? '' : `.${batchId}`}`,
  runMemberInvoiceJob: (...args: unknown[]) => mockRun(...args) as unknown,
  recordMemberInvoiceRunFailure: (...args: unknown[]) => mockRecord(...args) as unknown,
  // fleet-invoice-worker (isFinalFailure) imports these.
  fleetInvoiceJobId: vi.fn(),
  runScheduledFleetInvoice: vi.fn(),
  recordFleetInvoiceRunFailure: vi.fn(),
}));

vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/templates'] }));

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
let capturedFailed: ((job: Job | undefined, err: Error) => void) | undefined;
let capturedQueue: string | undefined;
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown, name: string, processor: (job: Job) => Promise<void>) {
    capturedQueue = name;
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
  createMemberInvoiceWorker,
  enqueueMemberInvoice,
  handleMemberInvoiceJobFailed,
  setMemberInvoiceQueue,
} = await import('../member-invoice-worker.js');
const { logJobFailed } = await import('../job-logger.js');

const data = { fleetId: 'flt_1', driverId: 'drv_1', period: '2026-09' };

beforeEach(() => {
  vi.clearAllMocks();
  setMemberInvoiceQueue(null);
  mockRecord.mockResolvedValue('not_invoiced');
});

describe('enqueueMemberInvoice', () => {
  it('adds the scheduled job under the id per fleet, driver and month', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    setMemberInvoiceQueue({ add } as unknown as Queue);
    await enqueueMemberInvoice(data);
    expect(add).toHaveBeenCalledWith('member-invoice', data, {
      jobId: 'member-invoice.flt_1.drv_1.2026-09',
    });
  });

  it('adds a batch job under an id that names the batch', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    setMemberInvoiceQueue({ add } as unknown as Queue);
    await enqueueMemberInvoice({ ...data, batchId: 'b1' });
    expect(add).toHaveBeenCalledWith('member-invoice', expect.anything(), {
      jobId: 'member-invoice.flt_1.drv_1.2026-09.b1',
    });
  });

  it('throws when the queue is not bound', async () => {
    await expect(enqueueMemberInvoice(data)).rejects.toThrow('Member invoice queue is not set');
  });
});

describe('createMemberInvoiceWorker', () => {
  it('runs the member invoice job on the member-invoices queue', async () => {
    createMemberInvoiceWorker({});
    expect(capturedQueue).toBe('member-invoices');
    mockRun.mockResolvedValue({ status: 'nothing_to_bill' });
    await capturedProcessor?.({ name: 'member-invoice', data } as Job);
    expect(mockRun).toHaveBeenCalledWith(data, { templatesDirs: ['/templates'] }, mockLog);
  });

  it('logs a failed run and rethrows so BullMQ retries', async () => {
    createMemberInvoiceWorker({});
    mockRun.mockRejectedValue(new Error('db down'));
    await expect(capturedProcessor?.({ name: 'member-invoice', data } as Job)).rejects.toThrow(
      'db down',
    );
    expect(logJobFailed).toHaveBeenCalledWith(1, expect.any(Number), 'db down');
  });

  it('records the failure from the failed event of the last attempt', async () => {
    createMemberInvoiceWorker({});
    capturedFailed?.(
      { data, attemptsMade: 6, opts: { attempts: 6 }, finishedOn: 1 } as unknown as Job,
      new Error('db down'),
    );
    await vi.waitFor(() => {
      expect(mockRecord).toHaveBeenCalledWith('flt_1', 'drv_1', '2026-09', 'db down', mockLog);
    });
  });
});

describe('handleMemberInvoiceJobFailed', () => {
  it('only warns while attempts remain', async () => {
    await handleMemberInvoiceJobFailed(
      { data, attemptsMade: 1, opts: { attempts: 6 } },
      new Error('db down'),
      mockLog,
    );
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('records a job that stalled past the limit with attempts left', async () => {
    await handleMemberInvoiceJobFailed(
      { data, attemptsMade: 2, opts: { attempts: 6 }, finishedOn: Date.now() },
      new Error('job stalled more than allowable limit'),
      mockLog,
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalled();
  });
});
