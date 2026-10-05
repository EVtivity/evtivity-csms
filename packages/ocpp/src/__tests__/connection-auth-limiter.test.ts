// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ConnectionAuthBusyError,
  ConnectionAuthLimiter,
  connectionAuthLimitsFromConfig,
  defaultConnectionAuthConcurrency,
} from '../server/connection-auth-limiter.js';

interface Deferred {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve: (value: string) => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionAuthLimiter', () => {
  it('runs up to maxConcurrent tasks and starts queued ones in arrival order', async () => {
    const limiter = new ConnectionAuthLimiter({ maxConcurrent: 2, maxQueued: 10, maxWaitMs: 1000 });
    const tasks = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const results = tasks.map((t, i) =>
      limiter.run(() => {
        started.push(i);
        return t.promise;
      }),
    );

    expect(started).toEqual([0, 1]);
    expect(limiter.stats()).toEqual({ active: 2, queued: 2, maxConcurrent: 2, rejected: 0 });

    tasks[1]?.resolve('b');
    await flush();
    expect(started).toEqual([0, 1, 2]);
    tasks[0]?.resolve('a');
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    tasks[2]?.resolve('c');
    tasks[3]?.resolve('d');

    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(limiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('frees the slot when a task fails and passes the error on', async () => {
    const limiter = new ConnectionAuthLimiter({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: 1000 });
    const failing = limiter.run(() => Promise.reject(new Error('db down')));
    const next = limiter.run(() => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('db down');
    expect(await next).toBe('ok');
    expect(limiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('refuses a request when the queue is full', async () => {
    const limiter = new ConnectionAuthLimiter({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: 1000 });
    const running = deferred();
    const first = limiter.run(() => running.promise);
    const queued = limiter.run(() => Promise.resolve('queued'));

    const refused = limiter.run(() => Promise.resolve('never'));
    await expect(refused).rejects.toBeInstanceOf(ConnectionAuthBusyError);
    await expect(refused).rejects.toMatchObject({ reason: 'queue_full' });
    expect(limiter.stats()).toMatchObject({ active: 1, queued: 1, rejected: 1 });

    running.resolve('first');
    expect(await first).toBe('first');
    expect(await queued).toBe('queued');
  });

  it('refuses a request that waits longer than maxWaitMs and never runs it', async () => {
    vi.useFakeTimers();
    const limiter = new ConnectionAuthLimiter({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: 500 });
    const running = deferred();
    const first = limiter.run(() => running.promise);
    const lateTask = vi.fn(() => Promise.resolve('late'));
    const late = limiter.run(lateTask);
    const lateResult = expect(late).rejects.toMatchObject({ reason: 'wait_timeout' });

    await vi.advanceTimersByTimeAsync(500);
    await lateResult;
    expect(limiter.stats()).toMatchObject({ active: 1, queued: 0, rejected: 1 });

    running.resolve('first');
    expect(await first).toBe('first');
    expect(lateTask).not.toHaveBeenCalled();
  });

  it('defaults to half the database pool, at least one', () => {
    expect(defaultConnectionAuthConcurrency(20)).toBe(10);
    expect(defaultConnectionAuthConcurrency(5)).toBe(2);
    expect(defaultConnectionAuthConcurrency(1)).toBe(1);
  });
});

describe('connectionAuthLimitsFromConfig', () => {
  it('keeps the defaults for unset variables', () => {
    expect(connectionAuthLimitsFromConfig({})).toEqual({});
  });

  it('takes each variable that is set', () => {
    expect(
      connectionAuthLimitsFromConfig({
        OCPP_AUTH_MAX_CONCURRENT: 8,
        OCPP_AUTH_MAX_QUEUED: 0,
        OCPP_AUTH_MAX_WAIT_MS: 5000,
      }),
    ).toEqual({ maxConcurrent: 8, maxQueued: 0, maxWaitMs: 5000 });
    expect(connectionAuthLimitsFromConfig({ OCPP_AUTH_MAX_QUEUED: 50 })).toEqual({
      maxQueued: 50,
    });
  });
});
