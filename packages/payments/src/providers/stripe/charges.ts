// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { incrementalPlatformFeeCents } from '@evtivity/lib';
import type { ChargeTax } from '@evtivity/lib';

/**
 * Session charges on Stripe with the Connect platform fee recomputed on the
 * amount actually charged: the capture of a hold and the shortfall top-up.
 * The Stripe provider's `capture` and `chargeShortfall` call these, so every
 * path (OCPP capture on session end, operator capture and retry, guest
 * finalization, daily retry) charges the same fee. Typed structurally so the
 * tests can pass a fake client.
 *
 * Whether a charge is a destination charge (Stripe Connect) is read from the
 * original PaymentIntent (`transfer_data.destination`), not from the current
 * site config, so a config change between hold and capture never adds a fee
 * to a charge that has no connected account (Stripe rejects that).
 */
type StripeRef = string | { id: string } | null;

interface IntentLike {
  customer: StripeRef;
  payment_method: StripeRef;
  on_behalf_of?: StripeRef | undefined;
  transfer_data?: { destination: StripeRef } | null | undefined;
}

export interface TopUpIntentParams {
  amount: number;
  currency: string;
  customer: string;
  payment_method: string;
  confirm: true;
  off_session: true;
  capture_method: 'automatic';
  description: string;
  on_behalf_of?: string;
  transfer_data?: { destination: string };
  application_fee_amount?: number;
}

export interface CaptureParams {
  amount_to_capture: number;
  application_fee_amount?: number;
}

export interface StripeChargeClient {
  paymentIntents: {
    retrieve(id: string): Promise<IntentLike>;
    capture(
      id: string,
      params: CaptureParams,
      options?: { idempotencyKey: string },
    ): Promise<{ id: string }>;
    create(params: TopUpIntentParams, options: { idempotencyKey: string }): Promise<{ id: string }>;
  };
}

/** Rate and fee settings of a session charge. */
export interface SessionChargeFee {
  /** How the session's charges split into net and tax (sessionChargeTax). */
  taxRate: ChargeTax;
  /** Platform fee percent (getPlatformFeePercent for the session's site). */
  platformFeePercent: number;
}

function refId(ref: StripeRef | undefined): string | null {
  if (ref == null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function destinationOf(intent: IntentLike): string | null {
  return refId(intent.transfer_data?.destination) ?? refId(intent.on_behalf_of);
}

/**
 * Captures `amountCents` of a hold. A destination charge gets the platform fee
 * of the captured amount (`application_fee_amount`); the hold itself carries
 * none. The intent is read only when a fee percent applies.
 */
export async function captureHoldWithFee(
  stripe: StripeChargeClient,
  input: SessionChargeFee & {
    intentId: string;
    amountCents: number;
    idempotencyKey?: string | undefined;
  },
): Promise<{ applicationFeeCents: number }> {
  const params: CaptureParams = { amount_to_capture: input.amountCents };
  let applicationFeeCents = 0;
  if (input.platformFeePercent > 0 && input.amountCents > 0) {
    const intent = await stripe.paymentIntents.retrieve(input.intentId);
    if (destinationOf(intent) != null) {
      applicationFeeCents = incrementalPlatformFeeCents(
        0,
        input.amountCents,
        input.taxRate,
        input.platformFeePercent,
      );
      if (applicationFeeCents > 0) params.application_fee_amount = applicationFeeCents;
    }
  }
  await stripe.paymentIntents.capture(
    input.intentId,
    params,
    input.idempotencyKey != null ? { idempotencyKey: input.idempotencyKey } : undefined,
  );
  return { applicationFeeCents };
}

/**
 * Charges `finalCostCents - capturedCents` on the card of the original
 * PaymentIntent. A destination charge goes to the same connected account with
 * the platform fee of the increment (incrementalPlatformFeeCents), so the fees
 * of the capture and every top-up add up to the fee of the final cost. Throws
 * when there is no shortfall, when Stripe declines, or when the original
 * intent has no customer or payment method.
 */
export async function chargeShortfallTopUp(
  stripe: StripeChargeClient,
  input: SessionChargeFee & {
    originalIntentId: string;
    capturedCents: number;
    finalCostCents: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  },
): Promise<{ id: string; amountCents: number; applicationFeeCents: number }> {
  const amount = input.finalCostCents - input.capturedCents;
  if (amount <= 0) throw new Error('No shortfall to charge');

  const original = await stripe.paymentIntents.retrieve(input.originalIntentId);
  const customer = refId(original.customer);
  const paymentMethod = refId(original.payment_method);
  if (customer == null || paymentMethod == null) {
    throw new Error('Original PaymentIntent missing customer or payment_method');
  }

  const params: TopUpIntentParams = {
    amount,
    currency: input.currency.toLowerCase(),
    customer,
    payment_method: paymentMethod,
    confirm: true,
    off_session: true,
    capture_method: 'automatic',
    description: input.description,
  };
  let applicationFeeCents = 0;
  const destination = destinationOf(original);
  if (destination != null) {
    params.on_behalf_of = refId(original.on_behalf_of) ?? destination;
    params.transfer_data = { destination };
    applicationFeeCents = incrementalPlatformFeeCents(
      input.capturedCents,
      input.finalCostCents,
      input.taxRate,
      input.platformFeePercent,
    );
    if (applicationFeeCents > 0) params.application_fee_amount = applicationFeeCents;
  }

  const topUp = await stripe.paymentIntents.create(params, {
    idempotencyKey: input.idempotencyKey,
  });
  return { id: topUp.id, amountCents: amount, applicationFeeCents };
}
