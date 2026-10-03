// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one session cost assembly (issue #33). Every running cost, final cost,
// TransactionEventResponse totalCost, CostUpdated, prepaid stop, and stale
// session close prices a session here, from its price snapshots, and stores
// the cost with its net amount, tax, and breakdown in one statement.
// Invoices, OCPI, the portal, and reports read the stored breakdown and never
// recompute a session. The math is calculateSessionCostAt in
// @evtivity/lib/cost-calculator; the tax math is @evtivity/lib/price-display.

import type postgres from 'postgres';
import {
  calculateSessionCostAt,
  chargedCostBreakdown,
  resolveTaxBasis,
  toSessionCostBreakdown,
} from '@evtivity/lib';
import type {
  SessionCostBreakdown,
  SessionSegmentInput,
  TariffInput,
  TaxBasis,
} from '@evtivity/lib';
import { getIdlingGracePeriodMinutes } from './idling-setting.js';
import { isSplitBillingEnabled } from './pricing-settings.js';

/** The tariff columns copied onto a session or a tariff segment. */
export interface TariffPriceSnapshot {
  id: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
}

/** What a session is priced from, as loadSessionPricing reads it. */
export interface SessionPricingRow {
  id: string;
  startedAt: Date;
  tariffId: string | null;
  basis: TaxBasis;
  tariff: TariffInput;
  idleStartedAt: Date | null;
  idleMinutes: number;
  /** The reservation's start (or creation) when the session fulfilled one. */
  reservationReferenceAt: Date | null;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value as string);
}

/** A numeric column as postgres returns it (a string), or a number. */
function toPrice(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : null;
}

/**
 * The pricing inputs of a session, or null when the session does not exist or
 * has not started. The reservation fee comes from the session snapshot; a
 * snapshot written by a release before 0111 (tax_basis null) has none, so its
 * tariff's fee is read, as that release did, until such sessions have ended.
 */
export async function loadSessionPricing(
  sql: postgres.Sql,
  sessionId: string,
): Promise<SessionPricingRow | null> {
  const rows = await sql`
    SELECT s.id, s.started_at, s.tariff_id, s.tax_basis,
           s.tariff_price_per_kwh, s.tariff_price_per_minute, s.tariff_price_per_session,
           s.tariff_idle_fee_price_per_minute, s.tariff_tax_rate,
           CASE WHEN s.tax_basis IS NULL THEN t.reservation_fee_per_minute
                ELSE s.tariff_reservation_fee_per_minute END AS reservation_fee_per_minute,
           s.idle_started_at, s.idle_minutes,
           COALESCE(r.starts_at, r.created_at) AS reservation_reference_at
    FROM charging_sessions s
    LEFT JOIN tariffs t ON t.id = s.tariff_id
    LEFT JOIN reservations r ON r.id = s.reservation_id
    WHERE s.id = ${sessionId}
  `;
  const row = rows[0];
  const startedAt = toDate(row?.started_at);
  if (row == null || startedAt == null) return null;
  return {
    id: row.id as string,
    startedAt,
    tariffId: (row.tariff_id as string | null) ?? null,
    basis: resolveTaxBasis(row.tax_basis),
    tariff: {
      pricePerKwh: toPrice(row.tariff_price_per_kwh),
      pricePerMinute: toPrice(row.tariff_price_per_minute),
      pricePerSession: toPrice(row.tariff_price_per_session),
      idleFeePricePerMinute: toPrice(row.tariff_idle_fee_price_per_minute),
      reservationFeePerMinute: toPrice(row.reservation_fee_per_minute),
      taxRate: toPrice(row.tariff_tax_rate),
    },
    idleStartedAt: toDate(row.idle_started_at),
    idleMinutes: Number(row.idle_minutes ?? 0),
    reservationReferenceAt: toDate(row.reservation_reference_at),
  };
}

/** Idle minutes of a session at `at`: the accumulated minutes plus an open idle period. */
export function sessionIdleMinutesAt(
  session: { idleStartedAt: Date | null; idleMinutes: number },
  at: Date,
): number {
  if (session.idleStartedAt == null) return session.idleMinutes;
  return session.idleMinutes + (at.getTime() - session.idleStartedAt.getTime()) / 60000;
}

/** Minutes a reservation held the EVSE before the session started (holding fee). */
export function reservationHoldingMinutes(session: SessionPricingRow): number {
  if (session.reservationReferenceAt == null) return 0;
  const holdingMs = session.startedAt.getTime() - session.reservationReferenceAt.getTime();
  return Math.max(0, Math.ceil(holdingMs / 60_000));
}

/**
 * The tariff segments of a session with their price snapshots, in start
 * order. A segment opened by a release before 0111 has no snapshot
 * (price_snapshot false); it is priced from its tariff, as that release did.
 */
