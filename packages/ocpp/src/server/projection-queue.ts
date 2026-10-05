// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DomainEvent, EventBus } from '@evtivity/lib';

/**
 * Per-aggregate sequential queue for event projections. Work for one lane
 * (a station ID, or a transaction as `transactionKey()`) runs one item at a
 * time in arrival order; different lanes run in parallel.
 */
export interface ProjectionQueue {
  enqueue(id: string, work: () => Promise<void>): Promise<void>;
  /**
   * Resolves true once the projection work queued so far for these aggregate
   * IDs has finished, including work that finishing work queued in turn (a
   * drained transaction buffer re-publishes onto the station lane). Resolves
   * false when that takes longer than `timeoutMs`.
   */
  settled(ids: string[], timeoutMs: number): Promise<boolean>;
  /**
   * Marks a point a projection reached (for example `sessionPricedKey()`: the
   * session of a Started event has its tariff snapshot). Waiters resolve; a
   * later `waitForSignal` for the same key resolves at once.
   */
  signal(key: string): void;
  /** Resolves true once `signal(key)` was called, false after `timeoutMs`. */
  waitForSignal(key: string, timeoutMs: number): Promise<boolean>;
}

/**
 * The in-memory key of a transaction. An OCPP 2.1 transactionId is unique per
 * charging station only (E01.FR.08), so every key that names a transaction
 * (projection lane, transaction buffer, signal) includes the station's OCPP id.
 * JSON keeps the key unambiguous: a station id may contain any separator.
 */
export function transactionKey(stationId: string, transactionId: string): string {
  return JSON.stringify([stationId, transactionId]);
}

/**
 * The projection lane of an event: the transaction (station and transactionId)
 * for `Transaction` events, whose aggregate id is the transactionId alone, else
 * the aggregate id (the station's OCPP id for station events).
 */
export function projectionLane(event: DomainEvent): string {
  const stationId = event.payload.stationId;
  if (event.aggregateType === 'Transaction' && typeof stationId === 'string') {
    return transactionKey(stationId, event.aggregateId);
  }
  return event.aggregateId;
}

/** Signal key: the Started projection snapshotted the tariff of this transaction's session. */
export function sessionPricedKey(stationId: string, transactionId: string): string {
  return `session-priced:${transactionKey(stationId, transactionId)}`;
}

interface SignalEntry {
  promise: Promise<void>;
  resolve: () => void;
  fired: boolean;
  createdAt: number;
}

const QUEUE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const QUEUE_STALE_THRESHOLD_MS = 10 * 60 * 1000;

function createProjectionQueue(): ProjectionQueue {
  const lanes = new Map<string, { promise: Promise<void>; lastActivity: number }>();
  const signals = new Map<string, SignalEntry>();

  function signalEntry(key: string): SignalEntry {
    let entry = signals.get(key);
    if (entry == null) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      entry = { promise, resolve, fired: false, createdAt: Date.now() };
      signals.set(key, entry);
    }
    return entry;
  }

  // Clean up stale lane entries every 5 minutes.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of lanes) {
      if (now - entry.lastActivity >= QUEUE_STALE_THRESHOLD_MS) {
        lanes.delete(id);
      }
    }
    for (const [key, entry] of signals) {
      if (now - entry.createdAt >= QUEUE_STALE_THRESHOLD_MS) {
        signals.delete(key);
      }
    }
  }, QUEUE_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return {
    enqueue(id, work) {
      const prev = lanes.get(id)?.promise ?? Promise.resolve();
      const next = prev.then(work, work); // run even if previous failed
      lanes.set(id, { promise: next, lastActivity: Date.now() });
      return next;
    },

    async settled(ids, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tails = ids.map((id) => lanes.get(id)?.promise);
        const pending = tails.filter((tail): tail is Promise<void> => tail != null);
        if (pending.length === 0) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;

        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          Promise.allSettled(pending).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              resolve(true);
            }, remaining);
          }),
        ]);
        clearTimeout(timer);
        if (timedOut) return false;
        if (ids.every((id, index) => lanes.get(id)?.promise === tails[index])) return true;
      }
    },

    signal(key) {
      const entry = signalEntry(key);
      entry.fired = true;
      entry.resolve();
    },

    async waitForSignal(key, timeoutMs) {
      const entry = signalEntry(key);
      if (entry.fired) return true;
      let timer: NodeJS.Timeout | undefined;
      const fired = await Promise.race([
        entry.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return fired;
    },
  };
}

const queues = new WeakMap<EventBus, ProjectionQueue>();

/**
 * The projection queue of an event bus. Projections enqueue their work on it,
 * and a handler that must answer from projected state (the final cost in the
 * 2.1 TransactionEventResponse) waits for it with `settled()`. A bus without
 * projections has an empty queue, so `settled()` resolves at once.
 */
export function projectionQueueFor(eventBus: EventBus): ProjectionQueue {
  let queue = queues.get(eventBus);
  if (queue == null) {
    queue = createProjectionQueue();
    queues.set(eventBus, queue);
  }
  return queue;
}
