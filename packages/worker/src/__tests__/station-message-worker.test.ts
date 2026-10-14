// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
const mockWithLock = vi.fn(
  async (_redis: unknown, _key: string, fn: () => Promise<unknown>, _opts: unknown) => ({
    acquired: true,
    result: await fn(),
  }),
);
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLog),
    withLock: (...args: Parameters<typeof mockWithLock>) => mockWithLock(...args),
  };
});

const mockPushAll = vi.fn().mockResolvedValue(undefined);
const mockRunRefresh = vi.fn().mockResolvedValue(undefined);
const mockRunTransaction = vi.fn().mockResolvedValue(undefined);
const mockRunStationRender = vi.fn((_id: string, fn: () => Promise<void>) => fn());
vi.mock('@evtivity/services/station-message.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@evtivity/services/station-message.service')>();
  return {
    STATION_MESSAGE_JOBS: actual.STATION_MESSAGE_JOBS,
    pushAllMessagesToAllStations: (...args: unknown[]) => mockPushAll(...args),
    runStationRefresh: (...args: unknown[]) => mockRunRefresh(...args),
    runStationTransaction: (...args: unknown[]) => mockRunTransaction(...args),
    runStationRender: (id: string, fn: () => Promise<void>) => mockRunStationRender(id, fn),
  };
});

let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
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
    return { on: vi.fn() };
  }),
}));

const mockLogJobStarted = vi.fn().mockResolvedValue(7);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

const lockRedis = {} as Redis;

const REFRESH = {
  stationOcppId: 'CS-1',
  internalStationId: 'sta_1',
  ocppProtocol: 'ocpp1.6',
};

const TRANSACTION = {
  sessionId: 'ses_1',
  internalStationId: 'sta_1',
  stationOcppId: 'CS-1',
  ocppProtocol: 'ocpp2.1',
  eventType: 'updated',
  chargingState: 'Charging',
};

// The module is imported after the mocks above are initialized. The first import loads
// the whole worker graph, which can take longer than one test's 5 s timeout on a busy
// machine, so it happens once here with its own timeout instead of inside the first test.
let mod: typeof import('../station-message-worker.js');
beforeAll(async () => {
  mod = await import('../station-message-worker.js');
}, 30_000);

beforeEach(() => {
  capturedProcessor = undefined;
  workerCtorCalls.length = 0;
  vi.clearAllMocks();
  mockPushAll.mockResolvedValue(undefined);
  mockLogJobStarted.mockResolvedValue(7);
});

describe('createStationMessageWorker', () => {
  async function processor(): Promise<(job: Job) => Promise<void>> {
    const { createStationMessageWorker } = mod;
    createStationMessageWorker({}, lockRedis);
    if (capturedProcessor == null) throw new Error('no processor');
    return capturedProcessor;
  }

  it('runs on the station-messages queue with parallel jobs', async () => {
    await processor();
    expect(workerCtorCalls[0]?.name).toBe('station-messages');
    expect(workerCtorCalls[0]?.opts['concurrency']).toBe(10);
  });

  it('runs a refresh under the per-station lock', async () => {
    const run = await processor();
    await run({ name: 'station-message-refresh', data: REFRESH } as unknown as Job);

    expect(mockRunRefresh).toHaveBeenCalledWith(REFRESH, mockLog, expect.any(Function));
    const render = mockRunRefresh.mock.calls[0]?.[2] as (
      id: string,
      fn: () => Promise<void>,
    ) => Promise<void>;
    const fn = vi.fn().mockResolvedValue(undefined);
    await render('sta_1', fn);
    expect(mockWithLock).toHaveBeenCalledWith(
      lockRedis,
      'sml:sta_1',
      expect.any(Function),
      expect.objectContaining({ ttlMs: 30_000 }),
    );
    expect(mockRunStationRender).toHaveBeenCalledWith('sta_1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs a transaction job', async () => {
    const run = await processor();
    await run({ name: 'station-message-transaction', data: TRANSACTION } as unknown as Job);
    expect(mockRunTransaction).toHaveBeenCalledWith(TRANSACTION, mockLog, expect.any(Function));
  });

  it('runs a repush for the requested scope and logs the job', async () => {
    const run = await processor();
    await run({ name: 'station-message-repush', data: { siteId: 'sit_1' } } as unknown as Job);

    expect(mockPushAll).toHaveBeenCalledWith(mockLog, { siteId: 'sit_1' }, expect.any(Function));
    expect(mockLogJobCompleted).toHaveBeenCalledWith(7, expect.any(Number));
  });

  it('logs a failed repush and rethrows so BullMQ retries', async () => {
    const run = await processor();
    mockPushAll.mockRejectedValueOnce(new Error('db down'));

    await expect(
      run({ name: 'station-message-repush', data: {} } as unknown as Job),
    ).rejects.toThrow('db down');
    expect(mockLogJobFailed).toHaveBeenCalledWith(7, expect.any(Number), 'db down');
  });

  it('warns on an unknown job name', async () => {
    const run = await processor();
    await run({ name: 'other', data: {} } as unknown as Job);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});