async function loadSegments(sql: postgres.Sql, sessionId: string): Promise<SessionSegmentInput[]> {
  const rows = await sql`
    SELECT sts.started_at, sts.ended_at, sts.energy_wh_start, sts.energy_wh_end,
           sts.idle_minutes,
           CASE WHEN sts.price_snapshot THEN sts.price_per_kwh ELSE t.price_per_kwh END AS price_per_kwh,
           CASE WHEN sts.price_snapshot THEN sts.price_per_minute ELSE t.price_per_minute END AS price_per_minute,
           CASE WHEN sts.price_snapshot THEN sts.price_per_session ELSE t.price_per_session END AS price_per_session,
           CASE WHEN sts.price_snapshot THEN sts.idle_fee_price_per_minute ELSE t.idle_fee_price_per_minute END AS idle_fee_price_per_minute,
           CASE WHEN sts.price_snapshot THEN sts.reservation_fee_per_minute ELSE t.reservation_fee_per_minute END AS reservation_fee_per_minute,
           CASE WHEN sts.price_snapshot THEN sts.tax_rate ELSE t.tax_rate END AS tax_rate
    FROM session_tariff_segments sts
    JOIN tariffs t ON t.id = sts.tariff_id
    WHERE sts.session_id = ${sessionId}
    ORDER BY sts.started_at, sts.id
  `;
  return rows.map((seg) => ({
    tariff: {
      pricePerKwh: toPrice(seg.price_per_kwh),
      pricePerMinute: toPrice(seg.price_per_minute),
      pricePerSession: toPrice(seg.price_per_session),
      idleFeePricePerMinute: toPrice(seg.idle_fee_price_per_minute),
      reservationFeePerMinute: toPrice(seg.reservation_fee_per_minute),
      taxRate: toPrice(seg.tax_rate),
    },
    startedAt: toDate(seg.started_at) as Date,
    endedAt: toDate(seg.ended_at),
    energyWhStart: Number(seg.energy_wh_start ?? 0),
    energyWhEnd: seg.energy_wh_end != null ? Number(seg.energy_wh_end) : null,
    idleMinutes: Number(seg.idle_minutes ?? 0),
  }));
}

/**
 * The cost of a session at `at` with `energyWh` delivered: its tariff
 * segments when split billing is on and the tariff changed during the
 * session, else its tariff snapshot, with the idle grace period and the
 * reservation holding fee. Null for a session without a tariff snapshot (not
 * billed, such as free vend or no pricing).
 */
export async function priceSession(
  sql: postgres.Sql,
  session: SessionPricingRow,
  at: Date,
  energyWh: number,
): Promise<SessionCostBreakdown | null> {
  if (session.tariffId == null) return null;
  const [gracePeriodMinutes, splitEnabled] = await Promise.all([
    getIdlingGracePeriodMinutes(),
    isSplitBillingEnabled(),
  ]);
  const segments = splitEnabled ? await loadSegments(sql, session.id) : [];
  return toSessionCostBreakdown(
    calculateSessionCostAt({
      basis: session.basis,
      tariff: session.tariff,
      startedAt: session.startedAt,
      at,
      energyWh,
      idleMinutes: sessionIdleMinutesAt(session, at),
      gracePeriodMinutes,
      reservationHoldingMinutes: reservationHoldingMinutes(session),
      segments,
    }),
  );
}

/** loadSessionPricing then priceSession. Null for an unknown, unstarted, or unpriced session. */
export async function priceSessionAt(
  sql: postgres.Sql,
  sessionId: string,
  at: Date,
  energyWh: number,
): Promise<SessionCostBreakdown | null> {
  const session = await loadSessionPricing(sql, sessionId);
  return session == null ? null : priceSession(sql, session, at, energyWh);
}

/** A cost of zero, for sessions ended without charging (faulted by the payment gate). */
export function zeroCostBreakdown(basis: TaxBasis): SessionCostBreakdown {
  return chargedCostBreakdown(0, 0, basis);
}

/**
 * Store the running cost of an active session with its split. Returns false
 * when the session is no longer active (a late meter value), which changes
 * nothing.
 */
export async function storeRunningCost(
  sql: postgres.Sql,
  sessionId: string,
  breakdown: SessionCostBreakdown,
): Promise<boolean> {
  const rows = await sql`
    UPDATE charging_sessions
    SET current_cost_cents = ${breakdown.grossCents},
        net_cents = ${breakdown.netCents},
        tax_cents = ${breakdown.taxCents},
        cost_breakdown = ${sql.json(breakdown as unknown as postgres.JSONValue)},
        updated_at = now()
    WHERE id = ${sessionId} AND status = 'active'
    RETURNING id
  `;
  return rows.length > 0;
}

