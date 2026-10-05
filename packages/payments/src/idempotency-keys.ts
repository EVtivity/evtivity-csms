// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';

/**
 * Idempotency keys of operations on an existing provider payment (P7).
 *
 * Providers keep a key and replay its first answer: Adyen for at least 7 days
 * per merchant account, Stripe for 24 hours. A key built from a local record
 * id repeats when a database is restored or re-created, or when two
 * environments share one provider account, and the provider then answers a
 * new operation with an old one (a capture reported done that never
 * happened). These keys are built from the provider's payment id, which is
 * unique at the provider, plus what tells two different operations on that
 * payment apart. They stay deterministic, so a retry reuses its key.
 *
 * Keys that create a payment are built from a globally unique id where they
 * are made: `preauth_<sessionId>`, `guest_preauth_<sessionToken>`, and the
 * top-ups below (the parent payment id).
 */

/** Adyen accepts keys of at most 64 characters (Stripe 255). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/**
 * The key as is when it fits, else `<prefix>_<sha256(key)[:40]>`, which is as
 * deterministic and as unique.
 */
function bounded(prefix: string, key: string): string {
  if (key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return key;
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** Capture of a hold. One capture per hold, whoever asks (settlement, operator, guest worker). */
export function captureKey(paymentId: string): string {
  return bounded('capture', `capture_${paymentId}`);
}

/** Cancel of a hold. One cancel per hold, whichever path cancels it. */
export function cancelKey(paymentId: string): string {
  return bounded('cancel', `cancel_${paymentId}`);
}

/** The settlement top-up of a hold's shortfall (creates a payment: one per hold). */
export function topUpKey(paymentId: string): string {
  return bounded('topup', `topup_${paymentId}`);
}

/**
 * A retry top-up of a recorded shortfall. The captured total tells retries
 * apart: it rises when one succeeds, so the next shortfall gets a new key.
 */
export function topUpRetryKey(paymentId: string, capturedCents: number): string {
  return bounded('topup_retry', `topup_retry_${paymentId}_${String(capturedCents)}`);
}

/** Authorisation adjustment of a hold to a new total. */
export function adjustKey(paymentId: string, newTotalCents: number): string {
  return bounded('adjust', `adjust_${paymentId}_${String(newTotalCents)}`);
}

/**
 * A refund request on a payment (the hold's payment id). The refunded total
 * so far (pending refunds included), the amount and the number of refunds the
 * record lists (`provider_refunds`, failed ones included) tell requests apart:
 * a retry of a request that wrote nothing reuses its key, a request after a
 * refund failed gets a new one. Top-up n of the request adds `_topup_<n>`.
 */
export function refundKey(
  paymentId: string,
  input: { refundedSoFarCents: number; amountCents: number; ledgerEntries: number },
  topUpNumber?: number,
): string {
  const request = `refund_${paymentId}_${String(input.refundedSoFarCents)}_${String(input.amountCents)}_${String(input.ledgerEntries)}`;
  const key = topUpNumber == null ? request : `${request}_topup_${String(topUpNumber)}`;
  return bounded('refund', key);
}

/**
 * A reservation cancellation or no-show fee charge (creates a payment: one
 * per reservation and fee type). It is also the charge's provider reference,
 * which a refund of the fee reuses. Not bounded: it must stay the key the
 * existing charges were made with.
 */
export function reservationFeeKey(
  type: 'reservation_cancellation' | 'reservation_no_show',
  reservationId: string,
): string {
  const prefix = type === 'reservation_cancellation' ? 'cancellation-fee' : 'no-show-fee';
  return `${prefix}-${reservationId}`;
}
