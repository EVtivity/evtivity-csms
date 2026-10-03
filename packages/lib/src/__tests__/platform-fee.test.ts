// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  incrementalPlatformFeeCents,
  netOfCharge,
  platformFeeCents,
  sessionChargeTax,
} from '../platform-fee.js';
import { calculateSplitSessionCost, toSessionCostBreakdown } from '../cost-calculator.js';
import { chargedCostBreakdown } from '../price-display.js';

describe('platformFeeCents', () => {
  it('takes the percent of the net amount, not of the gross', () => {
    // 11900 gross at 19% is 10000 net; 10% of net is 1000, not 1190.
    expect(platformFeeCents(11900, 0.19, 10)).toBe(1000);
  });

  it('takes the percent of the whole amount without tax', () => {
    expect(platformFeeCents(5000, 0, 2.5)).toBe(125);
  });

  it('rounds half up to the cent', () => {
    // net 1000 * 0.05% = 0.5 cents -> 1
    expect(platformFeeCents(1000, 0, 0.05)).toBe(1);
  });

  it('is 0 without a fee percent or an amount', () => {
    expect(platformFeeCents(5000, 0.19, 0)).toBe(0);
    expect(platformFeeCents(0, 0.19, 10)).toBe(0);
    expect(platformFeeCents(-100, 0.19, 10)).toBe(0);
  });

  it('never exceeds the amount charged', () => {
    expect(platformFeeCents(1, 0, 100)).toBe(1);
    expect(platformFeeCents(119, 0.19, 100)).toBe(100);
  });
});

describe('incrementalPlatformFeeCents', () => {
  it('splits the fee of a capture plus top-up so the parts add up to the total fee', () => {
    const total = platformFeeCents(8333, 0.19, 7);
    const capture = incrementalPlatformFeeCents(0, 5000, 0.19, 7);
    const topUp = incrementalPlatformFeeCents(5000, 8333, 0.19, 7);
    expect(capture).toBe(platformFeeCents(5000, 0.19, 7));
    expect(capture + topUp).toBe(total);
  });

  it('gives the same total for a retried top-up after a partial capture', () => {
    const viaRetry =
      incrementalPlatformFeeCents(0, 5000, 0.2, 12.5) +
      incrementalPlatformFeeCents(5000, 9999, 0.2, 12.5);
    expect(viaRetry).toBe(platformFeeCents(9999, 0.2, 12.5));
  });

  it('is 0 when the amount does not grow', () => {
    expect(incrementalPlatformFeeCents(5000, 5000, 0.19, 10)).toBe(0);
    expect(incrementalPlatformFeeCents(6000, 5000, 0.19, 10)).toBe(0);
  });

  it('never exceeds the increment', () => {
    expect(incrementalPlatformFeeCents(100, 101, 0, 100)).toBe(1);
  });
});

describe('fees on a stored session cost split', () => {
  // 10 kWh at 0.50: 500 net + 95 tax (19%), then 500 net + 35 tax (7%): 1130.
  const tariff = (taxRate: string) => ({
    pricePerKwh: '0.50',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate,
  });
  const split = toSessionCostBreakdown(
    calculateSplitSessionCost(
      [
        {
          tariff: tariff('0.19'),
          durationMinutes: 30,
          energyDeliveredWh: 10_000,
          idleMinutes: 0,
          isFirstSegment: true,
        },
        {
          tariff: tariff('0.07'),
          durationMinutes: 30,
          energyDeliveredWh: 10_000,
          idleMinutes: 0,
          isFirstSegment: false,
        },
      ],
      0,
    ),
  );

  it('takes the net of the whole charge from the stored split, not the starting rate', () => {
    expect(split.grossCents).toBe(1130);
    expect(netOfCharge(1130, split)).toBe(1000);
    // At the starting rate only, the net would be round(1130 / 1.19) = 950.
    expect(platformFeeCents(1130, split, 10)).toBe(100);
    expect(platformFeeCents(1130, 0.19, 10)).toBe(95);
  });

  it('shares a partial charge over the rates and adds up across capture and top-up', () => {
    const capture = platformFeeCents(600, split, 10);
    const topUp = incrementalPlatformFeeCents(600, 1130, split, 10);
    expect(capture + topUp).toBe(platformFeeCents(1130, split, 10));
  });

  it('uses the stored split only when it is for the final cost', () => {
    const stored = JSON.parse(JSON.stringify(split)) as unknown;
    expect(
      sessionChargeTax({ finalCostCents: 1130, tariffTaxRate: '0.19', costBreakdown: stored }),
    ).toEqual(split);
    expect(
      sessionChargeTax({ finalCostCents: 1200, tariffTaxRate: '0.19', costBreakdown: stored }),
    ).toBe(0.19);
    expect(
      sessionChargeTax({ finalCostCents: 500, tariffTaxRate: null, costBreakdown: null }),
    ).toBe(0);
    expect(netOfCharge(1190, chargedCostBreakdown(1190, 0.19, 'net'))).toBe(1000);
  });
});
