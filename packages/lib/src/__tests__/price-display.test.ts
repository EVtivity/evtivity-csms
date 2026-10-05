// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  costContainsTax,
  costIncludesTax,
  formatTaxRatePercent,
  grossUnitPrice,
  netUnitPrice,
  isPriceDisplay,
  isTaxBasis,
  resolveTaxBasis,
  chargedCostBreakdown,
  priceForDisplay,
  resolvePriceDisplay,
  sessionCostTax,
  taxOnNet,
  taxLineFromNet,
  netFromGross,
  splitGrossByTaxRate,
  taxBreakdownByRate,
  taxTotals,
  allocateCents,
  reconcileTaxLines,
  revenueFromGrossGroups,
  dimensionTaxCents,
  vatPercentFromFraction,
  splitDimensionByTaxLines,
  tariffPriceView,
  taxRateFraction,
  unitPriceForDisplay,
  dimensionAmounts,
  taxLineForAmount,
  reconcileCostBreakdown,
  capCostBreakdown,
  componentTaxLines,
  parseSessionCostBreakdown,
} from '../price-display.js';
import type { CostTaxLine } from '../price-display.js';
import {
  calculateSessionCost,
  calculateSplitSessionCost,
  toSessionCostBreakdown,
} from '../cost-calculator.js';
import type { TariffInput, TariffSegment } from '../cost-calculator.js';

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

describe('isTaxBasis and resolveTaxBasis', () => {
  it('accepts net and gross only and falls back to net', () => {
    expect(isTaxBasis('net')).toBe(true);
    expect(isTaxBasis('gross')).toBe(true);
    expect(isTaxBasis('brutto')).toBe(false);
    expect(isTaxBasis(null)).toBe(false);
    expect(resolveTaxBasis('gross')).toBe('gross');
    expect(resolveTaxBasis(null)).toBe('net');
    expect(resolveTaxBasis('other')).toBe('net');
  });
});

describe('priceForDisplay', () => {
  it('adds the tax rate to a net-basis price for gross display only', () => {
    expect(priceForDisplay(0.2152, 0.19, 'gross', 'net')).toBeCloseTo(0.256088, 6);
    expect(priceForDisplay(0.2152, 0.19, 'net', 'net')).toBe(0.2152);
    expect(priceForDisplay(0.2152, 0, 'gross', 'net')).toBe(0.2152);
  });

  it('takes the tax out of a gross-basis price for net display only', () => {
    expect(priceForDisplay(0.119, 0.19, 'gross', 'gross')).toBe(0.119);
    expect(priceForDisplay(0.119, 0.19, 'net', 'gross')).toBeCloseTo(0.1, 10);
    expect(priceForDisplay(0.5, 0, 'net', 'gross')).toBe(0.5);
  });
});

describe('netUnitPrice and grossUnitPrice', () => {
  it('converts a stored price by its basis', () => {
    expect(grossUnitPrice(0.1, 0.19, 'net')).toBeCloseTo(0.119, 10);
    expect(grossUnitPrice(2, 0, 'net')).toBe(2);
    expect(grossUnitPrice(0.119, 0.19, 'gross')).toBe(0.119);
    expect(netUnitPrice(0.1, 0.19, 'net')).toBe(0.1);
    expect(netUnitPrice(0.119, 0.19, 'gross')).toBeCloseTo(0.1, 10);
  });
});

describe('splitGrossByTaxRate on charged totals', () => {
  it('splits the tax out of a total that includes it', () => {
    expect(splitGrossByTaxRate(1234, 0.19).taxCents).toBe(197);
    expect(splitGrossByTaxRate(119, 0.19).taxCents).toBe(19);
  });

  it('has no tax without a tax rate', () => {
    expect(splitGrossByTaxRate(1234, 0)).toEqual({ taxRate: 0, netCents: 1234, taxCents: 0 });
  });
});

describe('formatTaxRatePercent', () => {
  it('formats a tax rate as a percentage without trailing zeros', () => {
    expect(formatTaxRatePercent(0.19)).toBe('19');
    expect(formatTaxRatePercent(0.075)).toBe('7.5');
    expect(formatTaxRatePercent(0.075, 'de')).toBe('7,5');
    expect(formatTaxRatePercent(0.12345)).toBe('12.35');
    expect(formatTaxRatePercent(0.0825)).toBe('8.25');
  });
});

