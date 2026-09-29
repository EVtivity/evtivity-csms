// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** A display value split into a number and the fixed text around it, for count-up animation. */
export interface ParsedValue {
  /** False when the value holds no number, e.g. a loading placeholder. */
  hasNumber: boolean;
  num: number;
  prefix: string;
  suffix: string;
  decimals: number;
}

// The leading minus covers negative currency strings, which put the sign before the symbol ("-$5.00").
const VALUE_PATTERN = /^(-?)([^0-9-]*)(-?[\d,]+\.?\d*)(.*)$/;

export function parseValue(value: string | number): ParsedValue {
  if (typeof value === 'number') {
    return { hasNumber: true, num: value, prefix: '', suffix: '', decimals: 0 };
  }
  const match = VALUE_PATTERN.exec(value);
  if (match == null) {
    return { hasNumber: false, num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const raw = match[3] ?? '';
  const parsed = parseFloat(raw.replace(/,/g, ''));
  if (isNaN(parsed)) {
    return { hasNumber: false, num: 0, prefix: '', suffix: value, decimals: 0 };
  }
  const dotIndex = raw.indexOf('.');
  const decimals = dotIndex >= 0 ? raw.length - dotIndex - 1 : 0;
  const num = match[1] === '-' ? -parsed : parsed;
  return { hasNumber: true, num, prefix: match[2] ?? '', suffix: match[4] ?? '', decimals };
}

function formatNumber(num: number, decimals: number): string {
  if (decimals === 0) {
    return Math.round(num).toLocaleString();
  }
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Renders `num` with the parsed prefix and suffix, sign first ("-$5.00", not "$-5.00"). */
export function formatParsedValue(parsed: ParsedValue, num: number): string {
  if (!parsed.hasNumber) return parsed.suffix;
  const rounded = parsed.decimals === 0 ? Math.round(num) : Number(num.toFixed(parsed.decimals));
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${parsed.prefix}${formatNumber(Math.abs(rounded), parsed.decimals)}${parsed.suffix}`;
}
