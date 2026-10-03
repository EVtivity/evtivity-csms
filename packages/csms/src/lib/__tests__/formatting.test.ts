// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import i18next from 'i18next';
import {
  formatCents,
  formatCo2,
  formatDecimal,
  formatEnergy,
  formatFileSize,
  formatConvertedPrice,
  formatMajorAmount,
  formatNumber,
  formatNumberUpTo,
  formatRatePerKwh,
  getDecimalSeparator,
} from '../formatting';
import { parseValue } from '../animated-value';

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

describe('formatting in the UI language', () => {
  beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: {} });
  });

  afterEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('uses the separators of the selected language', async () => {
    await i18next.changeLanguage('de');
    expect(formatCents(123456, 'EUR')).toBe('1.234,56\u00a0€');
    expect(formatRatePerKwh(0.1234, 'EUR')).toBe('0,1234\u00a0€');
    expect(formatNumber(1234.5, 1)).toBe('1.234,5');
    expect(formatEnergy(12_500)).toBe('12,5 kWh');
    expect(formatCo2(1500)).toBe('1,5 t');
    expect(formatFileSize(1536)).toBe('1,5 KB');
  });

  it('keeps English formatting for English', async () => {
    await i18next.changeLanguage('en');
    expect(formatCents(123456, 'EUR')).toBe('€1,234.56');
    expect(formatNumber(1234.5, 1)).toBe('1,234.5');
    expect(formatEnergy(12_500)).toBe('12.5 kWh');
  });

  it('shows stored decimals without rounding', async () => {
    await i18next.changeLanguage('de');
    expect(formatDecimal('0.4900')).toBe('0,4900');
    expect(formatDecimal(null)).toBe('n/a');
  });

  it('formats up to the given decimals without trailing zeros', async () => {
    await i18next.changeLanguage('en');
    expect(formatNumberUpTo(95.5, 1)).toBe('95.5');
    expect(formatNumberUpTo(100, 2)).toBe('100');
    expect(formatNumberUpTo(1234.567, 2)).toBe('1,234.57');
    await i18next.changeLanguage('de');
    expect(formatNumberUpTo(99.87, 2)).toBe('99,87');
    expect(formatNumberUpTo(1234.5, 1)).toBe('1.234,5');
  });

  it('produces dashboard percentages the count-up parser reads back', async () => {
    for (const lang of ['en', 'de', 'es', 'ko', 'zh', 'zh-TW']) {
      await i18next.changeLanguage(lang);
      expect(parseValue(`${formatNumberUpTo(95.5, 1)}%`, lang)).toMatchObject({
        num: 95.5,
        suffix: '%',
        decimals: 1,
      });
      expect(parseValue(`${formatNumberUpTo(99.87, 2)}%`, lang)).toMatchObject({ num: 99.87 });
    }
  });

  it('shows the gross price of a net tariff price', async () => {
    await i18next.changeLanguage('de');
    expect(formatConvertedPrice('0.2152', '0.19', 'net', 'EUR')).toBe('0,2561\u00a0€');
    expect(formatConvertedPrice('1.00', '0.19', 'net', 'EUR')).toBe('1,19\u00a0€');
    expect(formatConvertedPrice('2', '0.07', 'net', 'EUR')).toBe('2,14\u00a0€');
    await i18next.changeLanguage('en');
    expect(formatConvertedPrice('0.2152', '0.19', 'net', 'USD')).toBe('$0.2561');
  });

  it('keeps a gross price finer than a cent, like the driver portal', async () => {
    await i18next.changeLanguage('en');
    // 0.10 net + 19% = 0.119, not rounded to 0.12 from the net input's digits.
    expect(formatConvertedPrice('0.10', '0.19', 'net', 'EUR')).toBe('€0.119');
    expect(formatConvertedPrice('0.1', '0.19', 'net', 'EUR')).toBe('€0.119');
    // At most 4 fraction digits: 0.12345 * 1.19 = 0.1469055.
    expect(formatConvertedPrice('0.12345', '0.19', 'net', 'EUR')).toBe('€0.1469');
  });

  it('shows the net price of a gross tariff price', async () => {
    await i18next.changeLanguage('en');
    expect(formatConvertedPrice('0.357', '0.19', 'gross', 'EUR')).toBe('€0.30');
    // 0.50 / 1.19 = 0.420168...: at most 4 fraction digits.
    expect(formatConvertedPrice('0.50', '0.19', 'gross', 'EUR')).toBe('€0.4202');
  });

  it('shows no converted price without a usable price or tax rate', () => {
    expect(formatConvertedPrice('', '0.19', 'net', 'USD')).toBeNull();
    expect(formatConvertedPrice('0.25', '', 'net', 'USD')).toBeNull();
    expect(formatConvertedPrice('0.25', '0', 'gross', 'USD')).toBeNull();
    expect(formatConvertedPrice('abc', '0.19', 'net', 'USD')).toBeNull();
    expect(formatConvertedPrice('-0.25', '0.19', 'gross', 'USD')).toBeNull();
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

describe('formatMajorAmount', () => {
  it('formats a roaming cost in its currency with 2 to 4 digits', async () => {
    await i18next.changeLanguage('en');
    expect(formatMajorAmount('4.76', 'EUR')).toBe('€4.76');
    expect(formatMajorAmount('0.1234', 'USD')).toBe('$0.1234');
    expect(formatMajorAmount('-4', 'USD')).toBe('-$4.00');
    await i18next.changeLanguage('de');
    expect(formatMajorAmount('4.76', 'EUR')).toBe('4,76\u00a0€');
    await i18next.changeLanguage('en');
  });

  it('shows the number without a currency and n/a without an amount', () => {
    expect(formatMajorAmount('4.5', null)).toBe('4.50');
    expect(formatMajorAmount(null, 'EUR')).toBe('n/a');
    expect(formatMajorAmount('abc', 'EUR')).toBe('n/a');
  });
});