describe('costIncludesTax', () => {
  it('is true only for an amount above 0 with a tax rate above 0', () => {
    expect(costIncludesTax(1234, '0.19')).toBe(true);
    expect(costIncludesTax(1234, 0.19)).toBe(true);
    expect(costIncludesTax(null, '0.19')).toBe(false);
    expect(costIncludesTax(0, '0.19')).toBe(false);
    expect(costIncludesTax(1234, null)).toBe(false);
    expect(costIncludesTax(1234, '0')).toBe(false);
  });
});

describe('costContainsTax', () => {
  it('is true only for an amount above 0 whose stored tax is above 0', () => {
    expect(costContainsTax(1190, 190)).toBe(true);
    expect(costContainsTax(1190, 0)).toBe(false);
    expect(costContainsTax(1190, null)).toBe(false);
    expect(costContainsTax(0, 0)).toBe(false);
    expect(costContainsTax(null, 190)).toBe(false);
    expect(costContainsTax(undefined, undefined)).toBe(false);
  });
});

describe('sessionCostTax', () => {
  // 10 kWh at 0.50 net: 500 cents before tax.
  const segment = (taxRate: string | null, isFirstSegment: boolean): TariffSegment => ({
    tariff: {
      pricePerKwh: '0.50',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate,
    },
    durationMinutes: 30,
    energyDeliveredWh: 10_000,
    idleMinutes: 0,
    isFirstSegment,
  });

  it('reads a single-rate breakdown with its rate', () => {
    expect(sessionCostTax(chargedCostBreakdown(1234, 0.19, 'net'))).toEqual({
      netCents: 1037,
      taxCents: 197,
      taxRate: '0.19',
    });
  });

  it('returns null without a breakdown, for a zero cost, and without tax', () => {
    expect(sessionCostTax(null)).toBeNull();
    expect(sessionCostTax(chargedCostBreakdown(0, 0.19, 'net'))).toBeNull();
    expect(sessionCostTax(chargedCostBreakdown(1234, 0, 'net'))).toBeNull();
  });

  it('reads the per-segment tax of a split session, without a single rate', () => {
    // 500 + 19% = 595 and 500 + 7% = 535: 1130 with 130 tax.
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost([segment('0.19', true), segment('0.07', false)], 0),
    );
    expect(sessionCostTax(breakdown)).toEqual({ netCents: 1000, taxCents: 130, taxRate: null });
  });

  it('keeps the rate when every segment has the same one', () => {
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost([segment('0.19', true), segment('0.19', false)], 0),
    );
    expect(sessionCostTax(breakdown)).toEqual({ netCents: 1000, taxCents: 190, taxRate: '0.19' });
  });

  it('keeps the taxed rate when an untaxed segment applied too', () => {
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost([segment('0.19', true), segment('0', false)], 0),
    );
    expect(sessionCostTax(breakdown)).toEqual({ netCents: 1000, taxCents: 95, taxRate: '0.19' });
  });
});

describe('taxOnNet', () => {
  it('rounds half up to the cent', () => {
    expect(taxOnNet(1000, 0.19)).toBe(190);
    expect(taxOnNet(50, 0.07)).toBe(4); // 3.5 -> 4
    expect(taxOnNet(1234, 0)).toBe(0);
  });
});

describe('taxLineFromNet', () => {
  it('adds the tax on the net amount, half up', () => {
    expect(taxLineFromNet(500, 0.19)).toEqual({
      taxRate: 0.19,
      netCents: 500,
      taxCents: 95,
      grossCents: 595,
    });
    expect(taxLineFromNet(250, 0.075)).toEqual({
      taxRate: 0.075,
      netCents: 250,
      taxCents: 19,
      grossCents: 269,
    });
  });

  it('charges the net amount without a rate', () => {
    expect(taxLineFromNet(500, 0)).toEqual({
      taxRate: 0,
      netCents: 500,
      taxCents: 0,
      grossCents: 500,
    });
  });

  it('round-trips through netFromGross', () => {
    for (const net of [1, 99, 500, 1234, 98765]) {
      for (const rate of [0.05, 0.07, 0.19, 0.2, 0.0825]) {
        expect(netFromGross(taxLineFromNet(net, rate).grossCents, rate)).toBe(net);
      }
    }
  });
});

