// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, reservations } from '@evtivity/database';
import { getReservationSettings, writeReservationAudit } from '@evtivity/database';
import { chargeReservationCancellationFee } from './reservation-fees.js';

/** Who triggered the cancellation. */
export type ReservationCancelledBy = 'driver' | 'operator' | 'system';

/** Stable enum of cancel reasons. */
export type ReservationCancelReason =
  | 'driver_initiated'
  | 'operator_manual'
  | 'expired_no_show'
  | 'station_rejected_occupied'
  | 'station_rejected_other'
  | 'station_offline_at_activation'
  | 'system_cleanup';

export interface ReservationCancelInput {
  /** Internal reservation row id (text PK). */
  reservationDbId: string;
  /** Site for Stripe lookups (nullable when station has no site). */
  siteId: string | null;
  /** Driver to charge; null for guest/operator-only reservations (skip fee). */
  driverId: string | null;
  /** Effective starts_at for the cancellation-window calculation. */
  startsAt: Date;
  /** Created_at fallback when starts_at is null. */
  createdAt: Date;
  actor: ReservationCancelledBy;
  /**
   * Operator userId when `actor==='operator'`. Stored on the audit row.
   */
  actorUserId?: string | null | undefined;
  /**
   * Driver id when `actor==='driver'`. Stored on the audit row.
   */
  actorDriverId?: string | null | undefined;
  reason: ReservationCancelReason;
  /** Optional free-text note; persisted for operator-initiated cancels. */
  note?: string | undefined;
  /**
   * Whether the caller wants to charge the cancellation fee. The actual
   * decision is gated by:
   *   - actor: 'system' is hard-no regardless of this flag
   *   - settings.cancellationFeeCents > 0 and cancellationWindowMinutes > 0
   *   - the reservation is being cancelled inside the cancellation window
   *   - the driver has a default payment method (silently skipped otherwise)
   */
  chargeFee: boolean;
  logger?: FastifyBaseLogger | undefined;
}

export interface ReservationCancelResult {
  /** Number of cents actually charged (0 when waived, no PM, error, etc.). */
  feeChargedCents: number;
  /** True if the row was updated (false if it was already terminal). */
  cancelled: boolean;
  /** True when a fee was attempted but the Stripe charge threw. */
  feeChargeFailed: boolean;
}

/**
 * Centralized cancellation: writes the actor + reason metadata, optionally
 * charges the fee, and marks the row cancelled. Every cancel path (operator
 * route, portal route, command.ReserveNow projection, fleet routes, etc.)
 * must go through this helper so the metadata stays consistent and the
 * system path can never accidentally charge a fee.
 *
 * Concurrency contract:
 *   1. The status flip is conditional on the row being still active/scheduled.
 *      If two concurrent cancels race, only one wins; the loser sees
 *      `cancelled: false` and skips fee dispatch.
 *   2. The conditional UPDATE writes `cancellation_fee_cents = 0`. The Stripe
 *      charge runs ONLY after the update returns a row, then a follow-up
 *      UPDATE writes the actual `cancellation_fee_cents = feeChargedCents`.
 *      A process crash between charge and the second UPDATE leaves the audit
 *      row showing 0 cents while Stripe holds the money -- that's recoverable
 *      by reconciling against Stripe (the idempotency key is the reservation
 *      id, so retried calls won't double-charge). The opposite direction
 *      (write planned fee first, charge later) would leak the row showing a
 *      fee that was never collected.
 *   3. If the Stripe charge throws, we surface `feeChargeFailed: true`. No
 *      additional patch is needed: the row already shows 0 cents.
 *
 * The OCPP CancelReservation command and driver notification are still
 * dispatched by the caller -- this helper only handles DB state and the
 * payment side effect.
 */
export async function applyReservationCancellation(
  input: ReservationCancelInput,
): Promise<ReservationCancelResult> {
  const settings = await getReservationSettings();

  const wantsFee = input.chargeFee && input.actor !== 'system';
  let plannedFeeCents = 0;

  if (
    wantsFee &&
    settings.cancellationFeeCents > 0 &&
    settings.cancellationWindowMinutes > 0 &&
    input.driverId != null
  ) {
    const minutesUntilStart = Math.floor((input.startsAt.getTime() - Date.now()) / 60_000);
    if (minutesUntilStart < settings.cancellationWindowMinutes) {
      plannedFeeCents = settings.cancellationFeeCents;
    }
  }

  // Conditional UPDATE: only one concurrent cancel can win. The RETURNING
  // pulls the status from a CTE that captures the row's status BEFORE the
  // SET applies, so the audit row gets the real previous status
  // ('active' or 'scheduled') instead of null. The CTE approach keeps this
  // as one round-trip and avoids a TOCTOU between a separate SELECT and
  // the UPDATE.
  const updated = await db.execute<{ id: string; status_before: string }>(
    sql`
      WITH old AS (
        SELECT id, status AS status_before
        FROM ${reservations}
        WHERE id = ${input.reservationDbId}
          AND status IN ('active', 'scheduled')
      )
      UPDATE ${reservations}
      SET status = 'cancelled',
          cancelled_by = ${input.actor}::reservation_cancelled_by,
          cancel_reason = ${input.reason}::reservation_cancel_reason,
          cancel_note = ${input.note ?? null},
          cancellation_fee_cents = 0,
          updated_at = now()
      FROM old
      WHERE ${reservations}.id = old.id
      RETURNING ${reservations}.id, old.status_before
    `,
  );

  const winningRow = (updated as unknown as Array<{ id: string; status_before: string }>)[0];
  if (winningRow == null) {
    // Lost the race or the row was already terminal.
    return { feeChargedCents: 0, cancelled: false, feeChargeFailed: false };
  }

  // Exactly one writer (the conditional-UPDATE winner) writes the audit row.
  // Concurrent cancels that lose the race above return early and skip this.
  // notes carries only the optional free-text note; the reason enum already
  // lives on reservations.cancel_reason and would be duplicated here.
  await writeReservationAudit({
    reservationId: input.reservationDbId,
    action: 'cancelled',
    actor: input.actor,
    actorUserId: input.actorUserId ?? null,
    actorDriverId: input.actorDriverId ?? null,
    driverIdBefore: input.driverId,
    driverIdAfter: input.driverId,
    statusBefore: winningRow.status_before,
    statusAfter: 'cancelled',
    notes: input.note != null && input.note !== '' ? input.note : null,
  });

  if (plannedFeeCents === 0) {
    return { feeChargedCents: 0, cancelled: true, feeChargeFailed: false };
  }

  let feeChargedCents = 0;
  let feeChargeFailed = false;
  try {
    await chargeReservationCancellationFee(
      input.driverId as string,
      input.siteId,
      plannedFeeCents,
      input.reservationDbId,
    );
    feeChargedCents = plannedFeeCents;
    // Fee captured; persist the actual amount on the audit row.
    await db
      .update(reservations)
      .set({ cancellationFeeCents: feeChargedCents, updatedAt: new Date() })
      .where(eq(reservations.id, input.reservationDbId));
  } catch (err) {
    feeChargeFailed = true;
    input.logger?.error(
      { err, reservationId: input.reservationDbId, actor: input.actor, plannedFeeCents },
      'cancellation fee charge failed',
    );
    // Row already shows cancellation_fee_cents = 0; nothing to patch.
  }

  return { feeChargedCents, cancelled: true, feeChargeFailed };
}
