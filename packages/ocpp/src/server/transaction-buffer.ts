// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DomainEvent, Logger } from '@evtivity/lib';
import { transactionKey } from './projection-queue.js';

interface BufferedEvent {
  event: DomainEvent;
  bufferedAt: number;
}

interface BufferedTransaction {
  stationId: string;
  transactionId: string;
  entries: BufferedEvent[];
}

interface TransactionBufferOptions {
  maxSize?: number;
  ttlMs?: number;
  cleanupIntervalMs?: number;
  logger?: Logger;
}

/**
 * Events of a transaction that arrived before its Started was projected, held
 * until Started drains them. Keyed by station and transactionId: an OCPP 2.1
 * transactionId is unique per charging station only.
 */
export class TransactionBuffer {
  private readonly buffer = new Map<string, BufferedTransaction>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly logger: Logger | undefined;
  private totalCount = 0;

  constructor(opts: TransactionBufferOptions = {}) {
    this.maxSize = opts.maxSize ?? 1000;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.logger = opts.logger;
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, opts.cleanupIntervalMs ?? 10_000);
  }

  get size(): number {
    return this.totalCount;
  }

  add(stationId: string, transactionId: string, event: DomainEvent): boolean {
    if (this.totalCount >= this.maxSize) return false;

    const key = transactionKey(stationId, transactionId);
    const existing = this.buffer.get(key) ?? { stationId, transactionId, entries: [] };
    existing.entries.push({ event, bufferedAt: Date.now() });
    this.buffer.set(key, existing);
    this.totalCount++;
    return true;
  }

  drain(stationId: string, transactionId: string): DomainEvent[] {
    const key = transactionKey(stationId, transactionId);
    const entries = this.buffer.get(key)?.entries;
    if (entries == null) return [];

    this.buffer.delete(key);
    const now = Date.now();
    const valid = entries.filter((e) => now - e.bufferedAt < this.ttlMs);
    const expired = entries.length - valid.length;
    if (expired > 0) {
      this.logger?.warn(
        { stationId, transactionId, expired, ttlMs: this.ttlMs },
        'Buffered transaction events expired before Started arrived (dropped at drain)',
      );
    }
    this.totalCount -= entries.length;
    return valid.map((e) => e.event);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, { stationId, transactionId, entries }] of this.buffer) {
      const remaining = entries.filter((e) => now - e.bufferedAt < this.ttlMs);
      const removed = entries.length - remaining.length;
      this.totalCount -= removed;
      if (removed > 0) {
        // Silent expiry hides cases where a station sends Updated/Ended for a
        // transaction whose Started never arrived: revenue loss with no signal
        // to the operator. Log with a sample event type so an alert can be
        // tuned.
        const firstEventType = entries[0]?.event.eventType;
        this.logger?.warn(
          { stationId, transactionId, expired: removed, firstEventType, ttlMs: this.ttlMs },
          'Buffered transaction events expired in cleanup sweep (Started never arrived)',
        );
      }
      if (remaining.length === 0) {
        this.buffer.delete(key);
      } else {
        this.buffer.set(key, { stationId, transactionId, entries: remaining });
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buffer.clear();
    this.totalCount = 0;
  }
}