describe('netFromGross', () => {
  it('returns the gross amount at a zero rate', () => {
    expect(netFromGross(1234, 0)).toBe(1234);
  });

  it('recovers the net of every single-tariff amount exactly', () => {
    for (const rate of [0.05, 0.07, 0.075, 0.19, 0.2, 0.21, 0.25]) {
      for (let net = 0; net <= 5000; net++) {
        const gross = net + taxOnNet(net, rate);
        expect(netFromGross(gross, rate)).toBe(net);
      }
    }
  });
});

describe('splitGrossByTaxRate', () => {
  it('splits a gross amount into net and tax that sum to it', () => {
    expect(splitGrossByTaxRate(1190, 0.19)).toEqual({
      taxRate: 0.19,
      netCents: 1000,
      taxCents: 190,
    });
    expect(splitGrossByTaxRate(999, 0)).toEqual({ taxRate: 0, netCents: 999, taxCents: 0 });
  });
});

describe('taxBreakdownByRate', () => {
  it('sums lines per rate, drops empty lines, and orders by rate', () => {
    expect(
      taxBreakdownByRate([
        { taxRate: 0.19, netCents: 100, taxCents: 19 },
        { taxRate: 0.07, netCents: 200, taxCents: 14 },
        { taxRate: 0.19, netCents: 300, taxCents: 57 },
        { taxRate: 0, netCents: 0, taxCents: 0 },
      ]),
    ).toEqual([
      { taxRate: 0.07, netCents: 200, taxCents: 14 },
      { taxRate: 0.19, netCents: 400, taxCents: 76 },
    ]);
  });

  it('does not mutate its input', () => {
    const line = { taxRate: 0.19, netCents: 100, taxCents: 19 };
    taxBreakdownByRate([line, { ...line }]);
    expect(line.netCents).toBe(100);
  });
});

describe('taxTotals', () => {
  it('sums net, tax, and gross', () => {
    expect(
      taxTotals([
        { taxRate: 0.07, netCents: 200, taxCents: 14 },
        { taxRate: 0.19, netCents: 400, taxCents: 76 },
      ]),
    ).toEqual({ netCents: 600, taxCents: 90, grossCents: 690 });
  });
});

describe('allocateCents', () => {
  it('splits proportionally and always sums to the total', () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(19, [500, 300, 200])).toEqual([9, 6, 4]);
    const parts = allocateCents(997, [13, 29, 71, 3]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(997);
  });

  it('gives the total to the first part when all weights are zero', () => {
    expect(allocateCents(5, [0, 0])).toEqual([5, 0]);
  });

  it('returns no parts without weights', () => {
    expect(allocateCents(5, [])).toEqual([]);
  });
});

describe('reconcileTaxLines', () => {
  const lines = [
    { taxRate: 0.07, netCents: 1000, taxCents: 70 },
    { taxRate: 0.19, netCents: 1000, taxCents: 190 },
  ];

  it('keeps lines that already sum to the gross amount', () => {
    expect(reconcileTaxLines(lines, 2260, 0.19)).toBe(lines);
  });

  it('rescales lines that do not sum to the gross amount, to the cent', () => {
    const result = reconcileTaxLines(lines, 2000, 0.19);
    expect(taxTotals(result).grossCents).toBe(2000);
    expect(result.map((l) => l.taxRate)).toEqual([0.07, 0.19]);
    for (const line of result) {
      expect(line.netCents).toBe(netFromGross(line.netCents + line.taxCents, line.taxRate));
    }
  });

  it('uses the fallback rate without lines', () => {
    expect(reconcileTaxLines([], 1190, 0.19)).toEqual([
      { taxRate: 0.19, netCents: 1000, taxCents: 190 },
    ]);
    expect(reconcileTaxLines([], 0, 0.19)).toEqual([]);
  });
});

describe('dimensionTaxCents', () => {
  it('spreads the line tax over the dimensions by net amount', () => {
    expect(
      dimensionTaxCents({
        taxRate: 0.19,
        netCents: 400,
        taxCents: 76,
        energyCostCents: 300,
        timeCostCents: 0,
        sessionFeeCents: 100,
        idleFeeCents: 0,
        reservationHoldingFeeCents: 0,
      }),
    ).toEqual({
      energyCostCents: 57,
      timeCostCents: 0,
      sessionFeeCents: 19,
      idleFeeCents: 0,
      reservationHoldingFeeCents: 0,
    });
  });
});

