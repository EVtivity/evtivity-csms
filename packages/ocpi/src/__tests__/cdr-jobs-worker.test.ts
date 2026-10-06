// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// BullMQ is replaced with in-memory fakes that record how the queue, its sweep
// scheduler, and the worker are created, so startOcpiCdrJobs runs offline.
const mocks = vi.hoisted(() => {
  const queues: Array<{
    name: string;
    opts: Record<string, unknown>;
    add: ReturnType<typeof vi.fn>;
    upsertJobScheduler: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = [];
  const workers: Array<{
    name: string;
    processor: (job: unknown) => Promise<void>;
    opts: Record<string, unknown>;
    listeners: Map<string, (...args: unknown[]) => void>;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = [];
  return {
    queues,
    workers,
    pushCdr: vi.fn(),
    isRoamingEnabled: vi.fn(),
    pushLegacyEvseRemoval: vi.fn(),
    issueSessionCdr: vi.fn(),
    createBullMQConnection: vi.fn((url: string) => ({ url })),
  };
});

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    opts: Record<string, unknown>;
    add = vi.fn(async () => undefined);
    upsertJobScheduler = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
      mocks.queues.push(this);
    }
  },
  Worker: class {
    name: string;
    processor: (job: unknown) => Promise<void>;
    opts: Record<string, unknown>;
    listeners = new Map<string, (...args: unknown[]) => void>();
    close = vi.fn(async () => undefined);
    constructor(
      name: string,
      processor: (job: unknown) => Promise<void>,
      opts: Record<string, unknown>,
    ) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      mocks.workers.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners.set(event, fn);
      return this;
    }
  },
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createBullMQConnection: mocks.createBullMQConnection,
  logBullMQErrors: <T>(emitter: T): T => emitter,
}));
vi.mock('@evtivity/database', () => ({
  db: {},
  chargingSessions: {},
  ocpiCdrBackfill: {},
  ocpiCdrs: {},
  ocpiPartnerEndpoints: {},
  ocpiPartners: {},
  ocpiRoamingSessions: {},
  isRoamingEnabled: mocks.isRoamingEnabled,
  pruneRemovedOcpiEvses: vi.fn(async () => undefined),
}));
vi.mock('../services/cdr.service.js', () => ({
  issueSessionCdr: mocks.issueSessionCdr,
  pushCdr: mocks.pushCdr,
}));
vi.mock('../services/push.service.js', () => ({
  pushLegacyEvseRemoval: mocks.pushLegacyEvseRemoval,
}));

const { startOcpiCdrJobs, processOcpiCdrJob, OCPI_CDR_QUEUE } =
  await import('../services/cdr-jobs.js');

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data } as unknown as Job;
}

beforeEach(() => {
  mocks.queues.length = 0;
  mocks.workers.length = 0;
});

describe('startOcpiCdrJobs', () => {
  it('creates the queue with retention, the 5 minute sweep scheduler, and a worker', async () => {
    const jobs = await startOcpiCdrJobs('redis://localhost:6379');

    expect(mocks.queues).toHaveLength(1);
    const queue = mocks.queues[0];
    expect(queue?.name).toBe(OCPI_CDR_QUEUE);
    expect(queue?.opts['defaultJobOptions']).toEqual({
      removeOnComplete: { age: 2 * 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    expect(queue?.upsertJobScheduler).toHaveBeenCalledWith(
      'ocpi-cdr-sweep',
      { every: 300_000 },
      { name: 'cdr-sweep' },
    );
    expect(jobs.queue).toBe(queue);

    expect(mocks.workers).toHaveLength(1);
    expect(mocks.workers[0]?.name).toBe(OCPI_CDR_QUEUE);
    expect(mocks.workers[0]?.opts['concurrency']).toBe(5);
    // The queue and the worker each get their own Redis connection.
    expect(mocks.createBullMQConnection).toHaveBeenCalledTimes(2);
  });

  it('schedules a session CDR on the created queue with a per-session job id', async () => {
    const jobs = await startOcpiCdrJobs('redis://localhost:6379');

    await jobs.scheduleSessionCdr('ses_1');

    expect(mocks.queues[0]?.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_1' },
      expect.objectContaining({ jobId: 'cdr-ses_1' }),
    );
  });

  it('runs jobs through processOcpiCdrJob and logs failures without throwing', async () => {
    await startOcpiCdrJobs('redis://localhost:6379');
    const worker = mocks.workers[0];
    mocks.pushCdr.mockResolvedValueOnce('sent');

    await expect(worker?.processor(job('cdr-push', { cdrId: 'CDR-1' }))).resolves.toBeUndefined();
    expect(mocks.pushCdr).toHaveBeenCalledWith('CDR-1');

    const onFailed = worker?.listeners.get('failed');
    expect(onFailed).toBeTypeOf('function');
    expect(() => onFailed?.(undefined, new Error('x'))).not.toThrow();
  });

  it('stop() closes the worker before the queue', async () => {
    const jobs = await startOcpiCdrJobs('redis://localhost:6379');
    const order: string[] = [];
    mocks.workers[0]?.close.mockImplementation(() => {
      order.push('worker');
      return Promise.resolve();
    });
    mocks.queues[0]?.close.mockImplementation(() => {
      order.push('queue');
      return Promise.resolve();
    });

    await jobs.stop();

    expect(order).toEqual(['worker', 'queue']);
  });
});

describe('processOcpiCdrJob', () => {
  const queue = { add: vi.fn(async () => undefined) };

  it('pushes a stored CDR and throws when the push fails so BullMQ retries', async () => {
    mocks.pushCdr.mockResolvedValueOnce('failed');

    await expect(
      processOcpiCdrJob(job('cdr-push', { cdrId: 'CDR-9' }), queue as never),
    ).rejects.toThrow('CDR CDR-9 push failed');
  });

  it('ignores a cdr-push job without a CDR id', async () => {
    await processOcpiCdrJob(job('cdr-push', {}), queue as never);
    expect(mocks.pushCdr).not.toHaveBeenCalled();
  });

  it('runs the sweep, which stops early while roaming is off', async () => {
    mocks.isRoamingEnabled.mockResolvedValueOnce(false);

    await processOcpiCdrJob(job('cdr-sweep', {}), queue as never);

    expect(mocks.isRoamingEnabled).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores an unknown job name', async () => {
    await expect(
      processOcpiCdrJob(job('something-else', { cdrId: 'x' }), queue as never),
    ).resolves.toBeUndefined();
    expect(mocks.pushCdr).not.toHaveBeenCalled();
    expect(mocks.issueSessionCdr).not.toHaveBeenCalled();
  });
});
