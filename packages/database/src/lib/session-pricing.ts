// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one session cost assembly (issue #33). Every running cost, final cost,
// TransactionEventResponse totalCost, CostUpdated, cost ceiling stop, and stale
// session close prices a session here, from its price snapshots, and stores
// the cost with its net amount, tax, and breakdown in one statement.
// Invoices, OCPI, the portal, and reports read the stored breakdown and never
// recompute a session. The math is the pricing engine (priceSessionCost in
// @evtivity/lib/pricing-engine); this module only loads its inputs.

import type postgres from 'postgres';
import { chargedCostBreakdown, priceSessionCost, resolveTaxBasis } from '@evtivity/lib';
import type {
  SessionCostBreakdown,
  SessionSegmentInput,
  TariffInput,
  TaxBasis,
} from '@evtivity/lib';
import { getIdlingGracePeriodMinutes } from './idling-setting.js';
import { toDate, toDateOrNull } from './raw-timestamp.js';
import type { RawTimestamp } from './raw-timestamp.js';
import { resolveStationTariff } from './tariff-resolution.js';

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
  /** The most the session can be billed (a guest's card authorization), or null. */
  costCeilingCents: number | null;
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
           s.idle_started_at, s.idle_minutes, s.cost_ceiling_cents,
           COALESCE(r.starts_at, r.created_at) AS reservation_reference_at
    FROM charging_sessions s
    LEFT JOIN tariffs t ON t.id = s.tariff_id
    LEFT JOIN reservations r ON r.id = s.reservation_id
    WHERE s.id = ${sessionId}
  `;
  const row = rows[0];
  const startedAt = toDateOrNull(row?.started_at as RawTimestamp);
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
    idleStartedAt: toDateOrNull(row.idle_started_at as RawTimestamp),
    idleMinutes: Number(row.idle_minutes ?? 0),
    reservationReferenceAt: toDateOrNull(row.reservation_reference_at as RawTimestamp),
    costCeilingCents: row.cost_ceiling_cents != null ? Number(row.cost_ceiling_cents) : null,
  };
}

/**
 * Idle minutes of a session at `at`: the accumulated minutes plus an open idle
 * period. An idle period that opened after `at` adds nothing (never a negative
 * amount, finding B11).
 */
export function sessionIdleMinutesAt(
  session: { idleStartedAt: Date | null; idleMinutes: number },
  at: Date,
): number {
  if (session.idleStartedAt == null) return session.idleMinutes;
  return (
    session.idleMinutes + Math.max(0, (at.getTime() - session.idleStartedAt.getTime()) / 60000)
  );
}

/**
 * The time a station event applies at for tariff resolution and segment
 * switches (finding B5): its own timestamp, at most `now` (a station clock
 * ahead of the CSMS never selects a future tariff); `now` for a missing or
 * invalid timestamp.
 */
export function eventTimeAtMostNow(
  timestamp: string | Date | null | undefined,
  now: Date = new Date(),
): Date {
  const ms = timestamp == null ? Number.NaN : new Date(timestamp).getTime();
  return Number.isNaN(ms) || ms > now.getTime() ? now : new Date(ms);
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
    startedAt: toDate(seg.started_at as Date | string),
    endedAt: toDateOrNull(seg.ended_at as RawTimestamp),
    energyWhStart: Number(seg.energy_wh_start ?? 0),
    energyWhEnd: seg.energy_wh_end != null ? Number(seg.energy_wh_end) : null,
    idleMinutes: Number(seg.idle_minutes ?? 0),
  }));
}

/**
 * A session's segments as they stand at `at` (findings B6 and B8): a segment
 * other than the first that starts at or after `at` does not exist yet (a
 * switch at wall clock after an end the station reports later), and the
 * latest remaining segment is open at `at` when it ended after `at` or has
 * not ended. The Ended projection stores the same view (closeSegmentsAt).
 */
export function segmentsAt(segments: SessionSegmentInput[], at: Date): SessionSegmentInput[] {
  const atMs = at.getTime();
  const kept = segments.filter((seg, index) => index === 0 || seg.startedAt.getTime() < atMs);
  const last = kept[kept.length - 1];
  if (last != null && last.endedAt != null && last.endedAt.getTime() > atMs) {
    kept[kept.length - 1] = { ...last, endedAt: null, energyWhEnd: null, idleMinutes: 0 };
  }
  return kept;
}

/**
 * The cost of a session at `at` with `energyWh` delivered: its tariff
 * segments when the session has more than one (whatever the split billing
 * setting is now, finding B8), else its tariff snapshot, with the idle grace period and the
 * reservation holding fee, at most the session's cost ceiling (a guest's card
 * authorization or a prepaid token's credit: the tariff price above it is
 * kept in pricedGrossCents and not billed). Null for a session without a tariff snapshot (not billed, such
 * as free vend or no pricing).
 */
export async function priceSession(
  sql: postgres.Sql,
  session: SessionPricingRow,
  at: Date,
  energyWh: number,
): Promise<SessionCostBreakdown | null> {
  if (session.tariffId == null) return null;
  const [gracePeriodMinutes, allSegments] = await Promise.all([
    getIdlingGracePeriodMinutes(),
    loadSegments(sql, session.id),
  ]);
  const segments = segmentsAt(allSegments, at);
  return priceSessionCost({
    basis: session.basis,
    tariff: session.tariff,
    startedAt: session.startedAt,
    at,
    energyWh,
    idleMinutes: sessionIdleMinutesAt(session, at),
    gracePeriodMinutes,
    reservationHoldingMinutes: reservationHoldingMinutes(session),
    segments,
    ceilingCents: session.costCeilingCents,
  }).breakdown;
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
 * Fault an active session that ended without the station closing it (a stale
 * session, a transaction the station no longer knows) and bill it nothing:
 * final and running cost, net, and tax 0 with a zero breakdown in the
 * session's basis, like the payment gate's stop. Only an `active` session
 * changes (P5), so one that ended meanwhile keeps its own end and cost.
 * Returns whether this call faulted the session. The caller cancels the open
 * hold.
 */
export async function faultUnbilledSession(
  sql: postgres.Sql,
  input: { sessionId: string; reason: string; endedAt: Date | string },
): Promise<boolean> {
  const endedAt = input.endedAt instanceof Date ? input.endedAt.toISOString() : input.endedAt;
  const rows = await sql`
    UPDATE charging_sessions
    SET status = 'faulted',
        stopped_reason = ${input.reason},
        ended_at = ${endedAt},
        final_cost_cents = 0,
        current_cost_cents = 0,
        net_cents = 0,
        tax_cents = 0,
        cost_breakdown = jsonb_set(
          ${sql.json(zeroCostBreakdown('net') as unknown as postgres.JSONValue)}::jsonb,
          '{basis}',
          to_jsonb(COALESCE(tax_basis, 'net'))
        ),
        updated_at = now()
    WHERE id = ${input.sessionId} AND status = 'active'
    RETURNING id
  `;
  return rows.length > 0;
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
 * Copy a tariff's prices, its pricing group and the company tax basis onto a
 * session (the snapshot it is priced from; split billing switches resolve
 * within that group). One UPDATE, safe to run again. The session's
 * first tariff segment is opened by openFirstTariffSegment.
 */
export async function snapshotSessionTariff(
  sql: postgres.Sql,
  sessionId: string,
  tariff: TariffPriceSnapshot,
  basis: TaxBasis,
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
        pricing_group_id = (SELECT pricing_group_id FROM tariffs WHERE id = ${tariff.id}),
        tax_basis = ${basis},
        updated_at = now()
    WHERE id = ${sessionId}
  `;
}

