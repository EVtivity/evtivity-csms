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

/** What the per-fleet credit throttle bounds (plan S8, P6). */
export type FleetCreditThrottleKind =
  /** The running notice check (the fleet-wide exposure aggregate). */
  | 'notices'
  /** A ceiling extension that found the fleet without credit. */
  | 'no_credit';

/**
 * Per-fleet, in-process throttle of the fleet credit work a meter reading
 * triggers: the running notice check runs at most once per interval per
 * fleet, and after an extension found no credit left, extensions of the
 * fleet below the ceiling wait one interval. An extension at the ceiling
 * never waits (it decides whether the session stops).
 */
export class FleetCreditThrottle {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  due(kind: FleetCreditThrottleKind, fleetId: string, now: number): boolean {
    const last = this.lastAt.get(`${kind}:${fleetId}`);
    return last == null || now - last >= this.intervalMs;
  }

  mark(kind: FleetCreditThrottleKind, fleetId: string, now: number): void {
    this.lastAt.set(`${kind}:${fleetId}`, now);
  }

  /** Clears a mark, such as no_credit once an extension grew a ceiling again. */
  clear(kind: FleetCreditThrottleKind, fleetId: string): void {
    this.lastAt.delete(`${kind}:${fleetId}`);
  }
}

/**
 * The session projection state, created once per registerProjections call:
 * buffered out-of-order transaction events, the per-lane projection queue,
 * the CostUpdated throttle, and the per-fleet credit throttle.
 */
export interface SessionLifecycleState {
  readonly txBuffer: TransactionBuffer;
  readonly projectionQueue: ProjectionQueue;
  readonly costUpdated: CostUpdatedThrottle;
  readonly fleetCredit: FleetCreditThrottle;
}
