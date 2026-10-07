// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared formatting utilities for the CSMS frontend.
 * All display formatting functions used across multiple pages and components.
 */

import { formatCurrencyAmount, formatUnitPrice } from '@evtivity/lib/currency';
import {
  formatTaxRatePercent,
  grossUnitPrice,
  netUnitPrice,
  type TaxBasis,
} from '@evtivity/lib/price-display';
import {
  formatDecimalString,
  formatNumber as formatLocaleNumber,
  resolveLocale,
} from '@evtivity/lib/number';
import i18next from 'i18next';

/**
 * The selected UI language, which drives number, currency and date formatting. Read
 * from the global i18next instance that @/i18n initializes; falls back to "en"
 * before initialization (e.g. in unit tests).
 */
export function uiLocale(): string {
  return i18next.isInitialized ? i18next.language : 'en';
}

/**
 * Format a number for display with fixed fraction digits in the UI language,
 * e.g. formatNumber(1234.5, 1) as "1,234.5" (en) or "1.234,5" (de).
 */
export function formatNumber(value: number, fractionDigits: number): string {
  return formatLocaleNumber(value, uiLocale(), fractionDigits);
}

/**
 * Format a number in the UI language with at most `maxFractionDigits` decimals and
 * no trailing zeros, e.g. 99.5 as "99.5" (en) or "99,5" (de), and 100 as "100".
 */
export function formatNumberUpTo(value: number, maxFractionDigits: number): string {
  return new Intl.NumberFormat(resolveLocale(uiLocale()), {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

/**
 * Show a stored decimal string ("0.49") with the decimal separator of the UI
 * language, without rounding. Returns 'n/a' for null/undefined values.
 */
export function formatDecimal(value: string | null | undefined): string {
  if (value == null) return 'n/a';
  return formatDecimalString(value, uiLocale());
}

/**
 * A tariff price, entered in the company tax basis, shown on the other side
 * of tax: the gross price for a net basis (the tax rate added), the net price
 * for a gross basis (the tax rate taken out). Price and tax rate are canonical
 * decimal strings ("0.2152", "0.19"); the result is currency in the UI
 * language, formatted with formatUnitPrice (2 to 4 fraction digits), like the
 * driver portal and the notifications, so a price finer than a cent is not
 * rounded away. Returns null when either value is not a plain non-negative
 * decimal or the tax rate is 0.
 */
export function formatConvertedPrice(
  price: string,
  taxRate: string,
  basis: TaxBasis,
  currency: string,
): string | null {
  const decimal = /^\d+(\.\d+)?$/;
  if (!decimal.test(price) || !decimal.test(taxRate)) return null;
  const rate = Number(taxRate);
  if (rate === 0) return null;
  const converted =
    basis === 'gross'
      ? netUnitPrice(Number(price), rate, basis)
      : grossUnitPrice(Number(price), rate, basis);
  return formatUnitPrice(converted, currency, uiLocale());
}

/**
 * Format cents in the ISO 4217 currency the amount is denominated in.
 * Returns 'n/a' for null/undefined values and "CODE 12.34" for an invalid code.
 */
export function formatCents(cents: number | null | undefined, currency: string): string {
  if (cents == null) return 'n/a';
  return formatCurrencyAmount(cents, currency, uiLocale());
}

/**
 * Format an amount stored in major units as a decimal string (an OCPI roaming
 * cost, "4.76") in its currency, with 2 to 4 fraction digits. Returns 'n/a'
 * for a missing or non-numeric amount and the plain number without a currency.
 */
export function formatMajorAmount(amount: string | null, currency: string | null): string {
  const value = amount != null ? Number(amount) : NaN;
  if (!Number.isFinite(value)) return 'n/a';
  if (currency == null || currency === '') return formatNumber(value, 2);
  return formatUnitPrice(value, currency, uiLocale());
}

/**
 * Format a tax rate fraction (0.19) as a percentage number in the UI language
 * ("19", "7,5"). The percent sign comes from the translation around it
 * (`invoices.taxRateValue`).
 */
export function formatTaxPercent(taxRate: number | string): string {
  return formatTaxRatePercent(Number(taxRate), uiLocale());
}

/** Format an electricity rate, in major currency units per kWh, with four decimals. */
export function formatRatePerKwh(rate: number, currency: string): string {
  try {
    return new Intl.NumberFormat(resolveLocale(uiLocale()), {
      style: 'currency',
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(rate);
  } catch (err) {
    console.warn(`Format a ${currency} rate failed, using a plain number`, err);
    return `${currency.toUpperCase()} ${formatNumber(rate, 4)}`;
  }
}

/**
 * Format a duration between two timestamps as "Xh Ym" or "Xm".
 * Uses Date.now() when end is null (ongoing session).
 * Returns 'n/a' when start is null.
 */
export function formatDuration(start: string | null, end: string | null): string {
  if (start == null) return 'n/a';
  const startMs = new Date(start).getTime();
  const endMs = end != null ? new Date(end).getTime() : Date.now();
  const totalMinutes = Math.round((endMs - startMs) / 60000);
  if (totalMinutes < 60) return `${String(totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes)}m`;
}

/**
 * Format a duration in minutes as "Xh Ym", "Xh", or "Xm".
 * Omits the minutes portion when it is zero.
 */
export function formatDurationMinutes(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
  }
  return `${String(minutes)}m`;
}

/**
 * Format CO2 weight in kg. Converts to tonnes when >= 1000 kg.
 */
export function formatCo2(kg: number): string {
  if (kg >= 1000) return `${formatNumber(kg / 1000, 1)} t`;
  return `${formatNumber(kg, 1)} kg`;
}

/**
 * Format energy in Wh. Converts to kWh or MWh based on magnitude.
 * Shows Wh for values under 1000, kWh up to 100 MWh, MWh above.
 */
export function formatEnergy(wh: number): string {
  if (wh >= 100_000_000) return `${formatNumber(wh / 1_000_000, 1)} MWh`;
  if (wh >= 1_000) return `${formatNumber(wh / 1_000, 1)} kWh`;
  return `${String(Math.round(wh))} Wh`;
}

/**
 * Format file size in bytes to a human-readable string (B, KB, or MB).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 1)} KB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}

/**
 * Decimal separator used by the given locale, e.g. "," for "de" and "." for "en".
 * Falls back to "." when the locale is not supported by Intl.
 */
export function getDecimalSeparator(locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
    return parts.find((part) => part.type === 'decimal')?.value ?? '.';
  } catch (err) {
    console.warn(`Read the decimal separator for locale ${locale} failed, using "."`, err);
    return '.';
  }
}