function costLine(taxRate: number, netCents: number, taxCents: number): CostTaxLine {
  return {
    taxRate,
    netCents,
    taxCents,
    energyCostCents: netCents,
    timeCostCents: 0,
    sessionFeeCents: 0,
    idleFeeCents: 0,
    reservationHoldingFeeCents: 0,
  };
}

describe('vatPercentFromFraction', () => {
  it('turns a stored fraction into a percentage without float noise', () => {
    expect(vatPercentFromFraction(0.19)).toBe(19);
    expect(vatPercentFromFraction(0.07)).toBe(7);
    expect(vatPercentFromFraction(0.0825)).toBe(8.25);
    expect(vatPercentFromFraction(0)).toBe(0);
  });
});

describe('netFromGross against the cost calculator', () => {
  it('recovers the net subtotal of every gross the calculator produces', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.2152',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.19',
    };
    for (let wh = 0; wh <= 60_000; wh += 137) {
      const cost = calculateSessionCost(tariff, wh, 0);
      expect(netFromGross(cost.totalCents, 0.19)).toBe(cost.subtotalCents);
    }
  });
});

describe('reconcileTaxLines with cost breakdown lines', () => {
  it('uses the lines as they are when they add up to the gross', () => {
    const lines = [costLine(0.07, 100, 7), costLine(0.19, 280, 54)];
    expect(taxTotals(reconcileTaxLines(lines, 441, 0))).toEqual({
      netCents: 380,
      taxCents: 61,
      grossCents: 441,
    });
  });

  it('matches a split-billed session across two tax rates', () => {
    const base: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: '1.00',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.19',
    };
    const cost = calculateSplitSessionCost(
      [
        {
          tariff: base,
          durationMinutes: 30,
          energyDeliveredWh: 5_000,
          idleMinutes: 0,
          isFirstSegment: true,
        },
        {
          tariff: { ...base, taxRate: '0.07' },
          durationMinutes: 30,
          energyDeliveredWh: 5_000,
          idleMinutes: 0,
          isFirstSegment: false,
        },
      ],
      0,
    );
    expect(taxTotals(reconcileTaxLines(cost.taxLines, cost.totalCents, 0))).toEqual({
      netCents: cost.subtotalCents,
      taxCents: cost.taxCents,
      grossCents: cost.totalCents,
    });
  });

  it('shares a drifted gross across the lines and keeps the gross exact', () => {
    // Lines add up to 441, the charged gross is 500.
    const split = reconcileTaxLines([costLine(0.19, 280, 54), costLine(0.07, 100, 7)], 500, 0);
    expect(taxTotals(split).grossCents).toBe(500);
    // 500 * 334 / 441 = 378.68 -> 379, 500 * 107 / 441 = 121.32 -> 121
    expect(split).toEqual([
      { taxRate: 0.19, netCents: 318, taxCents: 61 },
      { taxRate: 0.07, netCents: 113, taxCents: 8 },
    ]);
  });

  it('splits at the line rate when the lines total zero', () => {
    expect(taxTotals(reconcileTaxLines([costLine(0.19, 0, 0)], 119, 0))).toMatchObject({
      netCents: 100,
      taxCents: 19,
    });
  });
});

