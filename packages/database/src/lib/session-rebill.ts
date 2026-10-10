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
  closeSegmentsAt,
  loadSessionPricing,
  priceSession,
  sessionIdleMinutesAt,
} from './session-pricing.js';
import { SESSION_END_FAILED_REASON } from './session-end-request.js';
import { toDateOrNull } from './raw-timestamp.js';
import type { RawTimestamp } from './raw-timestamp.js';

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

/**
 * Prices a session the CSMS gave up ending, as the Ended projection prices a
 * CSMS end: at its last update (the last meter value of the session, at most
 * the time it was faulted; its start without meter values) with the energy
 * metered so far. Its segments end there as the Ended projection ends them
 * (closeSegmentsAt, finding B6): a segment a switch opened at or after the
 * billed end is removed, and the latest remaining segment, which the give-up
 * closed at the fault time without an end reading, is closed at the billed
 * end with the energy. A retry closes it again with the same values. Null
 * for an unknown or unstarted session, or one without a tariff snapshot.
 */
export async function priceRebill(
  sql: postgres.Sql,
  sessionId: string,
): Promise<RebillPricing | null> {
  const session = await loadSessionPricing(sql, sessionId);
  if (session?.tariffId == null) return null;
  const [row] = await sql`
    SELECT s.ended_at, s.energy_delivered_wh,
           (SELECT max(mv.timestamp) FROM meter_values mv WHERE mv.session_id = s.id) AS last_reading_at
    FROM charging_sessions s
    WHERE s.id = ${sessionId}
  `;
  if (row == null) return null;
  const faultedAt = toDateOrNull(row.ended_at as RawTimestamp);
  let endedAt = toDateOrNull(row.last_reading_at as RawTimestamp) ?? session.startedAt;
  if (faultedAt != null && endedAt > faultedAt) endedAt = faultedAt;
  if (endedAt < session.startedAt) endedAt = session.startedAt;
  const energyWh = Number(row.energy_delivered_wh ?? 0);
  // Never negative: an idle period opened after the billed end adds nothing.
  const idleMinutes = sessionIdleMinutesAt(session, endedAt);

  await closeSegmentsAt(sql, sessionId, endedAt, energyWh, idleMinutes);

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
