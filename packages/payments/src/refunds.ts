// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { refundKey, reservationFeeKey } from './idempotency-keys.js';
import { pinnedProvider } from './pinning.js';
import {
  addPendingRefunds,
  lockRecord,
  lockSessionRecord,
  markRefunded,
} from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import {
  allocateRefund,
  paymentCharges,
  topUpCharges,
  unlistedTopUpCents,
  withTopUpRefunds,
} from './top-ups.js';

/**
 * What is refunded: a session's payment record, or a reservation
 * cancellation or no-show fee record by its id.
 */
export type RefundTarget = { sessionId: string } | { feeRecordId: number };

export type RefundRequest = RefundTarget & {
  /** Default: everything still refundable. */
  amountCents?: number;
  /** Stored as `last_actor_user_id` when given. */
  actorUserId?: string | null;
  /** Stored as `last_action_reason` when given. */
  actionReason?: (full: boolean) => string | null;
};

/** One provider refund of a refund request. */
export interface ChargeRefund {
  paymentId: string;
  kind: 'hold' | 'top_up';
  amountCents: number;
  /** The provider's refund id (async providers: the reference its webhook confirms). */
  refundId: string;
  /** `pending` until an async provider confirms it by webhook. */
  state: 'succeeded' | 'pending';
}

export type RefundOutcome =
  | {
      status: 'refunded';
      record: PaymentRecord;
      /** Refunded and confirmed by the provider now. */
      refundedNowCents: number;
      /** Accepted by an async provider, confirmed later by webhook. */
      pendingCents: number;
      /** `pending` when the provider confirms the refund later (the total is not raised yet). */
      refundStatus: 'succeeded' | 'pending';
      full: boolean;
      /** The provider refunds made, the hold charge first, then each top-up. */
      refunds: ChargeRefund[];
    }
  /** An async capture is not confirmed yet (owner decision O3: refuse until it is). */
  | { status: 'operation_pending'; operation: 'capture' | 'cancel' | 'adjust' }
  /** A fee target that does not exist or is not a reservation fee record. */
  | { status: 'not_found' }
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
  | {
      /**
       * The refund reaches a top-up whose payment id was never stored (a
       * retry top-up before v0.1.37). Up to `refundableCents` can be refunded
       * here; the operator refunds the rest in the provider's dashboard.
       */
      status: 'top_up_unknown';
      refundableCents: number;
      unlistedCents: number;
      currency: string;
    }
  | { status: 'not_configured'; providerId: string };

type TxResult =
  | RefundOutcome
  | { status: 'partially_failed'; failure: unknown; refunds: ChargeRefund[]; recordId: number };

