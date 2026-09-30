// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { formatDecimalString, formatNumber, resolveLocale } from '../number.js';

describe('resolveLocale', () => {
  it('keeps supported locales', () => {
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('zh-TW')).toBe('zh-TW');
  });

  it('falls back to en-US for an invalid locale', () => {
    expect(resolveLocale('not a locale!')).toBe('en-US');
  });
});

describe('formatNumber', () => {
  it('uses the decimal and grouping separators of the locale', () => {
    expect(formatNumber(1234.5, 'en', 1)).toBe('1,234.5');
    expect(formatNumber(1234.5, 'de', 1)).toBe('1.234,5');
    expect(formatNumber(1234.5, 'zh-TW', 1)).toBe('1,234.5');
  });

  it('rounds and pads to the given fraction digits', () => {
    expect(formatNumber(12.345, 'de', 2)).toBe('12,35');
    expect(formatNumber(12, 'de', 2)).toBe('12,00');
    expect(formatNumber(12.6, 'en', 0)).toBe('13');
  });

  it('falls back to en-US for an invalid locale', () => {
    expect(formatNumber(1.5, 'not a locale!', 1)).toBe('1.5');
  });
});

describe('formatDecimalString', () => {
  it('swaps the decimal separator without rounding or grouping', () => {
    expect(formatDecimalString('0.49', 'de')).toBe('0,49');
    expect(formatDecimalString('0.4900', 'de')).toBe('0,4900');
    expect(formatDecimalString('1234.5', 'de')).toBe('1234,5');
    expect(formatDecimalString('-3.25', 'es')).toBe('-3,25');
    expect(formatDecimalString('0.49', 'en')).toBe('0.49');
    expect(formatDecimalString('12', 'de')).toBe('12');
  });

  it('returns values that are not plain decimals unchanged', () => {
    expect(formatDecimalString('n/a', 'de')).toBe('n/a');
    expect(formatDecimalString('', 'de')).toBe('');
    expect(formatDecimalString('1e5', 'de')).toBe('1e5');
  });
});
