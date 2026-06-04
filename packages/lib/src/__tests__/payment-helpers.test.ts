// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSimulatedCustomer,
  isTariffFree,
  shouldSimulatePaymentFailure,
} from '../payment-helpers.js';

describe('isSimulatedCustomer', () => {
  it('returns true for a simulated customer id', () => {
    expect(isSimulatedCustomer('cus_sim_abc123')).toBe(true);
  });

  it('returns true when the id is exactly the prefix', () => {
    expect(isSimulatedCustomer('cus_sim_')).toBe(true);
  });

  it('returns false for a real stripe customer id', () => {
    expect(isSimulatedCustomer('cus_NffrFeUfNV2Hib')).toBe(false);
  });

  it('returns false when cus_ is present but not the sim variant', () => {
    expect(isSimulatedCustomer('cus_simian')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isSimulatedCustomer('')).toBe(false);
  });

  it('returns false when the prefix appears mid-string', () => {
    expect(isSimulatedCustomer('xcus_sim_abc')).toBe(false);
  });
});

describe('shouldSimulatePaymentFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when Math.random is below the 0.2 threshold', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    expect(shouldSimulatePaymentFailure()).toBe(true);
  });

  it('returns true at the lower boundary value', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(shouldSimulatePaymentFailure()).toBe(true);
  });

  it('returns false exactly at the 0.2 threshold (strict less-than)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
    expect(shouldSimulatePaymentFailure()).toBe(false);
  });

  it('returns false when Math.random is above the threshold', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(shouldSimulatePaymentFailure()).toBe(false);
  });
});

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
});
