// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolveLocale } from '@evtivity/lib/number';

/** A display value split into a number and the fixed text around it, for count-up animation. */
export interface ParsedValue {
  /** False when the value holds no number, e.g. a loading placeholder. */
  hasNumber: boolean;
  num: number;
  prefix: string;
  suffix: string;
  decimals: number;
}

interface Separators {
  group: string;
  decimal: string;
}

function getSeparators(locale: string): Separators {
  const parts = new Intl.NumberFormat(resolveLocale(locale)).formatToParts(12345.6);
  return {
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The leading minus covers negative currency strings, which put the sign before the symbol ("-$5.00").
function valuePattern({ group, decimal }: Separators): RegExp {
  const g = escapeRegExp(group);
  const d = escapeRegExp(decimal);
  return new RegExp(`^(-?)([^0-9-]*)(-?[\\d${g}]+(?:${d}\\d*)?)(.*)$`);
}

/**
 * Splits a display value formatted for `locale` (e.g. "$1,234.50" in en,
 * "1.234,50 €" in de) into its number and the surrounding text.
 */
export function parseValue(value: string | number, locale = 'en-US'): ParsedValue {
  if (typeof value === 'number') {
    return { hasNumber: true, num: value, prefix: '', suffix: '', decimals: 0 };
  }
  const separators = getSeparators(locale);
  const match = valuePattern(separators).exec(value);
  if (match == null) {
    return { hasNumber: false, num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const raw = match[3] ?? '';
  const parsed = parseFloat(raw.split(separators.group).join('').replace(separators.decimal, '.'));
  if (isNaN(parsed)) {
    return { hasNumber: false, num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const dotIndex = raw.indexOf(separators.decimal);
  const decimals = dotIndex >= 0 ? raw.length - dotIndex - 1 : 0;
  const num = match[1] === '-' ? -parsed : parsed;
  return { hasNumber: true, num, prefix: match[2] ?? '', suffix: match[4] ?? '', decimals };
}

function formatNumber(num: number, decimals: number, locale: string): string {
  if (decimals === 0) {
    return Math.round(num).toLocaleString(resolveLocale(locale));
  }
  return num.toLocaleString(resolveLocale(locale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Renders `num` with the parsed prefix and suffix, sign first ("-$5.00", not "$-5.00"). */
export function formatParsedValue(parsed: ParsedValue, num: number, locale = 'en-US'): string {
  if (!parsed.hasNumber) return parsed.suffix;
  const rounded = parsed.decimals === 0 ? Math.round(num) : Number(num.toFixed(parsed.decimals));
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${parsed.prefix}${formatNumber(Math.abs(rounded), parsed.decimals, locale)}${parsed.suffix}`;
}
