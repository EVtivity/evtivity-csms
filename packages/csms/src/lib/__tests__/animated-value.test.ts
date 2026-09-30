// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { parseValue, formatParsedValue } from '../animated-value';

describe('parseValue', () => {
  it('passes numbers through with no prefix or suffix', () => {
    expect(parseValue(42)).toEqual({
      hasNumber: true,
      num: 42,
      prefix: '',
      suffix: '',
      decimals: 0,
    });
  });

  it('splits a currency symbol prefix from the amount', () => {
    expect(parseValue('$5.00')).toEqual({
      hasNumber: true,
      num: 5,
      prefix: '$',
      suffix: '',
      decimals: 2,
    });
  });

  it('reads a leading minus before the currency symbol as a negative amount', () => {
    expect(parseValue('-$5.00')).toEqual({
      hasNumber: true,
      num: -5,
      prefix: '$',
      suffix: '',
      decimals: 2,
    });
    expect(parseValue('-€1,234.56')).toMatchObject({ num: -1234.56, prefix: '€', decimals: 2 });
  });

  it('keeps a minus directly before the digits', () => {
    expect(parseValue('-12.5 kWh')).toMatchObject({ num: -12.5, prefix: '', suffix: ' kWh' });
  });

  it('keeps multi-character currency prefixes', () => {
    expect(parseValue('CA$12.30')).toMatchObject({ num: 12.3, prefix: 'CA$', decimals: 2 });
  });

  it('keeps a unit suffix', () => {
    expect(parseValue('98.5%')).toMatchObject({ num: 98.5, prefix: '', suffix: '%', decimals: 1 });
  });

  it('marks a value with no number', () => {
    expect(parseValue('-')).toEqual({
      hasNumber: false,
      num: 0,
      prefix: '',
      suffix: '-',
      decimals: 0,
    });
  });
});

describe('formatParsedValue', () => {
  it('round-trips a negative currency amount with the sign before the symbol', () => {
    const parsed = parseValue('-$5.00');
    expect(formatParsedValue(parsed, parsed.num)).toBe('-$5.00');
  });

  it('renders intermediate animation values with the parsed prefix and decimals', () => {
    const parsed = parseValue('$10.00');
    expect(formatParsedValue(parsed, 2.5)).toBe('$2.50');
    expect(formatParsedValue(parsed, -2.5)).toBe('-$2.50');
  });

  it('does not render a negative zero', () => {
    const parsed = parseValue('$0.00');
    expect(formatParsedValue(parsed, -0.001)).toBe('$0.00');
  });

  it('renders a value with no number as its original text', () => {
    const parsed = parseValue('-');
    expect(formatParsedValue(parsed, 0)).toBe('-');
  });
});
describe('locale-aware parsing', () => {
  it('reads German currency amounts with the symbol after the number', () => {
    expect(parseValue('1.234,56 €', 'de')).toMatchObject({
      num: 1234.56,
      prefix: '',
      suffix: ' €',
      decimals: 2,
    });
    expect(parseValue('-5,00 €', 'de')).toMatchObject({ num: -5, decimals: 2 });
  });

  it('reads German decimals and units', () => {
    expect(parseValue('12,5 kWh', 'de')).toMatchObject({ num: 12.5, suffix: ' kWh', decimals: 1 });
    expect(parseValue('98,5%', 'de')).toMatchObject({ num: 98.5, suffix: '%', decimals: 1 });
  });

  it('renders intermediate values with the separators of the locale', () => {
    const parsed = parseValue('1.234,56 €', 'de');
    expect(formatParsedValue(parsed, 617.28, 'de')).toBe('617,28 €');
    expect(formatParsedValue(parsed, 1234.56, 'de')).toBe('1.234,56 €');
  });
});
