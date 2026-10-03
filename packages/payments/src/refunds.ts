// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { pinnedProvider } from './pinning.js';
import { lockSessionRecord, markRefunded } from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';

export interface RefundRequest {
  sessionId: string;
  /** Default: everything still refundable. */
  amountCents?: number;
  /** Stored as `last_actor_user_id` when given. */
  actorUserId?: string | null;
  /** Stored as `last_action_reason` when given. */
  actionReason?: (full: boolean) => string | null;
}

export type RefundOutcome =
  | { status: 'refunded'; record: PaymentRecord; refundedNowCents: number; full: boolean }
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

/**
 * Refunds a session's captured payment through the provider it is pinned to,
 * for the operator route and support cases alike. The record is locked for
 * the refund so a concurrent refund cannot read a stale refunded total. The
 * idempotency key `refund_<paymentId>_<recordId>_<refundedSoFar>_<amount>`
 * (P7) makes a retried request reuse the provider refund, while a later
 * partial refund gets a new key because the refunded total changed. A
 * provider failure throws (fail loud); nothing is written then.
 */
export async function refundPaymentRecord(
  request: RefundRequest,
  ctx: PaymentContext,
): Promise<RefundOutcome> {
  return db.transaction(async (tx) => {
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
    await provider.refund({
      paymentId,
      amountCents: requested,
      currency: locked.currency,
      merchantReference: `sess_${request.sessionId}`,
      idempotencyKey: `refund_${paymentId}_${requestKey}`,
    });

    const refundedTotal = alreadyRefunded + requested;
    const full = refundedTotal >= captured;
    const record = await markRefunded(
      locked.id,
      {
        refundedTotalCents: refundedTotal,
        full,
        actorUserId: request.actorUserId ?? null,
        actionReason: request.actionReason?.(full) ?? null,
      },
      tx,
    );
    if (record == null) {
      // The row is locked, so this means its status changed under the lock.
      throw new Error(`Payment record ${String(locked.id)} could not be marked refunded`);
    }
    return { status: 'refunded', record, refundedNowCents: requested, full };
  });
}
