// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('@evtivity/lib', () => ({ createLogger: vi.fn(() => mockLog) }));

vi.mock('@evtivity/database', () => ({ REMOTE_START_TIMEOUT_CHANNEL: 'remote_start_timeout' }));

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

const { mockHandle, mockStarted, mockCompleted, mockFailed } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockStarted: vi.fn(),
  mockCompleted: vi.fn(),
  mockFailed: vi.fn(),
}));
vi.mock('../handlers/remote-start-timeout.js', () => ({ handleRemoteStartTimeout: mockHandle }));
vi.mock('../job-logger.js', () => ({
  logJobStarted: mockStarted,
  logJobCompleted: mockCompleted,
  logJobFailed: mockFailed,
}));

import {
  createRemoteStartTimeoutWorker,
  remoteStartTimeoutJobId,
  startRemoteStartTimeoutBridge,
} from '../remote-start-timeout-worker.js';

function bridgeWith(): {
  deliver: (payload: string) => void;
  add: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  start: () => Promise<() => Promise<void>>;
} {
  let callback: ((payload: string) => void) | undefined;
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const pubsub = {
    subscribe: vi.fn((channel: string, cb: (payload: string) => void) => {
      expect(channel).toBe('remote_start_timeout');
      callback = cb;
      return Promise.resolve({ unsubscribe });
    }),
  } as unknown as PubSubClient;
  const add = vi.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as Queue;
  return {
    deliver: (payload) => callback?.(payload),
    add,
    unsubscribe,
    start: () => startRemoteStartTimeoutBridge(pubsub, queue),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.child.mockReturnValue(mockLog);
  mockStarted.mockResolvedValue(11);
  mockCompleted.mockResolvedValue(undefined);
  mockFailed.mockResolvedValue(undefined);
});

describe('remoteStartTimeoutJobId', () => {
  it('is deterministic per driver session and per guest session', () => {
    expect(remoteStartTimeoutJobId({ kind: 'session', sessionId: 'ses_1' })).toBe(
      'remote-start-timeout-session-ses_1',
    );
    expect(remoteStartTimeoutJobId({ kind: 'guest', guestSessionId: 301 })).toBe(
      'remote-start-timeout-guest-301',
    );
  });
});

describe('startRemoteStartTimeoutBridge', () => {
  it('enqueues a delayed job under the deterministic id', async () => {
    const bridge = bridgeWith();
    await bridge.start();
    bridge.deliver(JSON.stringify({ kind: 'session', sessionId: 'ses_1', delayMs: 240_000 }));
    bridge.deliver(JSON.stringify({ kind: 'guest', guestSessionId: 301, delayMs: 120_000 }));

    expect(bridge.add).toHaveBeenNthCalledWith(
      1,
      'remote-start-timeout',
      { kind: 'session', sessionId: 'ses_1' },
      { jobId: 'remote-start-timeout-session-ses_1', delay: 240_000 },
    );
    expect(bridge.add).toHaveBeenNthCalledWith(
      2,
      'remote-start-timeout',
      { kind: 'guest', guestSessionId: 301 },
      { jobId: 'remote-start-timeout-guest-301', delay: 120_000 },
    );
  });

  it('drops a malformed message', async () => {
    const bridge = bridgeWith();
    await bridge.start();
    bridge.deliver('not json');
    bridge.deliver(JSON.stringify({ kind: 'session', delayMs: 1 }));
    bridge.deliver(JSON.stringify({ kind: 'guest', guestSessionId: 1, delayMs: -5 }));

    expect(bridge.add).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(3);
  });

  it('logs a failed enqueue', async () => {
    const bridge = bridgeWith();
    bridge.add.mockRejectedValueOnce(new Error('redis down'));
    await bridge.start();
    bridge.deliver(JSON.stringify({ kind: 'session', sessionId: 'ses_2', delayMs: 0 }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'session', sessionId: 'ses_2' } }),
      'Failed to enqueue remote start timeout job',
    );
  });

  it('unsubscribes on stop', async () => {
    const bridge = bridgeWith();
    const stop = await bridge.start();
    await stop();
    expect(bridge.unsubscribe).toHaveBeenCalled();
  });
});

describe('createRemoteStartTimeoutWorker', () => {
  const pubsub = { publish: vi.fn() } as unknown as PubSubClient;
  const job = { id: 'remote-start-timeout-session-ses_1', name: 'remote-start-timeout' };

  it('runs the handler on the remote-start-timeouts queue and logs the job', async () => {
    createRemoteStartTimeoutWorker({ host: 'localhost' }, pubsub);
    expect(bull.name).toBe('remote-start-timeouts');
    expect(bull.opts['concurrency']).toBe(5);
    mockHandle.mockResolvedValueOnce(undefined);

    await bull.processor?.({ ...job, data: { kind: 'session', sessionId: 'ses_1' } } as Job);

    expect(mockHandle).toHaveBeenCalledWith(
      { kind: 'session', sessionId: 'ses_1' },
      mockLog,
      pubsub,
    );
    expect(mockStarted).toHaveBeenCalledWith('remote-start-timeout', 'remote-start-timeouts');
    expect(mockCompleted).toHaveBeenCalledWith(11, expect.any(Number));
  });

  it('records the failure and rethrows for a retry', async () => {
    createRemoteStartTimeoutWorker({ host: 'localhost' }, pubsub);
    mockHandle.mockRejectedValueOnce(new Error('provider timeout'));
    mockFailed.mockRejectedValueOnce(new Error('log table down'));

    await expect(
      bull.processor?.({ ...job, data: { kind: 'session', sessionId: 'ses_1' } } as Job),
    ).rejects.toThrow('provider timeout');
    expect(mockFailed).toHaveBeenCalledWith(11, expect.any(Number), 'provider timeout');
    expect(mockLog.warn).toHaveBeenCalled();

    bull.onFailed?.(job as Job, new Error('provider timeout'));
    bull.onFailed?.(undefined, new Error('ignored'));
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
