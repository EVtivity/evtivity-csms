// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The likely cause of a station disconnect, from stored data only: the stored
 * SIM sessions and alerts of the station, the open session stored by the last
 * Refresh and the disconnect's own reason. Nothing here calls a provider.
 */

import type { SimInterval } from './sim-coverage.js';

export type SimOfflineCause =
  | 'server'
  | 'sim_account'
  | 'station'
  | 'network'
  | 'pending'
  | 'unknown';

/** Disconnect reasons the CSMS itself records (a restart, the offline sweep after a crash). */
export const SERVER_DISCONNECT_REASONS: readonly string[] = Object.freeze([
  'server_shutdown',
  'offline_sweep',
]);

const HOUR_MS = 3_600_000;

/** A data limit alert explains a disconnect up to 24 hours after it or 1 hour before it. */
export const SIM_ALERT_WINDOW = Object.freeze({ beforeMs: 24 * HOUR_MS, afterMs: HOUR_MS });

/** Alert kinds the provider records when the SIM attaches to the network. */
const ACTIVITY_ALERT_KINDS: readonly string[] = Object.freeze([
  'device_changed',
  'device_model_changed',
  'first_device',
]);

export interface StoredSimSessionSpan {
  startedAt: Date;
  endedAt: Date;
}

export interface StoredSimAlertAt {
  kind: string;
  receivedAt: Date;
}

export interface DisconnectFacts {
  at: Date;
  /** `metadata.reason` of the connection log row. */
  reason: string | null;
}

export interface OfflineCauseContext {
  sessions: readonly StoredSimSessionSpan[];
  alerts: readonly StoredSimAlertAt[];
  /** Begin of the session that was open at the last Refresh, null without one. */
  openSessionBeganAt: Date | null;
  /** When that open session was seen, the last Refresh's status time. */
  lastFetchedAt: Date | null;
  reportingDelayHours: number;
  now: Date;
  /** The station's fetched periods, merged: sessions are complete only inside them. */
  coverage: readonly SimInterval[];
}

function simPausedForData(at: number, ctx: OfflineCauseContext): boolean {
  return ctx.alerts.some((alert) => {
    if (alert.kind !== 'data_limit') return false;
    const loggedAt = alert.receivedAt.getTime();
    if (loggedAt < at - SIM_ALERT_WINDOW.beforeMs || loggedAt > at + SIM_ALERT_WINDOW.afterMs) {
      return false;
    }
    if (loggedAt >= at) return true;
    // A session or an attach after the pause shows the SIM active again.
    const activeAgain =
      ctx.sessions.some((s) => {
        const began = s.startedAt.getTime();
        return began > loggedAt && began < at;
      }) ||
      ctx.alerts.some((other) => {
        const otherAt = other.receivedAt.getTime();
        return ACTIVITY_ALERT_KINDS.includes(other.kind) && otherAt > loggedAt && otherAt < at;
      });
    return !activeAgain;
  });
}

/**
 * The D14 label of one disconnect, checked in order: `server`, `sim_account`,
 * `station`, `network`, `pending`, `unknown`.
 */
export function classifyDisconnect(
  disconnect: DisconnectFacts,
  ctx: OfflineCauseContext,
): SimOfflineCause {
  if (disconnect.reason != null && SERVER_DISCONNECT_REASONS.includes(disconnect.reason)) {
    return 'server';
  }
  const at = disconnect.at.getTime();
  if (simPausedForData(at, ctx)) return 'sim_account';

  const spanned = ctx.sessions.some((s) => s.startedAt.getTime() < at && s.endedAt.getTime() > at);
  const openBegan = ctx.openSessionBeganAt?.getTime() ?? null;
  const openCovers =
    openBegan != null &&
    openBegan <= at &&
    ctx.lastFetchedAt != null &&
    ctx.lastFetchedAt.getTime() >= at;
  if (spanned || openCovers) return 'station';

  const endedBefore = ctx.sessions.some((s) => s.endedAt.getTime() <= at);
  const beganAfter =
    ctx.sessions.some((s) => s.startedAt.getTime() >= at) || (openBegan != null && openBegan >= at);
  const openBeforeIt = openBegan != null && openBegan < at;
  // Outside a fetched period a session may be missing, so brackets prove nothing.
  const fetched = ctx.coverage.some((c) => c.from.getTime() <= at && c.to.getTime() > at);
  if (fetched && endedBefore && beganAfter && !openBeforeIt) return 'network';

  if (at > ctx.now.getTime() - ctx.reportingDelayHours * HOUR_MS) return 'pending';
  return 'unknown';
}
