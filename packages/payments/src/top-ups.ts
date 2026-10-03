// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The charges behind one session payment record. A session whose final cost
 * exceeded its hold is paid by the hold capture plus one or more top-up
 * payments (the shortfall top-up at settlement, then any retry top-up). The
 * record keeps the total in `captured_amount_cents` and `refunded_amount_cents`;
 * the top-ups live in `metadata.topUps`, in charge order:
 *
 *   metadata.topUps: [{ paymentId, amountCents, refundedCents }]
 *
 * The hold charge is `stripe_payment_intent_id` with
 * captured = captured_amount_cents - sum(topUps.amountCents) and
 * refunded = refunded_amount_cents - sum(topUps.refundedCents).
 *
 * Records written before this shape hold the settlement top-up id only, as
 * `metadata.topUpIntentId`; its amount is the capture above the hold. Plan P4
 * (D-P5) moves the ids to `provider_topup_payment_ids`.
 */

export interface TopUpCharge {
  paymentId: string;
  amountCents: number;
  refundedCents: number;
}

export interface PaymentCharge {
  kind: 'hold' | 'top_up';
  paymentId: string;
  capturedCents: number;
  refundedCents: number;
  /** 1-based position of a top-up in `metadata.topUps`; 0 for the hold. */
  number: number;
}

export interface ChargeRecord {
  stripePaymentIntentId: string | null;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  preAuthAmountCents: number | null;
  metadata: unknown;
}

function isTopUp(value: unknown): value is TopUpCharge {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['paymentId'] === 'string' &&
    typeof v['amountCents'] === 'number' &&
    typeof v['refundedCents'] === 'number'
  );
}

/** The record's top-ups, including a legacy `topUpIntentId`. */
export function topUpCharges(record: ChargeRecord): TopUpCharge[] {
  const metadata =
    record.metadata != null && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : {};
  const stored = metadata['topUps'];
  if (Array.isArray(stored)) return stored.filter(isTopUp);
  const legacyId = metadata['topUpIntentId'];
  if (typeof legacyId !== 'string' || legacyId === '') return [];
  // Settlement captured at most the hold and charged the rest as the top-up.
  const captured = record.capturedAmountCents ?? 0;
  const held = Math.min(captured, record.preAuthAmountCents ?? captured);
  const amountCents = captured - held;
  return amountCents > 0 ? [{ paymentId: legacyId, amountCents, refundedCents: 0 }] : [];
}

/** The hold charge first, then each top-up, with what each captured and refunded. */
export function paymentCharges(record: ChargeRecord): PaymentCharge[] {
  const topUps = topUpCharges(record);
  const topUpCaptured = topUps.reduce((sum, t) => sum + t.amountCents, 0);
  const topUpRefunded = topUps.reduce((sum, t) => sum + t.refundedCents, 0);
  const charges: PaymentCharge[] = [];
  if (record.stripePaymentIntentId != null) {
    charges.push({
      kind: 'hold',
      paymentId: record.stripePaymentIntentId,
      capturedCents: Math.max(0, (record.capturedAmountCents ?? 0) - topUpCaptured),
      refundedCents: Math.max(0, record.refundedAmountCents - topUpRefunded),
      number: 0,
    });
  }
  topUps.forEach((t, i) => {
    charges.push({
      kind: 'top_up',
      paymentId: t.paymentId,
      capturedCents: t.amountCents,
      refundedCents: t.refundedCents,
      number: i + 1,
    });
  });
  return charges;
}

export interface RefundPiece {
  charge: PaymentCharge;
  amountCents: number;
}

/**
 * Splits a refund over the charges: the hold first, then each top-up in
 * order, each up to what it still has unrefunded. Returns fewer cents than
 * asked only when the charges hold less than that.
 */
export function allocateRefund(charges: PaymentCharge[], amountCents: number): RefundPiece[] {
  const pieces: RefundPiece[] = [];
  let left = amountCents;
  for (const charge of charges) {
    if (left <= 0) break;
    const take = Math.min(left, charge.capturedCents - charge.refundedCents);
    if (take <= 0) continue;
    pieces.push({ charge, amountCents: take });
    left -= take;
  }
  return pieces;
}

/** The top-ups with each charge's refunded total raised to `refundedCents` (never lowered). */
export function withTopUpRefunds(
  topUps: TopUpCharge[],
  refunded: ReadonlyMap<string, number>,
): TopUpCharge[] {
  return topUps.map((t) => ({
    ...t,
    refundedCents: Math.max(t.refundedCents, refunded.get(t.paymentId) ?? 0),
  }));
}
