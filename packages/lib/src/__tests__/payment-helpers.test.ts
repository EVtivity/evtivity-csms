// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import { isTariffFree } from '../payment-helpers.js';

describe('isTariffFree', () => {
  it('returns true when the tariff is null', () => {
    expect(isTariffFree(null)).toBe(true);
  });

  it('returns true when every price component is null', () => {
    expect(
      isTariffFree({
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
      }),
    ).toBe(true);
  });

  it('returns true when every price component is the string "0"', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0',
        pricePerMinute: '0',
        pricePerSession: '0',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(true);
  });

  it('returns true for zero values expressed with decimals', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0.00',
        pricePerMinute: '0.0',
        pricePerSession: '0.000',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(true);
  });

  it('returns true when components mix null and zero', () => {
    expect(
      isTariffFree({
        pricePerKwh: null,
        pricePerMinute: '0',
        pricePerSession: null,
        idleFeePricePerMinute: '0.00',
      }),
    ).toBe(true);
  });

  it('returns false when pricePerKwh is non-zero', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0.25',
        pricePerMinute: '0',
        pricePerSession: '0',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(false);
  });

  it('returns false when pricePerMinute is non-zero', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0',
        pricePerMinute: '0.15',
        pricePerSession: '0',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(false);
  });

  it('returns false when pricePerSession is non-zero', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0',
        pricePerMinute: '0',
        pricePerSession: '2.00',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(false);
  });

  it('returns false when idleFeePricePerMinute is non-zero', () => {
    expect(
      isTariffFree({
        pricePerKwh: '0',
        pricePerMinute: '0',
        pricePerSession: '0',
        idleFeePricePerMinute: '0.05',
      }),
    ).toBe(false);
  });

  it('returns false when a price component is a negative value', () => {
    expect(
      isTariffFree({
        pricePerKwh: '-0.01',
        pricePerMinute: '0',
        pricePerSession: '0',
        idleFeePricePerMinute: '0',
      }),
    ).toBe(false);
  });

  describe('reservation fee', () => {
    const reservationFeeOnly = {
      pricePerKwh: '0',
      pricePerMinute: '0',
      pricePerSession: '0',
      idleFeePricePerMinute: '0',
      reservationFeePerMinute: '0.10',
    };

    it('is free for a walk-up session when only the reservation fee is set', () => {
      expect(isTariffFree(reservationFeeOnly)).toBe(true);
      expect(isTariffFree(reservationFeeOnly, { reserved: false })).toBe(true);
    });

    it('is paid for the reservation holder when the reservation fee is set', () => {
      expect(isTariffFree(reservationFeeOnly, { reserved: true })).toBe(false);
    });

    it('is free for the reservation holder when the reservation fee is 0 or null', () => {
      expect(
        isTariffFree({ ...reservationFeeOnly, reservationFeePerMinute: '0' }, { reserved: true }),
      ).toBe(true);
      expect(
        isTariffFree({ ...reservationFeeOnly, reservationFeePerMinute: null }, { reserved: true }),
      ).toBe(true);
    });
  });
});
