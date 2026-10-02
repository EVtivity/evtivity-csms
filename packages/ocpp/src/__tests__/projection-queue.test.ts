// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { EventBus } from '@evtivity/lib';
import { projectionQueueFor } from '../server/projection-queue.js';

function makeBus(): EventBus {
  return { publish: vi.fn(), subscribe: vi.fn() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('projectionQueueFor', () => {
  it('returns one queue per event bus', () => {
    const bus = makeBus();
    expect(projectionQueueFor(bus)).toBe(projectionQueueFor(bus));
    expect(projectionQueueFor(makeBus())).not.toBe(projectionQueueFor(bus));
  });

  it('runs work for one aggregate in order', async () => {
    const queue = projectionQueueFor(makeBus());
    const order: string[] = [];
    const first = deferred();
    void queue.enqueue('tx-1', async () => {
      await first.promise;
      order.push('first');
    });
    const second = queue.enqueue('tx-1', () => {
      order.push('second');
      return Promise.resolve();
    });
    first.resolve();
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps running after a failed item', async () => {
    const queue = projectionQueueFor(makeBus());
    queue.enqueue('tx-1', () => Promise.reject(new Error('boom'))).catch(() => undefined);
    const ran = vi.fn(() => Promise.resolve());
    await queue.enqueue('tx-1', ran);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('settles at once when nothing is queued', async () => {
    const queue = projectionQueueFor(makeBus());
    await expect(queue.settled(['tx-1', 'CS-1'], 100)).resolves.toBe(true);
  });

  it('waits for queued work, including work queued while waiting', async () => {
    const queue = projectionQueueFor(makeBus());
    const started = deferred();
    const buffered = deferred();
    let bufferedDone = false;
    void queue.enqueue('tx-1', async () => {
      await started.promise;
      // A drained transaction buffer re-publishes onto the station lane.
      void queue.enqueue('CS-1', async () => {
        await buffered.promise;
        bufferedDone = true;
      });
    });

    const settled = queue.settled(['tx-1', 'CS-1'], 1000);
    started.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    buffered.resolve();
    await expect(settled).resolves.toBe(true);
    expect(bufferedDone).toBe(true);
  });

  it('settles after a failed item', async () => {
    const queue = projectionQueueFor(makeBus());
    queue.enqueue('tx-1', () => Promise.reject(new Error('boom'))).catch(() => undefined);
    await expect(queue.settled(['tx-1'], 100)).resolves.toBe(true);
  });

  it('resolves a signal wait when the signal fires, before or after the wait starts', async () => {
    const queue = projectionQueueFor(makeBus());
    const waiting = queue.waitForSignal('session-priced:CS-1:tx-1', 1000);
    queue.signal('session-priced:CS-1:tx-1');
    await expect(waiting).resolves.toBe(true);
    await expect(queue.waitForSignal('session-priced:CS-1:tx-1', 10)).resolves.toBe(true);
  });

  it('returns false when a signal does not fire in time', async () => {
    const queue = projectionQueueFor(makeBus());
    await expect(queue.waitForSignal('session-priced:CS-1:tx-2', 20)).resolves.toBe(false);
  });

  it('returns false when the work does not finish in time', async () => {
    const queue = projectionQueueFor(makeBus());
    const stuck = deferred();
    void queue.enqueue('tx-1', () => stuck.promise);
    await expect(queue.settled(['tx-1'], 20)).resolves.toBe(false);
    stuck.resolve();
  });
});
