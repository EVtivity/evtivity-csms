// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PubSubClient } from '@evtivity/lib';

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
    parseStationRefreshPayload: actual.parseStationRefreshPayload,
    parseStationTransactionPayload: actual.parseStationTransactionPayload,
    STATION_MESSAGE_REFRESH_CHANNEL: 'station_message_refresh',
    STATION_MESSAGE_REPUSH_CHANNEL: 'station_message_repush',
    STATION_MESSAGE_TRANSACTION_CHANNEL: 'station_message_transaction',
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

function makeBridgeDeps(): {
  pubsub: PubSubClient;
  queue: Queue;
  add: ReturnType<typeof vi.fn>;
  deliver: (channel: string, payload: string) => void;
} {
  const handlers = new Map<string, (payload: string) => void>();
  const pubsub = {
    subscribe: vi.fn((channel: string, h: (payload: string) => void) => {
      handlers.set(channel, h);
      return Promise.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
    }),
  } as unknown as PubSubClient;
  const add = vi.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as Queue;
  return {
    pubsub,
    queue,
    add,
    deliver: (channel, payload) => {
      handlers.get(channel)?.(payload);
    },
  };
}

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

beforeEach(() => {
  capturedProcessor = undefined;
  workerCtorCalls.length = 0;
  vi.clearAllMocks();
  mockPushAll.mockResolvedValue(undefined);
  mockLogJobStarted.mockResolvedValue(7);
});

describe('startStationMessageBridge', () => {
  it('enqueues one debounced repush job per scope', async () => {
    const { startStationMessageBridge, STATION_MESSAGE_REPUSH_DEBOUNCE_MS } =
      await import('../station-message-worker.js');
    const deps = makeBridgeDeps();
    await startStationMessageBridge(deps.pubsub, deps.queue);

    deps.deliver('station_message_repush', JSON.stringify({}));
    deps.deliver('station_message_repush', JSON.stringify({ siteId: 'sit_1' }));
    deps.deliver('station_message_repush', JSON.stringify({ stationId: 'sta_1' }));
    deps.deliver('station_message_repush', JSON.stringify({ pricingGroupId: 'pg_1' }));
    deps.deliver('station_message_repush', JSON.stringify({ siteId: 42 }));

    expect(deps.add).toHaveBeenNthCalledWith(
      1,
      'station-message-repush',
      {},
      {
        delay: STATION_MESSAGE_REPUSH_DEBOUNCE_MS,
        deduplication: {
          id: 'smr.all',
          ttl: STATION_MESSAGE_REPUSH_DEBOUNCE_MS,
          extend: true,
          replace: true,
        },
      },
    );
    const ids = deps.add.mock.calls.map(
      (c) => (c[2] as { deduplication: { id: string } }).deduplication.id,
    );
    expect(ids).toEqual([
      'smr.all',
      'smr.site.sit_1',
      'smr.station.sta_1',
      'smr.group.pg_1',
      'smr.all',
    ]);
  });

  it('turns a station event into one debounced refresh job per station', async () => {
    const { startStationMessageBridge, STATION_MESSAGE_EVENT_DEBOUNCE_MS } =
      await import('../station-message-worker.js');
    const deps = makeBridgeDeps();
    await startStationMessageBridge(deps.pubsub, deps.queue);

    // Two replicas bridge the same message: both adds carry the same id.
    deps.deliver('station_message_refresh', JSON.stringify(REFRESH));
    deps.deliver('station_message_refresh', JSON.stringify(REFRESH));

    expect(deps.add).toHaveBeenCalledTimes(2);
    for (const call of deps.add.mock.calls) {
      expect(call).toEqual([
        'station-message-refresh',
        REFRESH,
        {
          delay: STATION_MESSAGE_EVENT_DEBOUNCE_MS,
          deduplication: {
            id: 'smf.sta_1',
            ttl: STATION_MESSAGE_EVENT_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
        },
      ]);
    }
  });

  it('turns a session event into one debounced transaction job per session', async () => {
    const { startStationMessageBridge } = await import('../station-message-worker.js');
    const deps = makeBridgeDeps();
    await startStationMessageBridge(deps.pubsub, deps.queue);

    deps.deliver('station_message_transaction', JSON.stringify(TRANSACTION));
    deps.deliver(
      'station_message_transaction',
      JSON.stringify({ ...TRANSACTION, eventType: 'ended', chargingState: undefined }),
    );

    const ids = deps.add.mock.calls.map(
      (c) => (c[2] as { deduplication: { id: string } }).deduplication.id,
    );
    expect(ids).toEqual(['smt.ses_1', 'smt.ses_1']);
    expect(deps.add.mock.calls[1]?.[1]).toMatchObject({ eventType: 'ended' });
  });

  it('drops malformed payloads with a warning', async () => {
    const { startStationMessageBridge } = await import('../station-message-worker.js');
    const deps = makeBridgeDeps();
    await startStationMessageBridge(deps.pubsub, deps.queue);

    deps.deliver('station_message_repush', 'not json');
    deps.deliver('station_message_refresh', JSON.stringify({ stationOcppId: 'CS-1' }));
    deps.deliver('station_message_transaction', JSON.stringify({ sessionId: 'ses_1' }));

    expect(deps.add).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(3);
  });
});

describe('createStationMessageWorker', () => {
  async function processor(): Promise<(job: Job) => Promise<void>> {
    const { createStationMessageWorker } = await import('../station-message-worker.js');
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
