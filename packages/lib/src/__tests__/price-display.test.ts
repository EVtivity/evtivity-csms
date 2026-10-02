// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  includedTaxCents,
  isPriceDisplay,
  priceForDisplay,
  resolvePriceDisplay,
} from '../price-display.js';

describe('isPriceDisplay', () => {
  it('accepts gross and net only', () => {
    expect(isPriceDisplay('gross')).toBe(true);
    expect(isPriceDisplay('net')).toBe(true);
    expect(isPriceDisplay('brutto')).toBe(false);
    expect(isPriceDisplay(null)).toBe(false);
  });
});

describe('resolvePriceDisplay', () => {
  it('prefers the driver choice over the company setting', () => {
    expect(resolvePriceDisplay('net', 'gross')).toBe('net');
    expect(resolvePriceDisplay(null, 'gross')).toBe('gross');
  });

  it('falls back to net when neither is set', () => {
    expect(resolvePriceDisplay(null, undefined)).toBe('net');
    expect(resolvePriceDisplay('invalid', 'invalid')).toBe('net');
  });
});

describe('priceForDisplay', () => {
  it('adds the tax rate for gross display only', () => {
    expect(priceForDisplay(0.2152, 0.19, 'gross')).toBeCloseTo(0.256088, 6);
    expect(priceForDisplay(0.2152, 0.19, 'net')).toBe(0.2152);
    expect(priceForDisplay(0.2152, 0, 'gross')).toBe(0.2152);
  });
});

describe('includedTaxCents', () => {
  it('splits the tax out of a total that includes it', () => {
    expect(includedTaxCents(1234, 0.19)).toBe(197);
    expect(includedTaxCents(119, 0.19)).toBe(19);
  });

  it('returns 0 without a tax rate', () => {
    expect(includedTaxCents(1234, 0)).toBe(0);
  });
});
