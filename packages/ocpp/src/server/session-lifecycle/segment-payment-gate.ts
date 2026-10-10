// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffPriceSnapshot } from '@evtivity/database';
import { isTariffFree } from '@evtivity/lib';
import type { ProjectionDeps } from '../projection-support/context.js';
import { runPaymentGate } from './payment-gate.js';
import type { PaymentGateDecision } from './payment-gate.js';

// Payment gate on a split billing switch (B3): a session that started on a
// free tariff and moved to a paid one runs the gate again, so it is held (a
// card) or stopped by the gate rules instead of charging unpaid. The start
// gate already treats a session as paid when its group has a paid tariff
// (paidAhead); this covers a paid tariff added to the group mid-session.

interface SegmentGateRow {
  status: string;
  transaction_id: string;
  driver_id: string | null;
  station_id: string;
  ocpp_station_id: string;
  site_id: string | null;
  is_roaming: boolean;
  free_vend: boolean;
  billing_mode: string | null;
  prepaid_balance_cents: number | null;
  guest_status: string | null;
  guest_email: string | null;
  guest_payment_id: string | null;
}

/**
 * True when the switch moves the session from a free start to a paid tariff:
 * the start tariff (the session snapshot) is free and `tariff` is not.
 */
export function isFreeToPaidSwitch(
  start: TariffPriceSnapshot | null,
  tariff: TariffPriceSnapshot,
): boolean {
  return isTariffFree(start) && !isTariffFree(tariff);
}

/**
 * Runs the payment gate for a session that moved to the paid `tariff`.
 * Roaming, free vend, prepaid and account sessions are paid without a card
 * hold whatever the tariff, so they are left alone. A card session gets the
 * hold on the driver's default card (key preauth_<sessionId>, so a hold the
 * start already placed is reused), and a guest who started free without a
 * card hold is stopped (GuestPaymentNotAuthorized). Returns the decision, or
 * null when the gate does not apply. Throws like the start gate (P9).
 */
export async function runSegmentPaymentGate(
  deps: ProjectionDeps,
  sessionId: string,
  tariff: TariffPriceSnapshot,
): Promise<PaymentGateDecision | null> {
  const [row] = await deps.sql<SegmentGateRow[]>`
    SELECT cs.status, cs.transaction_id, cs.driver_id, cs.station_id,
           st.station_id AS ocpp_station_id, st.site_id, cs.is_roaming, cs.free_vend,
           cs.billing_mode, dt.prepaid_balance_cents,
           g.status AS guest_status, g.guest_email, g.provider_payment_id AS guest_payment_id
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN driver_tokens dt ON dt.id = cs.token_id
    LEFT JOIN guest_sessions g ON g.charging_session_id = cs.id
    WHERE cs.id = ${sessionId}
    LIMIT 1
  `;
  if (row == null || row.status !== 'active') return null;
  if (row.is_roaming || row.free_vend || row.billing_mode === 'account') return null;
  if (row.prepaid_balance_cents != null) return null;
  const isGuest = row.guest_status != null;
  if (row.driver_id == null && !isGuest) return null;

  return runPaymentGate(deps, {
    sessionId,
    transactionId: row.transaction_id,
    driverId: row.driver_id,
    stationDbId: row.station_id,
    ocppStationId: row.ocpp_station_id,
    siteId: row.site_id,
    isRoaming: false,
    idToken: undefined,
    // A guest who started free has no card hold: the gate stops the session.
    guestStatus: isGuest ? (row.guest_payment_id != null ? row.guest_status : 'free_start') : null,
    guestEmail: row.guest_email,
    prepaidBalanceCents: null,
    reserved: false,
    sessionTariff: tariff,
    paidAhead: true,
  });
}

/** The start tariff snapshot from a charging_sessions row (tariff_* columns). */
export function sessionStartTariff(row: Record<string, unknown>): TariffPriceSnapshot | null {
  const id = row['tariff_id'];
  if (typeof id !== 'string') return null;
  const price = (key: string): string | null => {
    const value = row[key];
    if (typeof value === 'string') return value;
    return typeof value === 'number' ? String(value) : null;
  };
  return {
    id,
    pricePerKwh: price('tariff_price_per_kwh'),
    pricePerMinute: price('tariff_price_per_minute'),
    pricePerSession: price('tariff_price_per_session'),
    idleFeePricePerMinute: price('tariff_idle_fee_price_per_minute'),
    reservationFeePerMinute: price('tariff_reservation_fee_per_minute'),
    taxRate: price('tariff_tax_rate'),
  };
}

interface OpenSegmentPriceRow {
  tariff_id: string;
  price_per_kwh: string | null;
  price_per_minute: string | null;
  price_per_session: string | null;
  idle_fee_price_per_minute: string | null;
  reservation_fee_per_minute: string | null;
  tax_rate: string | null;
}

/**
 * Runs the gate for a session the worker's tariff boundary job marked
 * (payment_gate_due_at): claims the mark (one pod and reading runs it), then
 * gates the session at the prices of its open segment. A failed gate puts the
 * mark back and throws, so the projection retry runs it again (P9).
 */
export async function runDuePaymentGate(
  deps: ProjectionDeps,
  sessionId: string,
): Promise<PaymentGateDecision | null> {
  const claimed = await deps.sql`
    UPDATE charging_sessions SET payment_gate_due_at = NULL
    WHERE id = ${sessionId} AND payment_gate_due_at IS NOT NULL
    RETURNING id
  `;
  if (claimed.length === 0) return null;
  try {
    const [segment] = await deps.sql<OpenSegmentPriceRow[]>`
      SELECT tariff_id, price_per_kwh, price_per_minute, price_per_session,
             idle_fee_price_per_minute, reservation_fee_per_minute, tax_rate
      FROM session_tariff_segments
      WHERE session_id = ${sessionId} AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `;
    if (segment == null) return null;
    const tariff: TariffPriceSnapshot = {
      id: segment.tariff_id,
      pricePerKwh: segment.price_per_kwh,
      pricePerMinute: segment.price_per_minute,
      pricePerSession: segment.price_per_session,
      idleFeePricePerMinute: segment.idle_fee_price_per_minute,
      reservationFeePerMinute: segment.reservation_fee_per_minute,
      taxRate: segment.tax_rate,
    };
    if (isTariffFree(tariff)) return null;
    return await runSegmentPaymentGate(deps, sessionId, tariff);
  } catch (err) {
    await deps.sql`
      UPDATE charging_sessions SET payment_gate_due_at = now()
      WHERE id = ${sessionId} AND status = 'active' AND payment_gate_due_at IS NULL
    `;
    throw err;
  }
}
