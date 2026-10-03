// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Detects test/simulated Stripe customer IDs that should bypass real Stripe
 * API calls. The seed creates simulated customers with a `cus_sim_` prefix to
 * exercise the payment flow without touching the live Stripe account. Real
 * Stripe customer IDs are `cus_` + random alphanumeric characters and never
 * start with `cus_sim_`.
 */
export function isSimulatedCustomer(stripeCustomerId: string): boolean {
  return stripeCustomerId.startsWith('cus_sim_');
}

/**
 * Simulated PaymentIntent ids (`pi_sim_`). A simulated hold or charge for a
 * simulated customer gets one of these instead of a Stripe call, so the
 * capture path can recognize it later and skip Stripe too.
 */
export function isSimulatedIntent(paymentIntentId: string): boolean {
  return paymentIntentId.startsWith('pi_sim_');
}

/** A new simulated PaymentIntent id: `pi_sim_` and 24 hex characters. */
export function createSimulatedIntentId(): string {
  return `pi_sim_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Probabilistic failure simulator for the simulated payment path. Triggered
 * when the simulated customer code path needs to exercise the
 * pre-auth-failed / capture-failed branches without touching real Stripe.
 * Returns true for ~20% of calls.
 */
export function shouldSimulatePaymentFailure(): boolean {
  return Math.random() < 0.2;
}

/**
 * Structural tariff shape sufficient to determine if a session is free.
 * Accepts the price fields as nullable strings so it can be called with
 * either Drizzle row types or postgres-js raw query results without
 * coupling the lib package to either driver.
 */
interface FreeTariffShape {
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute?: string | null | undefined;
}

function isZero(price: string | null | undefined): boolean {
  return price == null || Number(price) === 0;
}

/**
 * Returns true when charging costs nothing: every price component on the
 * tariff is null or zero. Treats `null` (no tariff resolved) as free so guest
 * and authenticated flows behave identically when pricing isn't configured.
 *
 * The reservation holding fee is billed only on a session started from a
 * reservation, so it counts only when `reserved` is true: a tariff whose only
 * price is the reservation fee is free for a walk-up session and paid for the
 * reservation holder.
 */
export function isTariffFree(
  tariff: FreeTariffShape | null,
  options: { reserved?: boolean } = {},
): boolean {
  if (tariff == null) return true;
  return (
    isZero(tariff.pricePerKwh) &&
    isZero(tariff.pricePerMinute) &&
    isZero(tariff.pricePerSession) &&
    isZero(tariff.idleFeePricePerMinute) &&
    (options.reserved !== true || isZero(tariff.reservationFeePerMinute))
  );
}
