// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { getIdlingGracePeriodMinutes, isSplitBillingEnabled } from '@evtivity/database';
import { calculateSessionCost, calculateSplitSessionCost } from '@evtivity/lib';
import type { TariffSegment } from '@evtivity/lib';

/** The `charging_sessions` columns the final cost is computed from. */
export interface SessionCostRow {
  id: string;
  started_at: string | Date;
  tariff_id: string | null;
  tariff_price_per_kwh: string | null;
  tariff_price_per_minute: string | null;
  tariff_price_per_session: string | null;
  tariff_idle_fee_price_per_minute: string | null;
  tariff_tax_rate: string | null;
  idle_started_at: string | Date | null;
  idle_minutes: string | number | null;
  reservation_id: string | null;
}

/** The cost of a transaction at a moment of its TransactionEvent. */
export interface TransactionCost {
  /** Cost in cents of the session currency. */
  totalCostCents: number;
  /**
   * True when computed from the tariff with `calculateSessionCostCentsAt`
   * (the Ended projection stores it as final_cost_cents). False when the
   * session is not billed (no tariff, free vend, or already faulted or failed).
   */
  calculated: boolean;
}

/**
 * The cost of the session of `transactionId` at `stationId` at `at`, for the
 * 2.1 TransactionEventResponse totalCost: the running cost for Started and
 * Updated (I02 alternative scenario), the final cost for Ended (I03.FR.02).
 * The caller first waits for the projections the session row depends on. The
 * energy is the one the projections store: the register reading of the event
 * (`meterRegisterWh`) minus meter_start when that is higher than the energy
 * from earlier readings. Returns null when the session is unknown (its
 * Started event has not been projected), so the cost is not known.
 */
export async function transactionCostAt(
  sql: postgres.Sql,
  params: { stationId: string; transactionId: string; at: Date; meterRegisterWh: number | null },
): Promise<TransactionCost | null> {
  const rows = await sql`
    SELECT s.id, s.status, s.started_at, s.tariff_id, s.tariff_price_per_kwh,
           s.tariff_price_per_minute, s.tariff_price_per_session,
           s.tariff_idle_fee_price_per_minute, s.tariff_tax_rate,
           s.idle_started_at, s.idle_minutes, s.reservation_id,
           s.energy_delivered_wh, s.meter_start, s.final_cost_cents
    FROM charging_sessions s
    JOIN charging_stations st ON st.id = s.station_id
    WHERE st.station_id = ${params.stationId} AND s.transaction_id = ${params.transactionId}
    LIMIT 1
  `;
  const session = rows[0];
  if (session == null) return null;

  const status = session.status as string;
  if (status === 'faulted' || status === 'failed') {
    // The payment gate or another stop path already ended the session without
    // charging it (P5: a later event does not bill it).
    return {
      totalCostCents: Number(session.final_cost_cents ?? 0),
      calculated: false,
    };
  }
  // No tariff snapshot (no pricing for this station, or a free vend site):
  // the session is not billed, which the spec reports as 0.00 (I03.FR.04).
  if (session.tariff_id == null) return { totalCostCents: 0, calculated: false };

  const storedEnergyWh = Number(session.energy_delivered_wh ?? 0);
  const meterStart = session.meter_start != null ? Number(session.meter_start) : null;
  const energyWh =
    params.meterRegisterWh != null && meterStart != null && params.meterRegisterWh >= meterStart
      ? Math.max(storedEnergyWh, params.meterRegisterWh - meterStart)
      : storedEnergyWh;

  const totalCostCents = await calculateSessionCostCentsAt(
    sql,
    session as unknown as SessionCostRow,
    params.at,
    energyWh,
  );
  return { totalCostCents, calculated: true };
}

/** Idle minutes of a session at `at`: the accumulated minutes plus an open idle period. */
export function sessionIdleMinutesAt(session: SessionCostRow, at: Date): number {
  const accumulated = Number(session.idle_minutes ?? 0);
  if (session.idle_started_at == null) return accumulated;
  return accumulated + (at.getTime() - new Date(session.idle_started_at).getTime()) / 60000;
}

/** Minutes a reservation held the EVSE before the session started (holding fee). */
async function reservationHoldingMinutes(
  sql: postgres.Sql,
  session: SessionCostRow,
): Promise<number> {
  if (session.reservation_id == null) return 0;
  const rows = await sql`
    SELECT starts_at, created_at FROM reservations WHERE id = ${session.reservation_id}
  `;
  const row = rows[0];
  if (row == null) return 0;
  const referenceTime = (row.starts_at ?? row.created_at) as string | Date;
  const holdingMs = new Date(session.started_at).getTime() - new Date(referenceTime).getTime();
  return Math.max(0, Math.ceil(holdingMs / 60_000));
}

