// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { formatCents, formatRatePerKwh, getDecimalSeparator } from '../formatting';

describe('formatCents', () => {
  it('formats cents in the given currency', () => {
    expect(formatCents(1234, 'USD')).toBe('$12.34');
    expect(formatCents(1234, 'EUR')).toBe('€12.34');
  });

  it('puts the sign before the currency symbol for negative amounts', () => {
    expect(formatCents(-500, 'USD')).toBe('-$5.00');
  });

  it('falls back to "CODE 12.34" instead of throwing for an invalid currency code', () => {
    expect(formatCents(1234, 'NOT-A-CODE')).toBe('NOT-A-CODE 12.34');
  });

  it('returns n/a for a missing amount', () => {
    expect(formatCents(null, 'USD')).toBe('n/a');
    expect(formatCents(undefined, 'USD')).toBe('n/a');
  });
});

describe('formatRatePerKwh', () => {
  it('formats a per-kWh rate with four decimals in the given currency', () => {
    expect(formatRatePerKwh(0.1234, 'USD')).toBe('$0.1234');
    expect(formatRatePerKwh(0.2, 'EUR')).toBe('€0.2000');
  });

  it('falls back to "CODE 0.1234" instead of throwing for an invalid currency code', () => {
    expect(formatRatePerKwh(0.1234, 'not-a-code')).toBe('NOT-A-CODE 0.1234');
  });
});

describe('getDecimalSeparator', () => {
  it('returns the decimal separator of each supported UI language', () => {
    expect(getDecimalSeparator('en')).toBe('.');
    expect(getDecimalSeparator('de')).toBe(',');
    expect(getDecimalSeparator('es')).toBe(',');
    expect(getDecimalSeparator('ko')).toBe('.');
    expect(getDecimalSeparator('zh')).toBe('.');
    expect(getDecimalSeparator('zh-TW')).toBe('.');
  });

  it('falls back to "." for an invalid locale', () => {
    expect(getDecimalSeparator('not a locale!')).toBe('.');
  });
});
