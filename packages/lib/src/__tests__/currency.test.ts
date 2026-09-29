// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  formatCurrencyAmount,
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

  it('lists only two-decimal currencies', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const digits = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
      }).resolvedOptions().maximumFractionDigits;
      expect({ code, digits }).toEqual({ code, digits: 2 });
    }
  });
});
