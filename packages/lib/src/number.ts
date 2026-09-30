// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Locale-aware number formatting for display. Browser-safe (no Node imports),
 * so the CSMS and portal can import it via `@evtivity/lib/number`.
 */

const FALLBACK_LOCALE = 'en-US';

/** Returns the locale when Intl supports it, otherwise "en-US". */
export function resolveLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/**
 * Formats a number with a fixed number of fraction digits and the grouping and
 * decimal separators of the locale, e.g. 1234.5 as "1,234.5" (en) or "1.234,5" (de).
 */
export function formatNumber(value: number, locale: string, fractionDigits: number): string {
  return new Intl.NumberFormat(resolveLocale(locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * Shows a canonical decimal string (as stored, "." separator) with the decimal
 * separator of the locale, without rounding or grouping: "0.49" becomes "0,49"
 * in German. Anything that is not a plain decimal is returned unchanged.
 */
export function formatDecimalString(value: string, locale: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const separator =
    new Intl.NumberFormat(resolveLocale(locale))
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  return value.replace('.', separator);
}
