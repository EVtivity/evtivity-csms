// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  formatCurrencyAmount,
  formatUnitPrice,
  isSupportedCurrency,
} from '../currency.js';

describe('formatCurrencyAmount', () => {
  it('formats minor units in the given currency', () => {
    expect(formatCurrencyAmount(1250, 'USD')).toBe('$12.50');
    expect(formatCurrencyAmount(1250, 'EUR')).toBe('€12.50');
    expect(formatCurrencyAmount(-500, 'GBP')).toBe('-£5.00');
  });

  it('falls back to the code for an invalid currency', () => {
    expect(formatCurrencyAmount(1250, 'xx')).toBe('XX 12.50');
  });

  it('formats in the given locale', () => {
    expect(formatCurrencyAmount(1250, 'EUR', 'de')).toBe('12,50\u00a0€');
    expect(formatCurrencyAmount(123456, 'EUR', 'de')).toBe('1.234,56\u00a0€');
    expect(formatCurrencyAmount(1250, 'EUR', 'en')).toBe('€12.50');
  });

  it('falls back to en-US for an invalid locale', () => {
    expect(formatCurrencyAmount(1250, 'USD', 'not a locale!')).toBe('$12.50');
  });
});

describe('isSupportedCurrency', () => {
  it('accepts two-decimal currencies, including the default', () => {
    expect(isSupportedCurrency('EUR')).toBe(true);
    expect(isSupportedCurrency(DEFAULT_CURRENCY)).toBe(true);
  });

  it('rejects zero-decimal, unknown, lowercase, and non-string values', () => {
    for (const code of ['JPY', 'KRW', 'CLP', 'EURO', 'eur', '', null, 42]) {
      expect(isSupportedCurrency(code)).toBe(false);
    }
  });

  it('lists unique uppercase codes and excludes ISO 4217 zero- and three-decimal currencies', () => {
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
    for (const code of SUPPORTED_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
    // ISO 4217 minor units other than 2. Checked against the standard rather
    // than Intl, whose CLDR display digits vary between Node builds.
    const notTwoDecimal = [
      'JPY',
      'KRW',
      'CLP',
      'VND',
      'ISK',
      'UGX',
      'PYG',
      'XAF',
      'XOF',
      'BHD',
      'KWD',
      'OMR',
      'JOD',
      'TND',
    ];
    for (const code of notTwoDecimal) expect(isSupportedCurrency(code)).toBe(false);
  });
});

describe('formatUnitPrice', () => {
  it('keeps up to four fraction digits', () => {
    expect(formatUnitPrice(0.256088, 'EUR')).toBe('€0.2561');
    expect(formatUnitPrice(0.1, 'USD')).toBe('$0.10');
  });

  it('uses the separators of the locale', () => {
    expect(formatUnitPrice(0.2561, 'EUR', 'de')).toBe('0,2561\u00a0€');
  });
});
