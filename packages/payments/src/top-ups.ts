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
 * The hold charge is `provider_payment_id` with
 * captured = captured_amount_cents - sum(topUps.amountCents) and
 * refunded = refunded_amount_cents - sum(topUps.refundedCents).
 *
 * A webhook finds the record of a top-up payment through the GIN index
 * `idx_payment_records_top_ups` on `metadata -> 'topUps'`. Records of writers
 * before v0.1.37 held only `metadata.topUpIntentId`; migration 0121 and the
 * `payment_records_provider_sync` trigger rewrite it as `topUps`.
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
  providerPaymentId: string | null;
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

/** The record's top-ups (`metadata.topUps`). */
export function topUpCharges(record: ChargeRecord): TopUpCharge[] {
  const metadata =
    record.metadata != null && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : {};
  const stored = metadata['topUps'];
  return Array.isArray(stored) ? stored.filter(isTopUp) : [];
}

/** The hold charge first, then each top-up, with what each captured and refunded. */
export function paymentCharges(record: ChargeRecord): PaymentCharge[] {
  const topUps = topUpCharges(record);
  const topUpCaptured = topUps.reduce((sum, t) => sum + t.amountCents, 0);
  const topUpRefunded = topUps.reduce((sum, t) => sum + t.refundedCents, 0);
  const charges: PaymentCharge[] = [];
  if (record.providerPaymentId != null) {
    charges.push({
      kind: 'hold',
      paymentId: record.providerPaymentId,
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

/**
 * Cents captured above the hold that no listed top-up accounts for. A hold
 * captures at most its authorized amount (`pre_auth_amount_cents`), so this
 * is a top-up whose payment id was never stored: a retry top-up made before
 * v0.1.37 kept its id only in `last_action_reason`, which a later action
 * overwrites. EVtivity cannot refund that charge. 0 for a record without a
 * hold payment or a hold amount.
 */
export function unlistedTopUpCents(record: ChargeRecord): number {
  if (record.providerPaymentId == null || record.preAuthAmountCents == null) return 0;
  const listed = topUpCharges(record).reduce((sum, t) => sum + t.amountCents, 0);
  return Math.max(0, (record.capturedAmountCents ?? 0) - listed - record.preAuthAmountCents);
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
