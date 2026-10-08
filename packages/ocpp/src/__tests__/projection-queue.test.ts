// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { DomainEvent, EventBus } from '@evtivity/lib';
import {
  projectionLane,
  projectionQueueFor,
  sessionGatedKey,
  sessionPricedKey,
  transactionKey,
} from '../server/projection-queue.js';

function makeBus(): EventBus {
  return { publish: vi.fn(), subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() };
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

function makeEvent(aggregateType: string, aggregateId: string, stationId: string): DomainEvent {
  return {
    eventType: 'ocpp.TransactionEvent',
    aggregateType,
    aggregateId,
    payload: { stationId, transactionId: aggregateId },
    occurredAt: new Date(),
  };
}

describe('transaction keys', () => {
  it('scopes a transactionId by its station', () => {
    expect(transactionKey('CS-1', 'tx-1')).not.toBe(transactionKey('CS-2', 'tx-1'));
    expect(transactionKey('CS-1', 'tx-1')).toBe(transactionKey('CS-1', 'tx-1'));
  });

  it('never joins two different pairs into one key', () => {
    expect(transactionKey('A:B', 'C')).not.toBe(transactionKey('A', 'B:C'));
    expect(sessionPricedKey('A:B', 'C')).not.toBe(sessionPricedKey('A', 'B:C'));
    expect(sessionPricedKey('CS-1', 'tx-1')).not.toBe(sessionPricedKey('CS-2', 'tx-1'));
    expect(sessionGatedKey('A:B', 'C')).not.toBe(sessionGatedKey('A', 'B:C'));
    // The gate signal is its own key: the priced signal never resolves it.
    expect(sessionGatedKey('CS-1', 'tx-1')).not.toBe(sessionPricedKey('CS-1', 'tx-1'));
  });

  it('puts the same transactionId of two stations on two lanes', () => {
    const a = projectionLane(makeEvent('Transaction', 'tx-1', 'CS-1'));
    const b = projectionLane(makeEvent('Transaction', 'tx-1', 'CS-2'));
    expect(a).toBe(transactionKey('CS-1', 'tx-1'));
    expect(b).toBe(transactionKey('CS-2', 'tx-1'));
  });

  it('keeps station events on the station lane', () => {
    expect(projectionLane(makeEvent('EVSE', 'CS-1', 'CS-1'))).toBe('CS-1');
    expect(projectionLane(makeEvent('ChargingStation', 'CS-1', 'CS-1'))).toBe('CS-1');
  });

  it('runs the same transactionId of two stations in parallel', async () => {
    const queue = projectionQueueFor(makeBus());
    const blocked = deferred();
    void queue.enqueue(transactionKey('CS-1', 'tx-1'), () => blocked.promise);
    const other = vi.fn(() => Promise.resolve());
    await queue.enqueue(transactionKey('CS-2', 'tx-1'), other);
    expect(other).toHaveBeenCalledOnce();
    await expect(queue.settled([transactionKey('CS-2', 'tx-1')], 50)).resolves.toBe(true);
    await expect(queue.settled([transactionKey('CS-1', 'tx-1')], 20)).resolves.toBe(false);
    blocked.resolve();
  });
});
