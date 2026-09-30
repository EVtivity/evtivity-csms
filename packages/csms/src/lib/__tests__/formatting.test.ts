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
  formatNumber,
  formatRatePerKwh,
} from '../formatting';

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
    expect(formatCents(123456, 'EUR')).toBe('1.234,56 €');
    expect(formatRatePerKwh(0.1234, 'EUR')).toBe('0,1234 €');
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
});
