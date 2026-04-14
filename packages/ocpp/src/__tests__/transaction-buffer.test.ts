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

    buffer.add('tx-1', e1);
    buffer.add('tx-1', e2);

    const drained = buffer.drain('tx-1');
    expect(drained).toHaveLength(2);
    expect(drained[0]).toBe(e1);
    expect(drained[1]).toBe(e2);
  });

  it('returns empty array when draining unknown transactionId', () => {
    expect(buffer.drain('unknown')).toEqual([]);
  });

  it('removes drained events from the buffer', () => {
    buffer.add('tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.drain('tx-1');
    expect(buffer.drain('tx-1')).toEqual([]);
  });

  it('expires events older than TTL', () => {
    buffer.add('tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    vi.advanceTimersByTime(1100);
    expect(buffer.drain('tx-1')).toEqual([]);
  });

  it('rejects events when buffer is full', () => {
    for (let i = 0; i < 5; i++) {
      expect(buffer.add(`tx-${String(i)}`, makeEvent('ocpp.MeterValues', `tx-${String(i)}`))).toBe(
        true,
      );
    }
    expect(buffer.add('tx-overflow', makeEvent('ocpp.MeterValues', 'tx-overflow'))).toBe(false);
  });

  it('counts total buffered events', () => {
    buffer.add('tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.add('tx-1', makeEvent('ocpp.MeterValues', 'tx-1'));
    buffer.add('tx-2', makeEvent('ocpp.MeterValues', 'tx-2'));
    expect(buffer.size).toBe(3);
  });
});
