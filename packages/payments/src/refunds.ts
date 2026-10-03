// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { pinnedProvider } from './pinning.js';
import { lockSessionRecord, markRefunded } from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import { allocateRefund, paymentCharges, topUpCharges, withTopUpRefunds } from './top-ups.js';

export interface RefundRequest {
  sessionId: string;
  /** Default: everything still refundable. */
  amountCents?: number;
  /** Stored as `last_actor_user_id` when given. */
  actorUserId?: string | null;
  /** Stored as `last_action_reason` when given. */
  actionReason?: (full: boolean) => string | null;
}

/** One provider refund of a refund request. */
export interface ChargeRefund {
  paymentId: string;
  kind: 'hold' | 'top_up';
  amountCents: number;
}

export type RefundOutcome =
  | {
      status: 'refunded';
      record: PaymentRecord;
      refundedNowCents: number;
      full: boolean;
      /** The provider refunds made, the hold charge first, then each top-up. */
      refunds: ChargeRefund[];
    }
  | { status: 'no_captured_payment' }
  | { status: 'missing_payment_id' }
  | { status: 'nothing_refundable'; remainingCents: number }
  | {
      status: 'exceeds_remaining';
      remainingCents: number;
      requestedCents: number;
      /** The record's currency, for the message. */
      currency: string;
    }
  | { status: 'not_configured'; providerId: string };

type TxResult =
  | RefundOutcome
  | { status: 'partially_failed'; failure: unknown; refunds: ChargeRefund[]; recordId: number };

/**
 * Refunds a session's captured payment through the provider it is pinned to,
 * for the operator route and support cases alike. The record is locked for
 * the refund so a concurrent refund cannot read a stale refunded total.
 *
 * A session paid as hold capture plus top-ups (`top-ups.ts`) is refunded per
 * charge: the hold charge first, then each top-up in order, each up to what
 * it has not refunded yet, one provider refund per charge. The request key
 * `refund_<paymentId>_<recordId>_<refundedSoFar>_<amount>` (P7) is the hold
 * charge's idempotency key and `<key>_topup_<n>` that of top-up n, so a
 * retried request reuses the provider refunds while a later partial refund
 * gets new keys because the refunded total changed. A payment without
 * top-ups makes the single hold refund it always did.
 *
 * A provider failure throws (fail loud). When it fails on a later charge
 * after earlier charges were refunded, the refunds made are recorded first
 * (P4: the record matches the provider) and the error is thrown after.
 */
export async function refundPaymentRecord(
  request: RefundRequest,
  ctx: PaymentContext,
): Promise<RefundOutcome> {
  const result = await db.transaction(async (tx): Promise<TxResult> => {
    const locked = await lockSessionRecord(tx, request.sessionId);
    if (
      locked == null ||
      (locked.status !== 'captured' && locked.status !== 'partially_refunded')
    ) {
      return { status: 'no_captured_payment' };
    }
    const paymentId = locked.stripePaymentIntentId;
    if (paymentId == null) return { status: 'missing_payment_id' };

    const captured = locked.capturedAmountCents ?? 0;
    const alreadyRefunded = locked.refundedAmountCents;
    const remaining = captured - alreadyRefunded;
    const requested = request.amountCents ?? remaining;
    if (remaining <= 0) return { status: 'nothing_refundable', remainingCents: remaining };
    if (requested <= 0 || requested > remaining) {
      return {
        status: 'exceeds_remaining',
        remainingCents: remaining,
        requestedCents: requested,
        currency: locked.currency,
      };
    }

    let provider;
    try {
      provider = await pinnedProvider(ctx.registry, {
        customerId: locked.stripeCustomerId,
        paymentId,
      });
    } catch (err) {
      if (err instanceof PaymentProviderNotConfiguredError) {
        return { status: 'not_configured', providerId: err.providerId };
      }
      throw err;
    }

    const requestKey = `${String(locked.id)}_${String(alreadyRefunded)}_${String(requested)}`;
    const baseKey = `refund_${paymentId}_${requestKey}`;
    const pieces = allocateRefund(paymentCharges(locked), requested);
    const refunds: ChargeRefund[] = [];
    let failure: { error: unknown } | null = null;
    for (const piece of pieces) {
      try {
        await provider.refund({
          paymentId: piece.charge.paymentId,
          amountCents: piece.amountCents,
          currency: locked.currency,
          merchantReference: `sess_${request.sessionId}`,
          idempotencyKey:
            piece.charge.kind === 'hold'
              ? baseKey
              : `${baseKey}_topup_${String(piece.charge.number)}`,
        });
      } catch (err) {
        // Nothing refunded yet: nothing to record.
        if (refunds.length === 0) throw err;
        failure = { error: err };
        break;
      }
      refunds.push({
        paymentId: piece.charge.paymentId,
        kind: piece.charge.kind,
        amountCents: piece.amountCents,
      });
    }

    const refundedNow = refunds.reduce((sum, r) => sum + r.amountCents, 0);
    const refundedTotal = alreadyRefunded + refundedNow;
    const full = refundedTotal >= captured;
    const topUps = topUpCharges(locked);
    const refundedByCharge = new Map<string, number>();
    for (const r of refunds) {
      if (r.kind !== 'top_up') continue;
      const before = topUps.find((t) => t.paymentId === r.paymentId)?.refundedCents ?? 0;
      refundedByCharge.set(r.paymentId, before + r.amountCents);
    }
    const record = await markRefunded(
      locked.id,
      {
        refundedTotalCents: refundedTotal,
        full,
        actorUserId: request.actorUserId ?? null,
        actionReason: request.actionReason?.(full) ?? null,
        ...(topUps.length > 0 ? { topUps: withTopUpRefunds(topUps, refundedByCharge) } : {}),
      },
      tx,
    );
    if (record == null) {
      // The row is locked, so this means its status changed under the lock.
      throw new Error(`Payment record ${String(locked.id)} could not be marked refunded`);
    }
    if (failure != null) {
      return { status: 'partially_failed', failure: failure.error, refunds, recordId: locked.id };
    }
    return { status: 'refunded', record, refundedNowCents: refundedNow, full, refunds };
  });

  if (result.status === 'partially_failed') {
    ctx.logger.error(
      { err: result.failure, paymentRecordId: result.recordId, refunds: result.refunds },
      'Refund failed after earlier charges of the payment were refunded; those are recorded',
    );
    throw result.failure;
  }
  return result;
}
