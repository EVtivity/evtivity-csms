// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransactionBuffer } from '../server/transaction-buffer.js';
import type { DomainEvent } from '@evtivity/lib';

function makeEvent(eventType: string, transactionId: string): DomainEvent {
  return {
    eventType,
    aggregateType: 'ChargingStation',
    aggregateId: 'STATION-001',
    payload: { transactionId },
    occurredAt: new Date(),
  };
}

describe('TransactionBuffer', () => {
  let buffer: TransactionBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new TransactionBuffer({ maxSize: 5, ttlMs: 1000, cleanupIntervalMs: 500 });
  });

  afterEach(() => {
    buffer.destroy();
    vi.useRealTimers();
  });

  it('buffers and drains events for a transactionId', () => {
    const e1 = makeEvent('ocpp.MeterValues', 'tx-1');
    const e2 = makeEvent('ocpp.MeterValues', 'tx-1');

    buffer.add('STATION-001', 'tx-1', e1);
    buffer.add('STATION-001', 'tx-1', e2);

    const drained = buffer.drain('STATION-001', 'tx-1');
    expect(drained).toHaveLength(2);
    expect(drained[0]).toBe(e1);
    expect(drained[1]).toBe(e2);
  });

  it('keeps the same transactionId of two stations apart', () => {
    const a = makeEvent('ocpp.MeterValues', 'tx-1');
    const b = makeEvent('ocpp.MeterValues', 'tx-1');
    buffer.add('STATION-001', 'tx-1', a);
    buffer.add('STATION-002', 'tx-1', b);

    expect(buffer.drain('STATION-002', 'tx-1')).toEqual([b]);
    expect(buffer.drain('STATION-001', 'tx-1')).toEqual([a]);
    expect(buffer.size).toBe(0);
  });

  it('does not confuse station and transaction ids that contain the separator', () => {
    buffer.add('A:B', 'C', makeEvent('ocpp.MeterValues', 'C'));
    expect(buffer.drain('A', 'B:C')).toEqual([]);
    expect(buffer.drain('A:B', 'C')).toHaveLength(1);
  });

  it('returns empty array when draining unknown transactionId', () => {
    expect(buffer.drain('STATION-001', 'unknown')).toEqual([]);
  });

  it('removes drained events from the buffer', () => {
    buffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.drain('STATION-001', 'tx-1');
    expect(buffer.drain('STATION-001', 'tx-1')).toEqual([]);
  });

  it('expires events older than TTL', () => {
    buffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    vi.advanceTimersByTime(1100);
    expect(buffer.drain('STATION-001', 'tx-1')).toEqual([]);
  });

  it('rejects events when buffer is full', () => {
    for (let i = 0; i < 5; i++) {
      expect(
        buffer.add(
          'STATION-001',
          `tx-${String(i)}`,
          makeEvent('ocpp.MeterValues', `tx-${String(i)}`),
        ),
      ).toBe(true);
    }
    expect(
      buffer.add('STATION-001', 'tx-overflow', makeEvent('ocpp.MeterValues', 'tx-overflow')),
    ).toBe(false);
  });

  it('counts total buffered events', () => {
    buffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.add('STATION-001', 'tx-2', makeEvent('ocpp.MeterValues', 'tx-2'));
    expect(buffer.size).toBe(3);
  });

  it('uses default options when none provided', () => {
    const defaultBuffer = new TransactionBuffer();
    try {
      // Default maxSize is 1000, so 6 adds all succeed where the test buffer
      // (maxSize 5) would reject the 6th.
      for (let i = 0; i < 6; i++) {
        expect(
          defaultBuffer.add(
            'STATION-001',
            `tx-${String(i)}`,
            makeEvent('ocpp.MeterValues', `tx-${String(i)}`),
          ),
        ).toBe(true);
      }
      expect(defaultBuffer.size).toBe(6);
    } finally {
      defaultBuffer.destroy();
    }
  });

  describe('with a logger', () => {
    let warn: ReturnType<typeof vi.fn>;
    let loggedBuffer: TransactionBuffer;

    beforeEach(() => {
      warn = vi.fn();
      const logger = { warn } as unknown as import('@evtivity/lib').Logger;
      loggedBuffer = new TransactionBuffer({
        maxSize: 5,
        ttlMs: 1000,
        cleanupIntervalMs: 500,
        logger,
      });
    });

    afterEach(() => {
      loggedBuffer.destroy();
    });

    it('logs and drops expired events on drain', () => {
      // Long cleanup interval so the sweep does not evict before drain runs;
      // this isolates the drain-time expiry path.
      loggedBuffer.destroy();
      const warnLocal = vi.fn();
      loggedBuffer = new TransactionBuffer({
        maxSize: 5,
        ttlMs: 1000,
        cleanupIntervalMs: 100_000,
        logger: { warn: warnLocal } as unknown as import('@evtivity/lib').Logger,
      });
      warn = warnLocal;

      loggedBuffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
      vi.advanceTimersByTime(1100);

      const drained = loggedBuffer.drain('STATION-001', 'tx-1');

      expect(drained).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          stationId: 'STATION-001',
          transactionId: 'tx-1',
          expired: 1,
          ttlMs: 1000,
        }),
        expect.stringContaining('expired before Started arrived'),
      );
      expect(loggedBuffer.size).toBe(0);
    });

    it('logs expired events during the cleanup sweep', () => {
      loggedBuffer.add('STATION-001', 'tx-1', makeEvent('ocpp.TransactionEvent', 'tx-1'));
      // Advance past TTL so the next cleanup interval evicts the entry.
      vi.advanceTimersByTime(1100);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          stationId: 'STATION-001',
          transactionId: 'tx-1',
          expired: 1,
          firstEventType: 'ocpp.TransactionEvent',
          ttlMs: 1000,
        }),
        expect.stringContaining('expired in cleanup sweep'),
      );
      expect(loggedBuffer.size).toBe(0);
    });

    it('keeps non-expired events across a cleanup sweep', () => {
      loggedBuffer.add('STATION-001', 'tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
      // 600ms < ttl 1000ms: the cleanup at 500ms should not evict.
      vi.advanceTimersByTime(600);

      expect(loggedBuffer.size).toBe(1);
      expect(loggedBuffer.drain('STATION-001', 'tx-1')).toHaveLength(1);
    });
  });
});
