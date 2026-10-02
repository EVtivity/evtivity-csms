// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import i18next from 'i18next';
import {
  cn,
  formatCents,
  formatDate,
  formatDistance,
  formatEnergy,
  formatNumber,
  formatTaxPercent,
  formatUnitPrice,
} from '../utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('foo', undefined, 'bar')).toBe('foo bar');
    const isFalsy = Boolean(0);
    expect(cn('foo', isFalsy && 'bar')).toBe('foo');
  });

  it('deduplicates tailwind classes', () => {
    // twMerge behavior: later class wins
    const result = cn('p-4', 'p-2');
    expect(result).toBe('p-2');
  });
});

describe('formatCents', () => {
  it('returns -- for null', () => {
    expect(formatCents(null, 'USD')).toBe('n/a');
  });

  it('returns -- for undefined', () => {
    expect(formatCents(undefined, 'USD')).toBe('n/a');
  });

  it('formats 0 as $0.00', () => {
    expect(formatCents(0, 'USD')).toBe('$0.00');
  });

  it('formats 1999 as $19.99', () => {
    expect(formatCents(1999, 'USD')).toBe('$19.99');
  });

  it('formats 100 as $1.00', () => {
    expect(formatCents(100, 'USD')).toBe('$1.00');
  });

  it('formats with EUR currency', () => {
    const result = formatCents(1000, 'EUR');
    expect(result).toContain('10.00');
  });

  it('falls back to "CODE 12.34" instead of throwing for an invalid currency code', () => {
    expect(formatCents(1234, 'NOT-A-CODE')).toBe('NOT-A-CODE 12.34');
  });

  it('formats negative values', () => {
    const result = formatCents(-500, 'USD');
    expect(result).toContain('5.00');
  });
});

describe('formatEnergy', () => {
  it('returns -- for null', () => {
    expect(formatEnergy(null)).toBe('n/a');
  });

  it('returns -- for undefined', () => {
    expect(formatEnergy(undefined)).toBe('n/a');
  });

  it('formats string 0 as kWh', () => {
    expect(formatEnergy('0')).toBe('0.00 kWh');
  });

  it('formats string 500 as kWh', () => {
    expect(formatEnergy('500')).toBe('0.50 kWh');
  });

  it('formats string 1000 as kWh', () => {
    expect(formatEnergy('1000')).toBe('1.00 kWh');
  });

  it('formats string 15000 as kWh', () => {
    expect(formatEnergy('15000')).toBe('15.00 kWh');
  });

  it('formats number 2500 as kWh', () => {
    expect(formatEnergy(2500)).toBe('2.50 kWh');
  });

  it('formats string 750 as kWh', () => {
    expect(formatEnergy('750')).toBe('0.75 kWh');
  });
});

describe('formatDate', () => {
  it('returns -- for null', () => {
    expect(formatDate(null)).toBe('n/a');
  });

  it('returns -- for undefined', () => {
    expect(formatDate(undefined)).toBe('n/a');
  });

  it('formats ISO date string with month, day, year, and time', () => {
    const result = formatDate('2024-06-15T14:30:00Z');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2024/);
  });

  it('formats Date object', () => {
    const date = new Date('2024-01-01T09:00:00Z');
    const result = formatDate(date);
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2024/);
  });

  it('formats date in specified timezone', () => {
    const result = formatDate('2024-06-15T04:00:00Z', 'America/New_York');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/12:00/);
  });

  it('formats date in UTC timezone', () => {
    const result = formatDate('2024-06-15T14:30:00Z', 'UTC');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2:30/);
  });

  it('formats date in Asia/Tokyo timezone', () => {
    const result = formatDate('2024-06-15T14:30:00Z', 'Asia/Tokyo');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/11:30/);
  });

  it('returns -- for null with timezone', () => {
    expect(formatDate(null, 'America/New_York')).toBe('n/a');
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
    expect(formatCents(123456, 'EUR')).toBe('1.234,56 €');
    expect(formatUnitPrice(0.49, 'EUR')).toBe('0,49 €');
    expect(formatNumber(1234.5, 1)).toBe('1.234,5');
    expect(formatEnergy(12_345)).toBe('12,35 kWh');
    expect(formatDistance(1_234_000, 1, 'miles')).toBe('1.234 Miles');
  });

  it('keeps English formatting for English', async () => {
    await i18next.changeLanguage('en');
    expect(formatUnitPrice(0.49, 'EUR')).toBe('€0.49');
    expect(formatEnergy(12_345)).toBe('12.35 kWh');
  });

  it('keeps up to four fraction digits of a unit price', async () => {
    await i18next.changeLanguage('en');
    expect(formatUnitPrice(0.256088, 'EUR')).toBe('€0.2561');
    expect(formatUnitPrice(0.5, 'EUR')).toBe('€0.50');
  });

  it('formats a tax rate as a percentage without trailing zeros', async () => {
    await i18next.changeLanguage('de');
    expect(formatTaxPercent(0.19)).toBe('19');
    expect(formatTaxPercent(0.075)).toBe('7,5');
  });
});
