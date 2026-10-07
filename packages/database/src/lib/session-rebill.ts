// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Operator re-bill of a session the CSMS gave up ending (stopped reason
// EndRequestFailed: faulted, cost zeroed, hold cancelled). The API service
// packages/api/src/services/session-rebill.service.ts is the only caller: it
// claims the session, prices it here with the one cost assembly
// (session-pricing.ts), takes the payment, and completes it. The completion is
// the only path that moves a session from `faulted` to `completed` (P5
// override, audited by the caller).

import type postgres from 'postgres';
import type { SessionCostBreakdown } from '@evtivity/lib';
import {
  closeOpenSegment,
  loadSessionPricing,
  priceSession,
  sessionIdleMinutesAt,
} from './session-pricing.js';
import { SESSION_END_FAILED_REASON } from './session-end-request.js';

/** How long a re-bill claim holds before another request may take it over (a request that died). */
export const SESSION_REBILL_LEASE_SECONDS = 300;

/** The final state a re-bill writes: billed through the platform, or left to manual billing. */
export type SessionRebillOutcome = 'billed' | 'manual';

/**
 * Claims a session for a re-bill: `rebill_status = 'in_progress'` with a lease,
 * only while it is faulted with stopped reason EndRequestFailed and not
 * re-billed, or its claim expired. One request wins; the others get false.
 */
export async function claimSessionRebill(sql: postgres.Sql, sessionId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE charging_sessions
    SET rebill_status = 'in_progress', rebill_claimed_at = now()
    WHERE id = ${sessionId}
      AND status = 'faulted'
      AND stopped_reason = ${SESSION_END_FAILED_REASON}
      AND (rebill_status IS NULL
        OR (rebill_status = 'in_progress'
          AND rebill_claimed_at < now() - make_interval(secs => ${SESSION_REBILL_LEASE_SECONDS})))
    RETURNING id
  `;
  return rows.length > 0;
}

/** Gives a claim back (nothing was billed), so the session can be re-billed again. */
export async function releaseSessionRebill(sql: postgres.Sql, sessionId: string): Promise<void> {
  await sql`
    UPDATE charging_sessions
    SET rebill_status = NULL, rebill_claimed_at = NULL
    WHERE id = ${sessionId} AND rebill_status = 'in_progress'
  `;
}

export interface RebillPricing {
  breakdown: SessionCostBreakdown;
  /** The billed end: the session's last meter value, at most its fault time. */
  endedAt: Date;
  energyWh: number;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Prices a session the CSMS gave up ending, as the Ended projection prices a
 * CSMS end: at its last update (the last meter value of the session, at most
 * the time it was faulted; its start without meter values; never before the
 * start of its latest tariff segment) with the energy metered so far. The
 * give-up closed the open tariff segment at the fault time without an end
 * reading, which the calculator counts as no energy, so that segment is
 * reopened and closed at the billed end with the energy, as the Ended
 * projection closes it. A retry finds the segment closed with its
 * reading and leaves it alone. Null for an unknown or unstarted session, or
 * one without a tariff snapshot.
 */
export async function priceRebill(
  sql: postgres.Sql,
  sessionId: string,
): Promise<RebillPricing | null> {
  const session = await loadSessionPricing(sql, sessionId);
  if (session?.tariffId == null) return null;
  const [row] = await sql`
    SELECT s.ended_at, s.energy_delivered_wh,
           (SELECT max(mv.timestamp) FROM meter_values mv WHERE mv.session_id = s.id) AS last_reading_at,
           (SELECT max(seg.started_at) FROM session_tariff_segments seg
            WHERE seg.session_id = s.id) AS last_segment_started_at
    FROM charging_sessions s
    WHERE s.id = ${sessionId}
  `;
  if (row == null) return null;
  const faultedAt = toDate(row.ended_at);
  let endedAt = toDate(row.last_reading_at) ?? session.startedAt;
  if (faultedAt != null && endedAt > faultedAt) endedAt = faultedAt;
  if (endedAt < session.startedAt) endedAt = session.startedAt;
  // The billed end closes the latest segment, so it is never before that
  // segment's start (a tariff switch after the last meter value): the segment
  // gets a duration of 0, never a negative one.
  const lastSegmentStartedAt = toDate(row.last_segment_started_at);
  if (lastSegmentStartedAt != null && endedAt < lastSegmentStartedAt) {
    endedAt = lastSegmentStartedAt;
  }
  const energyWh = Number(row.energy_delivered_wh ?? 0);
  const idleMinutes = sessionIdleMinutesAt(session, endedAt);

  await sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    await txSql`
      UPDATE session_tariff_segments
      SET ended_at = NULL, duration_minutes = NULL
      WHERE id = (
        SELECT id FROM session_tariff_segments
        WHERE session_id = ${sessionId}
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      ) AND energy_wh_end IS NULL
    `;
    await closeOpenSegment(txSql, sessionId, endedAt, energyWh, idleMinutes);
  });

  const breakdown = await priceSession(sql, session, endedAt, energyWh);
  return breakdown == null ? null : { breakdown, endedAt, energyWh };
}

/**
 * Completes a re-billed session (the P5 override): `faulted` to `completed`
 * only for a session with stopped reason EndRequestFailed whose re-bill claim
 * is held, with the billed end, the final (and running) cost and its split, as
 * storeFinalCost stores it, and `rebill_status` billed or manual. The stopped
 * reason stays. Returns whether the session changed.
 */
export async function completeRebilledSession(
  sql: postgres.Sql,
  input: {
    sessionId: string;
    breakdown: SessionCostBreakdown;
    endedAt: Date;
    outcome: SessionRebillOutcome;
  },
): Promise<boolean> {
  const { breakdown } = input;
  const rows = await sql`
    UPDATE charging_sessions
    SET status = 'completed',
        ended_at = ${input.endedAt.toISOString()},
        final_cost_cents = ${breakdown.grossCents},
        current_cost_cents = ${breakdown.grossCents},
        net_cents = ${breakdown.netCents},
        tax_cents = ${breakdown.taxCents},
        cost_breakdown = ${sql.json(breakdown as unknown as postgres.JSONValue)},
        rebill_status = ${input.outcome},
        rebill_claimed_at = NULL,
        updated_at = now()
    WHERE id = ${input.sessionId}
      AND status = 'faulted'
      AND stopped_reason = ${SESSION_END_FAILED_REASON}
      AND rebill_status = 'in_progress'
    RETURNING id
  `;
  return rows.length > 0;
}