describe('splitDimensionByTaxLines', () => {
  it('spreads the tax of each rate over its dimensions and skips rates without one', () => {
    const lines: CostTaxLine[] = [
      { ...costLine(0.19, 280, 54), energyCostCents: 180, sessionFeeCents: 100 },
      costLine(0.07, 100, 7),
    ];
    // 54 over 180 and 100: 34.71 and 19.29 -> 34 and 19, the remaining cent to energy.
    expect(splitDimensionByTaxLines(lines, 'energyCostCents', 'net')).toEqual([
      { taxRate: 0.19, netCents: 180, taxCents: 35 },
      { taxRate: 0.07, netCents: 100, taxCents: 7 },
    ]);
    expect(splitDimensionByTaxLines(lines, 'sessionFeeCents', 'net')).toEqual([
      { taxRate: 0.19, netCents: 100, taxCents: 19 },
    ]);
    expect(splitDimensionByTaxLines(lines, 'idleFeeCents', 'net')).toEqual([]);
  });

  it('gives dimension taxes that add up to the tax charged per rate', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.2152',
      pricePerMinute: '0.0333',
      pricePerSession: '0.99',
      idleFeePricePerMinute: '0.05',
      reservationFeePerMinute: null,
      taxRate: '0.19',
    };
    const cost = calculateSessionCost(tariff, 12_345, 47, 13);
    const dimensionTax = (
      ['energyCostCents', 'timeCostCents', 'sessionFeeCents', 'idleFeeCents'] as const
    ).reduce(
      (sum, d) => sum + taxTotals(splitDimensionByTaxLines(cost.taxLines, d, 'net')).taxCents,
      0,
    );
    expect(dimensionTax).toBe(cost.taxCents);
  });
});

describe('unitPriceForDisplay', () => {
  it('adds the tax for gross and keeps net prices', () => {
    expect(unitPriceForDisplay('0.30', '0.19', 'gross', 'net')).toBeCloseTo(0.357, 10);
    expect(unitPriceForDisplay('0.30', '0.19', 'net', 'net')).toBe(0.3);
    expect(unitPriceForDisplay(0.3, null, 'gross', 'net')).toBe(0.3);
  });

  it('returns null for absent, zero, negative, or invalid prices', () => {
    expect(unitPriceForDisplay(null, '0.19', 'gross', 'net')).toBeNull();
    expect(unitPriceForDisplay(undefined, '0.19', 'gross', 'net')).toBeNull();
    expect(unitPriceForDisplay('0', '0.19', 'gross', 'net')).toBeNull();
    expect(unitPriceForDisplay('-1', '0.19', 'gross', 'net')).toBeNull();
    expect(unitPriceForDisplay('abc', '0.19', 'gross', 'net')).toBeNull();
  });
});

describe('taxRateFraction', () => {
  it('reads stored rates and treats absent or invalid ones as 0', () => {
    expect(taxRateFraction('0.19')).toBe(0.19);
    expect(taxRateFraction(0.075)).toBe(0.075);
    expect(taxRateFraction(null)).toBe(0);
    expect(taxRateFraction('x')).toBe(0);
    expect(taxRateFraction('-0.1')).toBe(0);
  });
});

describe('tariffPriceView', () => {
  const tariff = {
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: '1.00',
    idleFeePricePerMinute: '0',
    taxRate: '0.19',
  };

  it('shows every price gross for gross display', () => {
    const view = tariffPriceView(tariff, 'gross', 'net');
    expect(view.priceDisplay).toBe('gross');
    expect(view.energy).toBeCloseTo(0.357, 10);
    expect(view.session).toBeCloseTo(1.19, 10);
    expect(view.time).toBeNull();
    expect(view.idle).toBeNull();
    expect(view.taxRate).toBe(0.19);
  });

  it('shows stored net prices for net display', () => {
    const view = tariffPriceView(tariff, 'net', 'net');
    expect(view.energy).toBe(0.3);
    expect(view.session).toBe(1);
  });

  it('takes the tax out of gross-basis prices for net display', () => {
    const view = tariffPriceView({ ...tariff, pricePerKwh: '0.357' }, 'net', 'gross');
    expect(view.energy).toBeCloseTo(0.3, 10);
    expect(view.session).toBeCloseTo(1 / 1.19, 10);
  });
});

describe('taxLineForAmount', () => {
  it('adds the tax to a net amount and takes it out of a gross amount', () => {
    expect(taxLineForAmount(1000, 0.19, 'net')).toEqual({
      taxRate: 0.19,
      netCents: 1000,
      taxCents: 190,
    });
    expect(taxLineForAmount(1190, 0.19, 'gross')).toEqual({
      taxRate: 0.19,
      netCents: 1000,
      taxCents: 190,
    });
    expect(taxLineForAmount(1000, 0, 'gross')).toEqual({ taxRate: 0, netCents: 1000, taxCents: 0 });
  });
});