/**
 * Open a session's first tariff segment with the prices of its tariff. One
 * INSERT; a session that already has an open segment keeps it (the partial
 * unique index of migration 0330 allows one open segment per session).
 */
export async function openFirstTariffSegment(
  sql: postgres.Sql,
  sessionId: string,
  tariff: TariffPriceSnapshot,
  startedAt: string | Date,
): Promise<void> {
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
    ON CONFLICT (session_id) WHERE ended_at IS NULL DO NOTHING
  `;
}

/**
 * Prices a session from the tariff of its driver when the driver is linked
 * after the start: a 2.1 transaction started at plug-in without an idToken
 * (E02, TxStartPoint EVConnected) is snapshotted at Started without a driver,
 * so a driver-specific tariff (driver or fleet pricing group) was not applied.
 * The session belongs to that driver from its start, so the tariff the driver
 * resolves at the session start replaces the session snapshot, and every
 * tariff segment is re-priced from the tariff the driver resolves at that
 * segment's start and energy (one segment unless split billing switched
 * already). A session without segments gets its first one. Nothing changes
 * when the driver resolves the tariff the session already has. One
 * transaction under the session row lock; safe to run again (the second run
 * finds the driver's tariff). Returns whether the snapshot was replaced.
 */
export async function repriceSessionForDriver(
  sql: postgres.Sql,
  params: { sessionId: string; stationUuid: string; driverUuid: string; basis: TaxBasis },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    const [session] = await txSql`
      SELECT started_at, tariff_id, tax_basis FROM charging_sessions
      WHERE id = ${params.sessionId}
      FOR UPDATE
    `;
    if (session == null) return false;
    const startedAt = new Date(session.started_at as string | Date);
    const tariff = await resolveStationTariff(
      { stationUuid: params.stationUuid, driverUuid: params.driverUuid, at: startedAt },
      txSql,
    );
    if (tariff == null || tariff.id === (session.tariff_id as string | null)) return false;
    // The tax basis stays the one stamped at Started.
    const basis = (session.tax_basis as TaxBasis | null) ?? params.basis;
    await snapshotSessionTariff(txSql, params.sessionId, tariff, basis);
    const segments = await txSql`
      SELECT id, started_at, energy_wh_start FROM session_tariff_segments
      WHERE session_id = ${params.sessionId}
      ORDER BY started_at, id
    `;
    if (segments.length === 0) {
      await insertSegment(txSql, params.sessionId, tariff, startedAt.toISOString(), 0);
      return true;
    }
    for (const [index, segment] of segments.entries()) {
      const segmentTariff =
        index === 0
          ? tariff
          : await resolveStationTariff(
              {
                stationUuid: params.stationUuid,
                driverUuid: params.driverUuid,
                at: new Date(segment.started_at as string | Date),
                sessionEnergyKwh: Number(segment.energy_wh_start ?? 0) / 1000,
                // The later segments resolve within the driver's group, as
                // the split billing switches do from now on.
                pricingGroupId: tariff.pricingGroup.id,
              },
              txSql,
            );
      if (segmentTariff == null) continue;
      await txSql`
        UPDATE session_tariff_segments
        SET tariff_id = ${segmentTariff.id},
            price_snapshot = true,
            price_per_kwh = ${segmentTariff.pricePerKwh},
            price_per_minute = ${segmentTariff.pricePerMinute},
            price_per_session = ${segmentTariff.pricePerSession},
            idle_fee_price_per_minute = ${segmentTariff.idleFeePricePerMinute},
            reservation_fee_per_minute = ${segmentTariff.reservationFeePerMinute},
            tax_rate = ${segmentTariff.taxRate}
        WHERE id = ${segment.id as number}
      `;
    }
    return true;
  });
}

/**
 * Ends a session's tariff segments at `at` (the Ended projection, the stale
 * session cleanup, and the re-bill; findings B6 and B11): every segment other
 * than the first that starts at or after `at` is removed (a switch the
 * tariff boundary job made at wall clock after the end the station reports
 * later), and the latest remaining segment is closed at `at` with `energyWh`
 * and the session idle not attributed to the other segments. One transaction
 * under the session row lock, so it never interleaves with a segment switch.
 * Safe to run again with the same values.
 */
export async function closeSegmentsAt(
  sql: postgres.Sql,
  sessionId: string,
  at: Date,
  energyWh: number,
  sessionIdleMinutes: number,
): Promise<void> {
  const atIso = at.toISOString();
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    await txSql`SELECT id FROM charging_sessions WHERE id = ${sessionId} FOR UPDATE`;
    const segments = await txSql`
      SELECT id, started_at FROM session_tariff_segments
      WHERE session_id = ${sessionId}
      ORDER BY started_at, id
    `;
    const first = segments[0];
    if (first == null) return;
    const atMs = at.getTime();
    const later = segments
      .slice(1)
      .filter((seg) => new Date(seg.started_at as string | Date).getTime() >= atMs)
      .map((seg) => seg.id as number);
    if (later.length > 0) {
      await txSql`DELETE FROM session_tariff_segments WHERE id = ANY(${later}::int[])`;
    }
    const remaining = segments.filter((seg) => !later.includes(seg.id as number));
    const last = remaining[remaining.length - 1] ?? first;
    const [otherIdle] = await txSql`
      SELECT COALESCE(SUM(idle_minutes), 0)::text AS total
      FROM session_tariff_segments
      WHERE session_id = ${sessionId} AND id <> ${last.id as number}
    `;
    const segmentIdle = Math.max(0, sessionIdleMinutes - Number(otherIdle?.total ?? 0));
    await txSql`
      UPDATE session_tariff_segments
      SET ended_at = ${atIso},
          energy_wh_end = GREATEST(energy_wh_start, ${energyWh}::numeric),
          duration_minutes = GREATEST(0, EXTRACT(EPOCH FROM (${atIso}::timestamptz - started_at)) / 60),
          idle_minutes = ${segmentIdle}
      WHERE id = ${last.id as number}
    `;
  });
}

/**
 * Split billing: closes the open segment of an active session at `at` and
 * opens one priced from `tariff` at `at` with `energyWh` (finding B1). One
 * transaction under the session row lock (SELECT ... FOR UPDATE), so the
 * tariff boundary job and a MeterValues projection never switch the same
 * session at once: the second waits, then finds the new segment open with the
 * tariff it resolved and does nothing. The close is a compare-and-set on the
 * open segment's id, and the new segment is inserted only when that close
 * changed a row. Nothing changes when the open segment already has `tariff`,
 * when `at` is not after the open segment's start (an older reading after a
 * newer switch, findings B5 and B6), or when the session is not active. The
 * closing segment gets the session idle at `at` not yet attributed to closed
 * segments. The session's own tariff snapshot stays the one it started with.
 * Returns the tariff of the segment it closed, or null when it switched
 * nothing.
 *
 * `readingEnergyWh` (MeterValues only): the session energy at the reading
 * `at` is the time of, when that reading is the newest projected register
 * reading (not stale). When it switches nothing because `at` is at or before
 * the open segment's start, and the open segment is not the first, a reading
 * above the open segment's starting energy moves the boundary energy up to it
 * (the closed segment's end and the open segment's start): that energy was
 * delivered before the boundary. This happens when the boundary job switched
 * at wall clock with the energy of an older reading and the reading taken at
 * the boundary arrives just after (TC-T2-06). A reading after the boundary
 * cannot be known yet: the reading is the newest one and not after the
 * boundary.
 */
export async function switchTariffSegment(
  sql: postgres.Sql,
  params: {
    sessionId: string;
    tariff: TariffPriceSnapshot;
    at: Date;
    energyWh: number;
    readingEnergyWh?: number | null;
  },
): Promise<{ fromTariffId: string } | null> {
  // Most calls find the open segment on the tariff already (every MeterValues
  // with split billing on, every boundary job tick): a read without the lock
  // skips the transaction then. The lock below decides the switch.
  const [current] = await sql`
    SELECT tariff_id, started_at, energy_wh_start FROM session_tariff_segments
    WHERE session_id = ${params.sessionId} AND ended_at IS NULL
  `;
  if (current == null) return null;
  const readingEnergyWh = params.readingEnergyWh ?? null;
  const raisesBoundary = (open: Record<string, unknown>): boolean =>
    readingEnergyWh != null &&
    params.at.getTime() <= new Date(open.started_at as string | Date).getTime() &&
    readingEnergyWh > Number(open.energy_wh_start ?? 0);
  if (current.tariff_id === params.tariff.id && !raisesBoundary(current)) return null;
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as postgres.Sql;
    const [session] = await txSql`
      SELECT idle_started_at, idle_minutes FROM charging_sessions
      WHERE id = ${params.sessionId} AND status = 'active'
      FOR UPDATE
    `;
    if (session == null) return null;
    const [open] = await txSql`
      SELECT id, tariff_id, started_at, energy_wh_start FROM session_tariff_segments
      WHERE session_id = ${params.sessionId} AND ended_at IS NULL
    `;
    if (open == null) return null;
    const openStartedAt = new Date(open.started_at as string | Date);
    if (open.tariff_id === params.tariff.id || params.at.getTime() <= openStartedAt.getTime()) {
      if (readingEnergyWh != null && raisesBoundary(open)) {
        // Not the first segment: the previous one ends where the open one
        // starts, at the same energy (the switch wrote both).
        const raised = await txSql`
          UPDATE session_tariff_segments
          SET energy_wh_end = ${readingEnergyWh}
          WHERE session_id = ${params.sessionId} AND id <> ${open.id as number}
            AND ended_at = (SELECT started_at FROM session_tariff_segments WHERE id = ${open.id as number})
            AND energy_wh_end < ${readingEnergyWh}
          RETURNING id
        `;
        if (raised.length > 0) {
          await txSql`
            UPDATE session_tariff_segments
            SET energy_wh_start = ${readingEnergyWh}
            WHERE id = ${open.id as number} AND ended_at IS NULL
          `;
        }
      }
      return null;
    }
    const [closedIdle] = await txSql`
      SELECT COALESCE(SUM(idle_minutes), 0)::text AS total
      FROM session_tariff_segments
      WHERE session_id = ${params.sessionId} AND ended_at IS NOT NULL
    `;
    const sessionIdle = sessionIdleMinutesAt(
      {
        idleStartedAt:
          session.idle_started_at != null
            ? new Date(session.idle_started_at as string | Date)
            : null,
        idleMinutes: Number(session.idle_minutes ?? 0),
      },
      params.at,
    );
    const segmentIdle = Math.max(0, sessionIdle - Number(closedIdle?.total ?? 0));
    // The energy at the switch is never below the open segment's start.
    const energyWh = Math.max(params.energyWh, Number(open.energy_wh_start ?? 0));
    const atIso = params.at.toISOString();
    const closed = await txSql`
      UPDATE session_tariff_segments
      SET ended_at = ${atIso},
          energy_wh_end = ${energyWh},
          duration_minutes = EXTRACT(EPOCH FROM (${atIso}::timestamptz - started_at)) / 60,
          idle_minutes = ${segmentIdle}
      WHERE id = ${open.id as number} AND ended_at IS NULL
      RETURNING id
    `;
    if (closed.length === 0) return null;
    await insertSegment(txSql, params.sessionId, params.tariff, atIso, energyWh);
    return { fromTariffId: open.tariff_id as string };
  });
}
