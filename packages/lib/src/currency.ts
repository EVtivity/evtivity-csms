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
 * Cents as the value of a money input in major units: 5000 -> "50.00".
 * Settings store cents; operators type amounts in the currency.
 */
export function centsToMajorInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A money input in major units as cents: "50" -> 5000, "12.5" -> 1250,
 * "0.05" -> 5. Parsed from the text, so no float rounding. Null for anything
 * that is not a non-negative amount with at most two decimals.
 */
export function parseMajorInputToCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match == null) return null;
  const units = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = units * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
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

/**
 * A flat amount in major units, such as a session fee, as money: rounded to the
 * cent as it is billed ("$0.54", not the "$0.5413" of a gross unit price).
 */
export function formatFlatPrice(amount: number, currency: string, locale = 'en-US'): string {
  return formatCurrencyAmount(Math.round(amount * 100), currency, locale);
}

/**
 * Words around the prices of a tariff summary, in one language. Each pattern
 * holds a `{price}` placeholder for the formatted unit price, so the language
 * decides word order and units ("{price}/kWh", "세션 {price}").
 */
export interface TariffSummaryLabels {
  energy: string;
  time: string;
  session: string;
  idle: string;
  /** Joins the parts (" + ", " | "), spaces included. */
  separator: string;
  /** Shown when the tariff has no price above 0. */
  free: string;
}

/** The unit prices a tariff summary shows, in major units. Null leaves a part out. */
export interface TariffSummaryPrices {
  energy: number | null;
  time: number | null;
  session: number | null;
  idle: number | null;
}

/** One unit price in a pattern with a `{price}` placeholder, such as "{price}/min". */
export function formatUnitPriceWithLabel(
  price: number,
  pattern: string,
  currency: string,
  locale = 'en-US',
): string {
  return pattern.replace('{price}', formatUnitPrice(price, currency, locale));
}

/**
 * A one-line tariff summary such as "€0.357/kWh + €0.02/min": the rates
 * through formatUnitPrice and the session fee through formatFlatPrice, in the
 * currency and locale, the words from the labels. Prices are shown as given;
 * the caller decides net or gross (tariffPriceView in @evtivity/lib/price-display).
 */
export function formatTariffSummary(
  prices: TariffSummaryPrices,
  labels: TariffSummaryLabels,
  currency: string,
  locale = 'en-US',
): string {
  const parts: string[] = [];
  const add = (pattern: string, price: number | null, flat = false): void => {
    if (price == null || price <= 0) return;
    parts.push(
      flat
        ? pattern.replace('{price}', formatFlatPrice(price, currency, locale))
        : formatUnitPriceWithLabel(price, pattern, currency, locale),
    );
  };
  add(labels.energy, prices.energy);
  add(labels.time, prices.time);
  add(labels.session, prices.session, true);
  add(labels.idle, prices.idle);
  return parts.length > 0 ? parts.join(labels.separator) : labels.free;
}