describe('dimensionAmounts', () => {
  it('keeps the gross of every dimension on the gross basis', () => {
    // Gross dimensions 357 and 119: 476 gross, net round(476 / 1.19) = 400, tax 76.
    const line: CostTaxLine = {
      taxRate: 0.19,
      netCents: 400,
      taxCents: 76,
      energyCostCents: 357,
      timeCostCents: 0,
      sessionFeeCents: 119,
      idleFeeCents: 0,
      reservationHoldingFeeCents: 0,
    };
    const amounts = dimensionAmounts(line, 'gross');
    expect(amounts.energyCostCents).toEqual({ taxRate: 0.19, netCents: 300, taxCents: 57 });
    expect(amounts.sessionFeeCents).toEqual({ taxRate: 0.19, netCents: 100, taxCents: 19 });
    expect(amounts.energyCostCents.netCents + amounts.energyCostCents.taxCents).toBe(357);
  });

  it('uses the dimension as the net amount on the net basis', () => {
    expect(dimensionAmounts(costLine(0.19, 300, 57), 'net').energyCostCents).toEqual({
      taxRate: 0.19,
      netCents: 300,
      taxCents: 57,
    });
  });
});

describe('chargedCostBreakdown and reconcileCostBreakdown', () => {
  it('splits a charged amount at one rate without components', () => {
    expect(chargedCostBreakdown(1234, 0.19, 'net')).toEqual({
      basis: 'net',
      netCents: 1037,
      taxCents: 197,
      grossCents: 1234,
      taxLines: [{ taxRate: 0.19, netCents: 1037, taxCents: 197 }],
      components: null,
    });
    expect(chargedCostBreakdown(0, 0.19, 'gross').taxLines).toEqual([]);
  });

  it('keeps a breakdown that adds up to the charged amount', () => {
    const breakdown = chargedCostBreakdown(1190, 0.19, 'net');
    expect(reconcileCostBreakdown(breakdown, 1190, 0.19)).toBe(breakdown);
  });

  it('reconciles a breakdown to a different charged amount and drops its components', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.19',
    };
    const breakdown = toSessionCostBreakdown(calculateSessionCost(tariff, 10_000, 30));
    expect(breakdown.grossCents).toBe(357);
    const reconciled = reconcileCostBreakdown(breakdown, 400, 0.19);
    expect(reconciled).toEqual({
      basis: 'net',
      netCents: 336,
      taxCents: 64,
      grossCents: 400,
      taxLines: [{ taxRate: 0.19, netCents: 336, taxCents: 64 }],
      components: null,
    });
  });
});

describe('capCostBreakdown', () => {
  const tariff: TariffInput = {
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.19',
  };
  const breakdown = toSessionCostBreakdown(calculateSessionCost(tariff, 10_000, 30));

  it('keeps a cost at or below the ceiling, or without one', () => {
    expect(breakdown.grossCents).toBe(357);
    expect(capCostBreakdown(breakdown, null, 0.19)).toBe(breakdown);
    expect(capCostBreakdown(breakdown, 357, 0.19)).toBe(breakdown);
    expect(capCostBreakdown(breakdown, 500, 0.19)).toBe(breakdown);
  });

  it('bills the ceiling above it and keeps the tariff price on record', () => {
    expect(capCostBreakdown(breakdown, 300, 0.19)).toEqual({
      basis: 'net',
      netCents: 252,
      taxCents: 48,
      grossCents: 300,
      taxLines: [{ taxRate: 0.19, netCents: 252, taxCents: 48 }],
      components: null,
      pricedGrossCents: 357,
    });
  });

  it('keeps the first tariff price when a capped cost is capped again', () => {
    const capped = capCostBreakdown(breakdown, 300, 0.19);
    expect(capCostBreakdown(capped, 250, 0.19).pricedGrossCents).toBe(357);
  });
});

