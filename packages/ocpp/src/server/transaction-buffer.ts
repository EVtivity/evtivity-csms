// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DomainEvent } from '@evtivity/lib';

interface BufferedEvent {
  event: DomainEvent;
  bufferedAt: number;
}

interface TransactionBufferOptions {
  maxSize?: number;
  ttlMs?: number;
  cleanupIntervalMs?: number;
}

export class TransactionBuffer {
  private readonly buffer = new Map<string, BufferedEvent[]>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private totalCount = 0;

  constructor(opts: TransactionBufferOptions = {}) {
    this.maxSize = opts.maxSize ?? 1000;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, opts.cleanupIntervalMs ?? 10_000);
  }

  get size(): number {
    return this.totalCount;
  }

  add(transactionId: string, event: DomainEvent): boolean {
    if (this.totalCount >= this.maxSize) return false;

    const existing = this.buffer.get(transactionId) ?? [];
    existing.push({ event, bufferedAt: Date.now() });
    this.buffer.set(transactionId, existing);
    this.totalCount++;
    return true;
  }

  drain(transactionId: string): DomainEvent[] {
    const entries = this.buffer.get(transactionId);
    if (entries == null) return [];

    this.buffer.delete(transactionId);
    const now = Date.now();
    const valid = entries.filter((e) => now - e.bufferedAt < this.ttlMs);
    this.totalCount -= entries.length;
    return valid.map((e) => e.event);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [txId, entries] of this.buffer) {
      const remaining = entries.filter((e) => now - e.bufferedAt < this.ttlMs);
      const removed = entries.length - remaining.length;
      this.totalCount -= removed;
      if (remaining.length === 0) {
        this.buffer.delete(txId);
      } else {
        this.buffer.set(txId, remaining);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buffer.clear();
    this.totalCount = 0;
  }
}