/**
 * Refunds a captured payment through the provider it is pinned to: a
 * session's record (operator route and support cases) or a reservation
 * cancellation or no-show fee record (operator fee refund route), with the
 * same rules and keys. The record is locked for the refund so a concurrent
 * refund cannot read a stale refunded total.
 *
 * A session paid as hold capture plus top-ups (`top-ups.ts`) is refunded per
 * charge: the hold charge first, then each top-up in order, each up to what
 * it has not refunded yet, one provider refund per charge. The request key
 * `refund_<paymentId>_<refundedSoFar>_<amount>_<ledgerEntries>` (P7,
 * `refundKey`; the hold's payment id) is the hold charge's idempotency key
 * and `<key>_topup_<n>` that of top-up n, so a retried request reuses the
 * provider refunds while a later partial refund, or a request after a failed
 * refund, gets new keys because the refunded total or the ledger changed. A
 * payment without top-ups makes the single hold refund it always did.
 *
 * An async provider (Adyen) accepts a refund and confirms it by webhook: the
 * refund goes into the `provider_refunds` ledger as `pending`
 * (`refundStatus: 'pending'`) and counts as refunded for the next request,
 * but the refunded total rises only when the webhook confirms it
 * (`settleRefund`). A synchronous refund raises the total now and is listed
 * as `succeeded`. A record with an unconfirmed capture is refused
 * (`operation_pending`, owner decision O3).
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
    let locked: PaymentRecord | null;
    if ('feeRecordId' in request) {
      locked = await lockRecord(tx, request.feeRecordId);
      if (locked == null || locked.chargeType === 'session') return { status: 'not_found' };
    } else {
      locked = await lockSessionRecord(tx, request.sessionId);
    }
    if (
      locked == null ||
      (locked.status !== 'captured' && locked.status !== 'partially_refunded')
    ) {
      return { status: 'no_captured_payment' };
    }
    const paymentId = locked.providerPaymentId;
    if (paymentId == null) return { status: 'missing_payment_id' };
    // A refund of a capture the provider may still fail would refund money
    // never taken (O3).
    if (locked.pendingOperation != null) {
      return { status: 'operation_pending', operation: locked.pendingOperation };
    }

    const captured = locked.capturedAmountCents ?? 0;
    // Refunds an async provider accepted but has not confirmed count as
    // refunded here, so they are never requested twice.
    const pendingByCharge = new Map<string, number>();
    for (const r of locked.providerRefunds) {
      if (r.state !== 'pending') continue;
      pendingByCharge.set(r.paymentId, (pendingByCharge.get(r.paymentId) ?? 0) + r.amountCents);
    }
    const pendingTotal = [...pendingByCharge.values()].reduce((sum, c) => sum + c, 0);
    const alreadyRefunded = locked.refundedAmountCents + pendingTotal;
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

    const unlistedCents = unlistedTopUpCents(locked);
    if (unlistedCents > 0 && requested > remaining - unlistedCents) {
      return {
        status: 'top_up_unknown',
        refundableCents: Math.max(0, remaining - unlistedCents),
        unlistedCents,
        currency: locked.currency,
      };
    }

    let provider;
    try {
      provider = await pinnedProvider(ctx.registry, locked.provider);
    } catch (err) {
      if (err instanceof PaymentProviderNotConfiguredError) {
        return { status: 'not_configured', providerId: err.providerId };
      }
      throw err;
    }

    const keyParts = {
      refundedSoFarCents: alreadyRefunded,
      amountCents: requested,
      ledgerEntries: locked.providerRefunds.length,
    };
    const merchantReference = refundMerchantReference(request, locked);
    const charges = paymentCharges(locked).map((c) => ({
      ...c,
      refundedCents: c.refundedCents + (pendingByCharge.get(c.paymentId) ?? 0),
    }));
    const pieces = allocateRefund(charges, requested);
    const refunds: ChargeRefund[] = [];
    let failure: { error: unknown } | null = null;
    for (const piece of pieces) {
      let result;
      try {
        result = await provider.refund({
          paymentId: piece.charge.paymentId,
          amountCents: piece.amountCents,
          currency: locked.currency,
          merchantReference,
          idempotencyKey:
            piece.charge.kind === 'hold'
              ? refundKey(paymentId, keyParts)
              : refundKey(paymentId, keyParts, piece.charge.number),
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
        refundId: result.state === 'succeeded' ? result.refundId : result.operationRef,
        state: result.state,
      });
    }

    const done = refunds.filter((r) => r.state === 'succeeded');
    const pending = refunds.filter((r) => r.state === 'pending');
    const refundedNow = done.reduce((sum, r) => sum + r.amountCents, 0);
    const pendingCents = pending.reduce((sum, r) => sum + r.amountCents, 0);
    const refundedTotal = locked.refundedAmountCents + refundedNow;
    const full = refundedTotal >= captured;
    const actor = {
      actorUserId: request.actorUserId ?? null,
      actionReason:
        request.actionReason?.(alreadyRefunded + refundedNow + pendingCents >= captured) ?? null,
    };
    let record: PaymentRecord | null = locked;
    if (done.length > 0) {
      const topUps = topUpCharges(locked);
      const refundedByCharge = new Map<string, number>();
      for (const r of done) {
        if (r.kind !== 'top_up') continue;
        const before = topUps.find((t) => t.paymentId === r.paymentId)?.refundedCents ?? 0;
        refundedByCharge.set(r.paymentId, before + r.amountCents);
      }
      const settledAt = new Date().toISOString();
      record = await markRefunded(
        locked.id,
        {
          refundedTotalCents: refundedTotal,
          full,
          ...actor,
          ...(topUps.length > 0 ? { topUps: withTopUpRefunds(topUps, refundedByCharge) } : {}),
          ledger: done.map((r) => ({
            refundId: r.refundId,
            paymentId: r.paymentId,
            amountCents: r.amountCents,
            state: 'succeeded' as const,
            requestedAt: settledAt,
            settledAt,
          })),
        },
        tx,
      );
    }
    if (record != null && pending.length > 0) {
      record = await addPendingRefunds(
        locked.id,
        pending.map((r) => ({
          refundId: r.refundId,
          paymentId: r.paymentId,
          amountCents: r.amountCents,
        })),
        actor,
        tx,
      );
    }
    if (record == null) {
      // The row is locked, so this means its status changed under the lock.
      throw new Error(`Payment record ${String(locked.id)} could not be marked refunded`);
    }
    if (failure != null) {
      return { status: 'partially_failed', failure: failure.error, refunds, recordId: locked.id };
    }
    return {
      status: 'refunded',
      record,
      refundedNowCents: refundedNow,
      pendingCents,
      refundStatus: pending.length > 0 ? 'pending' : 'succeeded',
      full,
      refunds,
    };
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

/**
 * The provider reference of a refund: the session's (`sess_<id>`), or the
 * reference the fee was charged with (`cancellation-fee-<reservationId>`,
 * `no-show-fee-<reservationId>`). A fee whose reservation was deleted uses
 * `fee_<paymentId>`.
 */
function refundMerchantReference(target: RefundTarget, record: PaymentRecord): string {
  if ('sessionId' in target) return `sess_${target.sessionId}`;
  if (record.chargeType !== 'session' && record.reservationId != null) {
    return reservationFeeKey(record.chargeType, record.reservationId);
  }
  return `fee_${record.providerPaymentId ?? String(record.id)}`;
}