describe('componentTaxLines', () => {
  it('merges the component lines of every segment per rate', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.50',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '0.10',
      taxRate: '0.19',
    };
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost(
        [
          {
            tariff,
            durationMinutes: 10,
            energyDeliveredWh: 1000,
            idleMinutes: 0,
            isFirstSegment: true,
          },
          {
            tariff,
            durationMinutes: 10,
            energyDeliveredWh: 1000,
            idleMinutes: 0,
            isFirstSegment: false,
          },
        ],
        0,
        10,
      ),
    );
    // Tax is rounded once for the rate: 38 on the merged 200 (per segment it
    // was 10 + 10 + 19 = 39). The segments and the holding fee carry their
    // shares of it (9.5, 9.5, 19: the remainder cent goes to the first).
    expect(breakdown.taxLines).toEqual([{ taxRate: 0.19, netCents: 200, taxCents: 38 }]);
    expect(breakdown.components?.map((g) => [g.segment, g.taxLines[0]?.taxCents])).toEqual([
      [1, 10],
      [2, 9],
      [null, 19],
    ]);
    expect(componentTaxLines(breakdown)).toEqual([
      {
        taxRate: 0.19,
        netCents: 200,
        taxCents: 38,
        energyCostCents: 100,
        timeCostCents: 0,
        sessionFeeCents: 0,
        idleFeeCents: 0,
        reservationHoldingFeeCents: 100,
      },
    ]);
    expect(componentTaxLines(chargedCostBreakdown(100, 0.19, 'net'))).toBeNull();
  });
});

describe('parseSessionCostBreakdown', () => {
  const stored = chargedCostBreakdown(1234, 0.19, 'net');

  it('accepts a stored breakdown round-tripped through JSON', () => {
    expect(parseSessionCostBreakdown(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    const calculated = toSessionCostBreakdown(
      calculateSessionCost(
        {
          pricePerKwh: '0.30',
          pricePerMinute: '0.05',
          pricePerSession: null,
          idleFeePricePerMinute: null,
          reservationFeePerMinute: null,
          taxRate: '0.19',
        },
        10_000,
        30,
      ),
    );
    expect(parseSessionCostBreakdown(JSON.parse(JSON.stringify(calculated)))).toEqual(calculated);
  });

  it('keeps the tariff price of a capped cost', () => {
    const capped = { ...chargedCostBreakdown(300, 0.19, 'net'), pricedGrossCents: 357 };
    expect(parseSessionCostBreakdown(JSON.parse(JSON.stringify(capped)))).toEqual(capped);
    expect(parseSessionCostBreakdown({ ...capped, pricedGrossCents: 300 })).toBeNull();
    expect(parseSessionCostBreakdown({ ...capped, pricedGrossCents: '357' })).toBeNull();
  });

  it('rejects values that are not a consistent breakdown', () => {
    expect(parseSessionCostBreakdown(null)).toBeNull();
    expect(parseSessionCostBreakdown('x')).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, basis: 'brutto' })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, grossCents: 1235 })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, netCents: '1037' })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, taxLines: [] })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, taxLines: [{ taxRate: 0.19 }] })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, components: {} })).toBeNull();
    expect(parseSessionCostBreakdown({ ...stored, components: [null] })).toBeNull();
    expect(
      parseSessionCostBreakdown({ ...stored, components: [{ segment: 'a', taxLines: [] }] }),
    ).toBeNull();
    expect(
      parseSessionCostBreakdown({
        ...stored,
        components: [{ segment: null, taxLines: [{ taxRate: 0.19, netCents: 1, taxCents: 0 }] }],
      }),
    ).toBeNull();
  });
});

describe('revenueFromGrossGroups', () => {
  it('splits each charge on its own and sums them', () => {
    // 3 charges of 1.19 at 19% and one of 1.07 at 7%.
    expect(
      revenueFromGrossGroups([
        { taxRate: 0.19, grossCents: 119, count: 3 },
        { taxRate: 0.07, grossCents: 107, count: 1 },
        { taxRate: 0, grossCents: 500, count: 2 },
      ]),
    ).toEqual({ netCents: 300 + 100 + 1000, taxCents: 57 + 7, grossCents: 357 + 107 + 1000 });
  });

  it('matches the sum of per-charge taxes, not the tax of the summed gross', () => {
    // net 2 at 25% -> tax round(0.5) = 1, gross 3. Ten charges: tax 10.
    // Taxing the summed gross (30 / 1.25 = 24 net) would report 6.
    expect(revenueFromGrossGroups([{ taxRate: 0.25, grossCents: 3, count: 10 }])).toEqual({
      netCents: 20,
      taxCents: 10,
      grossCents: 30,
    });
  });

  it('returns zeros without groups', () => {
    expect(revenueFromGrossGroups([])).toEqual({ netCents: 0, taxCents: 0, grossCents: 0 });
  });
});
