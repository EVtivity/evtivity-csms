// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { sessionCostDimensions, sessionCostDimensionsByCharging } from '../pricing-engine.js';
import type { PricedAmount } from '../pricing-engine.js';
import type { CostTaxLine, SessionCostBreakdown } from '../price-display.js';

function line(overrides: Partial<CostTaxLine>): CostTaxLine {
  return {
    taxRate: 0.2,
    netCents: 0,
    taxCents: 0,
    energyCostCents: 0,
    timeCostCents: 0,
    sessionFeeCents: 0,
    idleFeeCents: 0,
    reservationHoldingFeeCents: 0,
    ...overrides,
  };
}

const sum = (amounts: PricedAmount[], key: 'netCents' | 'taxCents'): number =>
  amounts.reduce((total, a) => total + a[key], 0);

describe('sessionCostDimensionsByCharging', () => {
  // 60 minutes at 2 cents (time 120), 15 of them idle; 300 energy, 100 session fee, 40 idle fee.
  const single: SessionCostBreakdown = {
    basis: 'net',
    netCents: 560,
    taxCents: 112,
    grossCents: 672,
    taxLines: [{ taxRate: 0.2, netCents: 560, taxCents: 112 }],
    components: [
      {
        segment: null,
        billableIdleMinutes: 5,
        taxLines: [
          line({
            netCents: 560,
            taxCents: 112,
            energyCostCents: 300,
            timeCostCents: 120,
            sessionFeeCents: 100,
            idleFeeCents: 40,
          }),
        ],
      },
    ],
  };

  it('moves the idle share of the time cost to the parking dimension, totals unchanged', () => {
    const dims = sessionCostDimensionsByCharging(single, [
      { segment: null, chargingMinutes: 45, idleMinutes: 15 },
    ]);
    expect(dims?.timeCostCents.map((d) => d.netCents)).toEqual([90]);
    expect(dims?.idleFeeCents.map((d) => d.netCents)).toEqual([70]);
    expect(dims?.energyCostCents.map((d) => d.netCents)).toEqual([300]);
    const all = Object.values(dims ?? {}).flat();
    expect(sum(all, 'netCents')).toBe(560);
    expect(sum(all, 'taxCents')).toBe(112);
  });

  it('keeps the stored split without minutes for a component', () => {
    expect(sessionCostDimensionsByCharging(single, [])).toEqual(sessionCostDimensions(single));
  });

  it('splits each segment by its own minutes and rate', () => {
    const split: SessionCostBreakdown = {
      basis: 'net',
      netCents: 300,
      taxCents: 40,
      grossCents: 340,
      taxLines: [
        { taxRate: 0.1, netCents: 100, taxCents: 10 },
        { taxRate: 0.2, netCents: 200, taxCents: 30 },
      ],
      components: [
        {
          segment: 1,
          taxLines: [line({ taxRate: 0.1, netCents: 100, taxCents: 10, timeCostCents: 100 })],
        },
        {
          segment: 2,
          taxLines: [
            line({
              taxRate: 0.2,
              netCents: 200,
              taxCents: 30,
              timeCostCents: 150,
              idleFeeCents: 50,
            }),
          ],
        },
        { segment: null, taxLines: [] },
      ],
    };
    const dims = sessionCostDimensionsByCharging(split, [
      { segment: 1, chargingMinutes: 30, idleMinutes: 0 },
      { segment: 2, chargingMinutes: 10, idleMinutes: 20 },
    ]);
    expect(dims?.timeCostCents.map((d) => [d.taxRate, d.netCents])).toEqual([
      [0.1, 100],
      [0.2, 50],
    ]);
    expect(dims?.idleFeeCents.map((d) => [d.taxRate, d.netCents])).toEqual([[0.2, 150]]);
    const all = Object.values(dims ?? {}).flat();
    expect(sum(all, 'netCents')).toBe(300);
    expect(sum(all, 'taxCents')).toBe(40);
  });

  it('is null without components', () => {
    expect(
      sessionCostDimensionsByCharging({ ...single, components: null }, [
        { segment: null, chargingMinutes: 1, idleMinutes: 1 },
      ]),
    ).toBeNull();
  });
});
