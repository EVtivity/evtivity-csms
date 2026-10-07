// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TransactionBuffer } from '../transaction-buffer.js';
import type { ProjectionQueue } from '../projection-queue.js';

/**
 * Per-session CostUpdated dispatch throttle. A session is due when the
 * interval has passed since its last sent CostUpdated; a session never sent
 * counts as last sent at epoch 0.
 */
export class CostUpdatedThrottle {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  due(sessionId: string, now: number): boolean {
    const last = this.lastSentAt.get(sessionId) ?? 0;
    return now - last >= this.intervalMs;
  }

  markSent(sessionId: string, now: number): void {
    this.lastSentAt.set(sessionId, now);
  }

  /** Frees the entry of an ended session, so the map does not grow unbounded. */
  forget(sessionId: string): void {
    this.lastSentAt.delete(sessionId);
  }
}

/**
 * The session projection state, created once per registerProjections call:
 * buffered out-of-order transaction events, the per-lane projection queue,
 * and the CostUpdated throttle.
 */
export interface SessionLifecycleState {
  readonly txBuffer: TransactionBuffer;
  readonly projectionQueue: ProjectionQueue;
  readonly costUpdated: CostUpdatedThrottle;
}
