// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  formatCurrencyAmount,
  formatFlatPrice,
  formatUnitPrice,
  formatUnitPriceWithLabel,
  formatTariffSummary,
  isSupportedCurrency,
  type TariffSummaryLabels,
  centsToMajorInput,
  parseMajorInputToCents,
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

describe('formatFlatPrice', () => {
  it('rounds a flat amount to the cent as it is billed', () => {
    expect(formatFlatPrice(0.54125, 'USD')).toBe('$0.54');
    expect(formatFlatPrice(1.0825, 'USD')).toBe('$1.08');
    expect(formatFlatPrice(2, 'EUR', 'de')).toBe('2,00\u00a0€');
  });
});

const LABELS: TariffSummaryLabels = {
  energy: '{price}/kWh',
  time: '{price}/min',
  session: '{price} session',
  idle: '{price}/min idle',
  separator: ' + ',
  free: 'Free',
};

describe('formatTariffSummary', () => {
  it('joins the prices above 0 with the labels', () => {
    expect(
      formatTariffSummary({ energy: 0.357, time: null, session: 1.19, idle: 0 }, LABELS, 'EUR'),
    ).toBe('€0.357/kWh + €1.19 session');
  });

  it('formats in the locale and keeps sub-cent digits', () => {
    expect(
      formatTariffSummary(
        { energy: 0.2561, time: 0.0238, session: null, idle: null },
        LABELS,
        'EUR',
        'de',
      ),
    ).toBe('0,2561\u00a0€/kWh + 0,0238\u00a0€/min');
  });

  it('places the price where the pattern says', () => {
    expect(
      formatTariffSummary(
        { energy: null, time: null, session: 1, idle: null },
        { ...LABELS, session: '세션 {price}' },
        'USD',
        'ko',
      ),
    ).toBe('세션 US$1.00');
  });

  it('shows the free label without prices', () => {
    expect(
      formatTariffSummary({ energy: null, time: null, session: null, idle: null }, LABELS, 'USD'),
    ).toBe('Free');
  });
});

describe('formatUnitPriceWithLabel', () => {
  it('fills the price placeholder', () => {
    expect(formatUnitPriceWithLabel(0.119, '{price}/Min.', 'EUR', 'de')).toBe('0,119\u00a0€/Min.');
  });
});

describe('money inputs', () => {
  it('shows cents in major units with two decimals', () => {
    expect(centsToMajorInput(5000)).toBe('50.00');
    expect(centsToMajorInput(5)).toBe('0.05');
    expect(centsToMajorInput(123456)).toBe('1234.56');
    expect(centsToMajorInput(0)).toBe('0.00');
  });

  it('parses major units into cents without float rounding', () => {
    expect(parseMajorInputToCents('50')).toBe(5000);
    expect(parseMajorInputToCents('12.5')).toBe(1250);
    expect(parseMajorInputToCents('0.05')).toBe(5);
    expect(parseMajorInputToCents('1.15')).toBe(115);
    expect(parseMajorInputToCents(' 19.99 ')).toBe(1999);
  });

  it('rejects negatives, more than two decimals, and text', () => {
    expect(parseMajorInputToCents('-1')).toBeNull();
    expect(parseMajorInputToCents('1.234')).toBeNull();
    expect(parseMajorInputToCents('abc')).toBeNull();
    expect(parseMajorInputToCents('')).toBeNull();
    expect(parseMajorInputToCents('1,5')).toBeNull();
  });

  it('round-trips', () => {
    for (const cents of [0, 1, 99, 100, 5000, 123456]) {
      expect(parseMajorInputToCents(centsToMajorInput(cents))).toBe(cents);
    }
  });
});
