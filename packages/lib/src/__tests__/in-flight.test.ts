// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { createInFlightTracker } from '../in-flight.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createInFlightTracker', () => {
  it('drains at once when empty', async () => {
    const tracker = createInFlightTracker();
    await expect(tracker.drain(10)).resolves.toBe(true);
  });

  it('returns the tracked promise and releases it when it settles', async () => {
    const tracker = createInFlightTracker();
    const work = deferred();
    const tracked = tracker.track(work.promise);
    expect(tracked).toBe(work.promise);
    expect(tracker.size()).toBe(1);
    work.resolve();
    await tracked;
    expect(tracker.size()).toBe(0);
  });

  it('releases rejected work without an unhandled rejection', async () => {
    const tracker = createInFlightTracker();
    const work = deferred();
    const tracked = tracker.track(work.promise);
    work.reject(new Error('boom'));
    await expect(tracked).rejects.toThrow('boom');
    await expect(tracker.drain(100)).resolves.toBe(true);
  });

  it('waits for work tracked while draining', async () => {
    const tracker = createInFlightTracker();
    const first = deferred();
    const second = deferred();
    void tracker.track(
      first.promise.then(() => {
        void tracker.track(second.promise);
      }),
    );
    let drained = false;
    const draining = tracker.drain(1000).then((result) => {
      drained = true;
      return result;
    });
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    second.resolve();
    await expect(draining).resolves.toBe(true);
  });

  it('resolves false after the timeout when work is still running', async () => {
    const tracker = createInFlightTracker();
    const work = deferred();
    void tracker.track(work.promise);
    const started = Date.now();
    await expect(tracker.drain(30)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(tracker.size()).toBe(1);
    work.resolve();
  });
});