/** Store the final cost of a session (and the same running cost) with its split. */
export async function storeFinalCost(
  sql: postgres.Sql,
  sessionId: string,
  breakdown: SessionCostBreakdown,
): Promise<void> {
  await sql`
    UPDATE charging_sessions
    SET final_cost_cents = ${breakdown.grossCents},
        current_cost_cents = ${breakdown.grossCents},
        net_cents = ${breakdown.netCents},
        tax_cents = ${breakdown.taxCents},
        cost_breakdown = ${sql.json(breakdown as unknown as postgres.JSONValue)},
        updated_at = now()
    WHERE id = ${sessionId}
  `;
}

/**
 * Copy a tariff's prices and the company tax basis onto a session (the
 * snapshot it is priced from) and open its first tariff segment with the
 * same prices.
 */
export async function snapshotSessionTariff(
  sql: postgres.Sql,
  sessionId: string,
  tariff: TariffPriceSnapshot,
  basis: TaxBasis,
  startedAt: string | Date,
): Promise<void> {
  await sql`
    UPDATE charging_sessions
    SET tariff_id = ${tariff.id},
        tariff_price_per_kwh = ${tariff.pricePerKwh},
        tariff_price_per_minute = ${tariff.pricePerMinute},
        tariff_price_per_session = ${tariff.pricePerSession},
        tariff_idle_fee_price_per_minute = ${tariff.idleFeePricePerMinute},
        tariff_reservation_fee_per_minute = ${tariff.reservationFeePerMinute},
        tariff_tax_rate = ${tariff.taxRate},
        tax_basis = ${basis},
        updated_at = now()
    WHERE id = ${sessionId}
  `;
  await insertSegment(sql, sessionId, tariff, startedAt, 0);
}

async function insertSegment(
  sql: postgres.Sql,
  sessionId: string,
  tariff: TariffPriceSnapshot,
  startedAt: string | Date,
  energyWhStart: number,
): Promise<void> {
  await sql`
    INSERT INTO session_tariff_segments (
      session_id, tariff_id, started_at, energy_wh_start, price_snapshot,
      price_per_kwh, price_per_minute, price_per_session, idle_fee_price_per_minute,
      reservation_fee_per_minute, tax_rate
    )
    VALUES (
      ${sessionId}, ${tariff.id}, ${startedAt}, ${energyWhStart}, true,
      ${tariff.pricePerKwh}, ${tariff.pricePerMinute}, ${tariff.pricePerSession},
      ${tariff.idleFeePricePerMinute}, ${tariff.reservationFeePerMinute}, ${tariff.taxRate}
    )
  `;
}

/**
 * Close the open tariff segment of a session at `at`. idle_minutes on the
 * session is the whole-session accumulator, so the closing segment gets the
 * idle not yet attributed to closed segments.
 */
export async function closeOpenSegment(
  sql: postgres.Sql,
  sessionId: string,
  at: Date,
  energyWh: number,
  sessionIdleMinutes: number,
): Promise<void> {
  const closedRows = await sql`
    SELECT COALESCE(SUM(idle_minutes), 0)::text AS total
    FROM session_tariff_segments
    WHERE session_id = ${sessionId} AND ended_at IS NOT NULL
  `;
  const closedIdle = Number(closedRows[0]?.total ?? 0);
  const segmentIdle = Math.max(0, sessionIdleMinutes - closedIdle);
  const atIso = at.toISOString();
  await sql`
    UPDATE session_tariff_segments
    SET ended_at = ${atIso},
        energy_wh_end = ${energyWh},
        duration_minutes = EXTRACT(EPOCH FROM (${atIso}::timestamptz - started_at)) / 60,
        idle_minutes = ${segmentIdle}
    WHERE session_id = ${sessionId} AND ended_at IS NULL
  `;
}

/** The tariff of a session's open segment, or null when no segment is open. */
export async function openSegmentTariffId(
  sql: postgres.Sql,
  sessionId: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT tariff_id FROM session_tariff_segments
    WHERE session_id = ${sessionId} AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return (rows[0]?.tariff_id as string | undefined) ?? null;
}

/**
 * Split billing: close the open segment at `at` and open one priced from
 * `tariff`, in one transaction. The session's own tariff snapshot (and its
 * tax rate) stays the one it started with; only segments change.
 */
export async function switchTariffSegment(
  sql: postgres.Sql,
  params: {
    sessionId: string;
    tariff: TariffPriceSnapshot;
    at: Date;
    energyWh: number;
    sessionIdleMinutes: number;
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    await closeOpenSegment(
      txSql,
      params.sessionId,
      params.at,
      params.energyWh,
      params.sessionIdleMinutes,
    );
    await insertSegment(
      txSql,
      params.sessionId,
      params.tariff,
      params.at.toISOString(),
      params.energyWh,
    );
  });
}
