// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stripe's minimum charge per currency, in minor units, from
 * https://docs.stripe.com/currencies (Minimum and maximum charge amounts,
 * checked 2026-10-04). Two-decimal currencies only, as the platform supports.
 * The minimum applies to a charge in the currency of a settlement bank
 * account; a charge Stripe converts must meet the settlement currency's
 * minimum after conversion, which is unknown here, so currencies Stripe does
 * not list (CNY, SAR, TWD, TRY) have no known minimum.
 */
const STRIPE_MINIMUM_CHARGE_CENTS: Readonly<Record<string, number>> = {
  USD: 50,
  AED: 200,
  ARS: 50,
  AUD: 50,
  BRL: 50,
  CAD: 50,
  CHF: 50,
  COP: 50,
  CZK: 1500,
  DKK: 250,
  EUR: 50,
  GBP: 30,
  HKD: 400,
  HUF: 17500,
  IDR: 50,
  ILS: 50,
  INR: 50,
  MXN: 1000,
  MYR: 200,
  NOK: 300,
  NZD: 50,
  PHP: 50,
  PLN: 200,
  SEK: 300,
  SGD: 50,
  THB: 1000,
  ZAR: 50,
};

/** Stripe's minimum charge in `currency` (minor units), or null when Stripe lists none. */
export function stripeMinimumChargeCents(currency: string): number | null {
  return STRIPE_MINIMUM_CHARGE_CENTS[currency.toUpperCase()] ?? null;
}