/**
 * Cost in cents of a session at `endedAt` (its end, or now for a running
 * cost) having delivered `energyWh`, from its snapshotted tariff, or from its tariff segments when
 * split billing is on and the tariff changed during the session.
 *
 * A segment that is still open is costed as if closed at `endedAt` with
 * `energyWh`, with the session idle not yet attributed to closed segments,
 * which is how the TransactionEvent Ended projection closes it. The result is
 * therefore the same before and after the projection closes the segment, so
 * the 2.1 TransactionEvent handler (totalCost in the response) and the
 * projection (final_cost_cents) share this one computation.
 *
 * The session must have a tariff snapshot (`tariff_id`).
 */
export async function calculateSessionCostCentsAt(
  sql: postgres.Sql,
  session: SessionCostRow,
  endedAt: Date,
  energyWh: number,
): Promise<number> {
  const idleMinutes = sessionIdleMinutesAt(session, endedAt);
  const gracePeriodMinutes = await getIdlingGracePeriodMinutes();
  const holdingMinutes = await reservationHoldingMinutes(sql, session);

  const splitEnabled = await isSplitBillingEnabled();
  const segments = splitEnabled
    ? await sql`
        SELECT sts.started_at, sts.ended_at, sts.energy_wh_start, sts.energy_wh_end,
               sts.idle_minutes AS seg_idle_minutes,
               t.price_per_kwh, t.price_per_minute, t.price_per_session,
               t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate
        FROM session_tariff_segments sts
        JOIN tariffs t ON t.id = sts.tariff_id
        WHERE sts.session_id = ${session.id}
        ORDER BY sts.started_at
      `
    : [];

  if (splitEnabled && segments.length > 1) {
    const closedIdleSum = segments.reduce(
      (sum, seg) => (seg.ended_at != null ? sum + Number(seg.seg_idle_minutes ?? 0) : sum),
      0,
    );
    const openIdleMinutes = Math.max(0, idleMinutes - closedIdleSum);
    const tariffSegments: TariffSegment[] = segments.map((seg, index) => {
      const isOpen = seg.ended_at == null;
      const segStartMs = new Date(seg.started_at as string).getTime();
      const segEndMs = isOpen ? endedAt.getTime() : new Date(seg.ended_at as string).getTime();
      const segEnergyEnd = isOpen ? energyWh : Number(seg.energy_wh_end ?? 0);
      return {
        tariff: {
          pricePerKwh: seg.price_per_kwh as string | null,
          pricePerMinute: seg.price_per_minute as string | null,
          pricePerSession: seg.price_per_session as string | null,
          idleFeePricePerMinute: seg.idle_fee_price_per_minute as string | null,
          reservationFeePerMinute: seg.reservation_fee_per_minute as string | null,
          taxRate: seg.tax_rate as string | null,
        },
        durationMinutes: (segEndMs - segStartMs) / 60000,
        energyDeliveredWh: segEnergyEnd - Number(seg.energy_wh_start ?? 0),
        idleMinutes: isOpen ? openIdleMinutes : Number(seg.seg_idle_minutes ?? 0),
        isFirstSegment: index === 0,
      };
    });
    return calculateSplitSessionCost(tariffSegments, gracePeriodMinutes, holdingMinutes).totalCents;
  }

  // The reservation fee is not snapshotted on the session. It only applies to
  // holding minutes.
  let reservationFeePerMinute: string | null = null;
  if (session.tariff_id != null && holdingMinutes > 0) {
    const tariffRows = await sql`
      SELECT reservation_fee_per_minute FROM tariffs WHERE id = ${session.tariff_id}
    `;
    reservationFeePerMinute =
      (tariffRows[0]?.reservation_fee_per_minute as string | null | undefined) ?? null;
  }

  const durationMinutes = (endedAt.getTime() - new Date(session.started_at).getTime()) / 60000;
  return calculateSessionCost(
    {
      pricePerKwh: session.tariff_price_per_kwh,
      pricePerMinute: session.tariff_price_per_minute,
      pricePerSession: session.tariff_price_per_session,
      idleFeePricePerMinute: session.tariff_idle_fee_price_per_minute,
      reservationFeePerMinute,
      taxRate: session.tariff_tax_rate,
    },
    energyWh,
    durationMinutes,
    idleMinutes,
    gracePeriodMinutes,
    holdingMinutes,
  ).totalCents;
}
