// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolveLocale } from './number.js';

/**
 * The currency used only when the `company.currency` setting is unset. Every
 * other default resolves to the company currency, never to this constant.
 */
export const DEFAULT_CURRENCY = 'USD';

/**
 * Currencies the platform can run in. Money is stored in cents and Stripe
 * amounts are cents, so only ISO 4217 currencies with two minor units qualify.
 */
export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'INR',
  'BRL',
  'MXN',
  'SEK',
  'NOK',
  'DKK',
  'NZD',
  'SGD',
  'HKD',
  'ZAR',
  'ILS',
  'AED',
  'SAR',
  'TWD',
  'THB',
  'PLN',
  'CZK',
  'HUF',
  'TRY',
  'COP',
  'ARS',
  'PHP',
  'MYR',
  'IDR',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: unknown): code is SupportedCurrency {
  return typeof code === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

/**
 * Formats minor units (cents) in a currency, for example 1250 USD as "$12.50"
 * (en-US) or "12,50 $" (de). The locale defaults to en-US; server-side callers
 * rely on that default. Falls back to "CODE 12.50" when the code is not a valid
 * ISO 4217 currency.
 */
export function formatCurrencyAmount(
  amountCents: number,
  currency: string,
  locale = 'en-US',
): string {
  try {
    return new Intl.NumberFormat(resolveLocale(locale), { style: 'currency', currency }).format(
      amountCents / 100,
    );
  } catch {
    return `${currency.toUpperCase()} ${(amountCents / 100).toFixed(2)}`;
  }
}

/**
 * Formats a unit price in major units (e.g. a tariff rate of 0.2561 EUR/kWh)
 * with 2 to 4 fraction digits, so rates finer than a cent are not rounded away.
 * Falls back like formatCurrencyAmount.
 */
export function formatUnitPrice(amount: number, currency: string, locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(resolveLocale(locale), {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}
