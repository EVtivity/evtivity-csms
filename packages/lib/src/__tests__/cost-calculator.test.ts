// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  calculateSessionCost,
  calculateSplitSessionCost,
  toSessionCostBreakdown,
} from '../cost-calculator.js';
import { sessionCostTax, taxPerRate } from '../price-display.js';
import type { TaxBasis } from '../price-display.js';
import type { TariffInput, TariffSegment } from '../cost-calculator.js';

describe('calculateSessionCost', () => {
  it('calculates the verification example correctly', () => {
    // 10 kWh at $0.30/kWh + 60 min at $0.05/min + $1.00 session fee + 8% tax = 756 cents
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: '0.05',
      pricePerSession: '1.00',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.08',
    };

    const result = calculateSessionCost(tariff, 10000, 60);

    expect(result.energyCostCents).toBe(300); // 10 kWh * $0.30 = $3.00
    expect(result.timeCostCents).toBe(300); // 60 min * $0.05 = $3.00
    expect(result.sessionFeeCents).toBe(100); // $1.00
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(700); // $7.00
    expect(result.taxCents).toBe(56); // $7.00 * 0.08 = $0.56
    expect(result.totalCents).toBe(756); // $7.56
  });

  it('handles null tariff values as zero', () => {
    const tariff: TariffInput = {
      pricePerKwh: null,
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: null,
    };

    const result = calculateSessionCost(tariff, 5000, 30);

    expect(result.energyCostCents).toBe(0);
    expect(result.timeCostCents).toBe(0);
    expect(result.sessionFeeCents).toBe(0);
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(0);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  it('handles zero energy and duration', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.25',
      pricePerMinute: '0.10',
      pricePerSession: '2.00',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.10',
    };

    const result = calculateSessionCost(tariff, 0, 0);

    expect(result.energyCostCents).toBe(0);
    expect(result.timeCostCents).toBe(0);
    expect(result.sessionFeeCents).toBe(200);
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(200);
    expect(result.taxCents).toBe(20);
    expect(result.totalCents).toBe(220);
  });

  it('rounds cents correctly for fractional values', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.33',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 3.333 kWh * $0.33 = $1.09989 -> 110 cents
    const result = calculateSessionCost(tariff, 3333, 0);

    expect(result.energyCostCents).toBe(110);
    expect(result.idleFeeCents).toBe(0);
    expect(result.totalCents).toBe(110);
  });

  it('handles energy-only tariff', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.50',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.05',
    };

    const result = calculateSessionCost(tariff, 20000, 120);

    expect(result.energyCostCents).toBe(1000); // 20 kWh * $0.50
    expect(result.timeCostCents).toBe(0);
    expect(result.sessionFeeCents).toBe(0);
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(1000);
    expect(result.taxCents).toBe(50); // 5%
    expect(result.totalCents).toBe(1050);
  });

  it('calculates idle fee correctly', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: '0.05',
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.50',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 10 kWh at $0.30 = $3.00, 60 min at $0.05 = $3.00, $1.00 session, 20 min idle at $0.50 = $10.00
    const result = calculateSessionCost(tariff, 10000, 60, 20);

    expect(result.energyCostCents).toBe(300);
    expect(result.timeCostCents).toBe(300);
    expect(result.sessionFeeCents).toBe(100);
    expect(result.idleFeeCents).toBe(1000); // 20 min * $0.50 = $10.00
    expect(result.subtotalCents).toBe(1700); // $3 + $3 + $1 + $10
    expect(result.totalCents).toBe(1700);
  });

  it('handles null idle fee price as zero', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // Even with 30 idle minutes, null price means no charge
    const result = calculateSessionCost(tariff, 10000, 60, 30);

    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(300); // only energy cost
    expect(result.totalCents).toBe(300);
  });

  it('grace period fully covers idle time (0 idle fee)', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.50',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 10 idle minutes with 10 min grace period = 0 billable idle minutes
    const result = calculateSessionCost(tariff, 10000, 60, 10, 10);

    expect(result.idleFeeCents).toBe(0);
    expect(result.totalCents).toBe(300); // only energy cost
  });

  it('grace period partially covers idle time (reduced idle fee)', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.50',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 15 idle minutes with 10 min grace period = 5 billable minutes at $0.50 = $2.50
    const result = calculateSessionCost(tariff, 0, 0, 15, 10);

    expect(result.idleFeeCents).toBe(250);
    expect(result.totalCents).toBe(250);
  });

  it('grace period of 0 behaves as before (backward compatible)', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '1.00',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 20 idle minutes with 0 grace = full idle fee
    const result = calculateSessionCost(tariff, 0, 0, 20, 0);

    expect(result.idleFeeCents).toBe(2000);
    expect(result.totalCents).toBe(2000);
  });

  it('grace period exceeding idle time produces no negative fees', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '1.00',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // 5 idle minutes with 30 min grace period = 0 billable idle minutes
    const result = calculateSessionCost(tariff, 0, 0, 5, 30);

    expect(result.idleFeeCents).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  it('includes idle fee in subtotal and tax', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '1.00',
      reservationFeePerMinute: null,
      taxRate: '0.10',
    };

    // 15 idle minutes at $1.00/min = $15.00, 10% tax = $1.50
    const result = calculateSessionCost(tariff, 0, 0, 15);

    expect(result.energyCostCents).toBe(0);
    expect(result.timeCostCents).toBe(0);
    expect(result.sessionFeeCents).toBe(0);
    expect(result.idleFeeCents).toBe(1500);
    expect(result.subtotalCents).toBe(1500);
    expect(result.taxCents).toBe(150); // $15.00 * 0.10
    expect(result.totalCents).toBe(1650); // $15.00 + $1.50
  });
});

describe('calculateSplitSessionCost', () => {
  const peakTariff: TariffInput = {
    pricePerKwh: '0.40',
    pricePerMinute: '0.10',
    pricePerSession: '2.00',
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.08',
  };

  const offPeakTariff: TariffInput = {
    pricePerKwh: '0.20',
    pricePerMinute: '0.05',
    pricePerSession: '1.00',
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.08',
  };

  it('returns zero breakdown for empty segments', () => {
    const result = calculateSplitSessionCost([], 0);
    expect(result.totalCents).toBe(0);
  });

  it('distributes idle grace-period reduction from the last segment backward', () => {
    const idleTariff: TariffInput = { ...peakTariff, idleFeePricePerMinute: '0.50' };
    const segments: TariffSegment[] = [
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 0,
        idleMinutes: 8,
        isFirstSegment: true,
      },
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 0,
        idleMinutes: 12,
        isFirstSegment: false,
      },
    ];
    // total idle = 20, grace = 15 -> billable idle = 5. The reduction (15) comes
    // off the last segment first (12 -> 0) then the first (8 -> 5), so 5 billable
    // idle minutes remain, all on the first segment: 5 * $0.50 = $2.50.
    const result = calculateSplitSessionCost(segments, 15);
    expect(result.idleFeeCents).toBe(250);
  });

  it('charges no idle fee when total idle is within the grace period', () => {
    const idleTariff: TariffInput = { ...peakTariff, idleFeePricePerMinute: '0.50' };
    const segments: TariffSegment[] = [
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 0,
        idleMinutes: 6,
        isFirstSegment: true,
      },
    ];
    // total idle = 6, grace = 10 -> billable idle = 0.
    const result = calculateSplitSessionCost(segments, 10);
    expect(result.idleFeeCents).toBe(0);
  });

  it('calculates single segment same as calculateSessionCost', () => {
    const segments: TariffSegment[] = [
      {
        tariff: peakTariff,
        durationMinutes: 60,
        energyDeliveredWh: 10000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
    ];
    const result = calculateSplitSessionCost(segments, 0);
    const singleResult = calculateSessionCost(peakTariff, 10000, 60);
    expect(result.totalCents).toBe(singleResult.totalCents);
  });

  it('applies session fee only on first segment', () => {
    const segments: TariffSegment[] = [
      {
        tariff: peakTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: offPeakTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: false,
      },
    ];
    const result = calculateSplitSessionCost(segments, 0);

    // Peak: 5kWh * $0.40 = $2.00 (200), 30min * $0.10 = $3.00 (300), session = $2.00 (200)
    // Peak subtotal = 700, tax = 56
    // OffPeak: 5kWh * $0.20 = $1.00 (100), 30min * $0.05 = $1.50 (150), no session fee
    // OffPeak subtotal = 250, tax = 20
    expect(result.sessionFeeCents).toBe(200); // only first segment
    expect(result.energyCostCents).toBe(300); // 200 + 100
    expect(result.timeCostCents).toBe(450); // 300 + 150
    expect(result.taxCents).toBe(76); // 56 + 20
  });

  it('sums costs across segments correctly', () => {
    const segments: TariffSegment[] = [
      {
        tariff: peakTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: offPeakTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: false,
      },
    ];
    const result = calculateSplitSessionCost(segments, 0);
    const subtotal =
      result.energyCostCents +
      result.timeCostCents +
      result.sessionFeeCents +
      result.idleFeeCents +
      result.reservationHoldingFeeCents;
    expect(result.subtotalCents).toBe(subtotal);
    expect(result.totalCents).toBe(subtotal + result.taxCents);
  });

  it('applies grace period once across all segments', () => {
    const idleTariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '1.00',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    // Two segments: segment 1 has 0 idle, segment 2 has 20 idle minutes
    // Grace period of 5 should reduce segment 2's idle to 15, not deducted from each
    const segments: TariffSegment[] = [
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 20,
        isFirstSegment: false,
      },
    ];
    const result = calculateSplitSessionCost(segments, 5);

    // 20 total idle - 5 grace = 15 billable at $1.00/min = $15.00 = 1500 cents
    expect(result.idleFeeCents).toBe(1500);
  });

  it('grace period does not produce negative idle fees across segments', () => {
    const idleTariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '1.00',
      reservationFeePerMinute: null,
      taxRate: '0.00',
    };

    const segments: TariffSegment[] = [
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 3,
        isFirstSegment: true,
      },
      {
        tariff: idleTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 2,
        isFirstSegment: false,
      },
    ];
    // Grace period (10) exceeds total idle (5)
    const result = calculateSplitSessionCost(segments, 10);

    expect(result.idleFeeCents).toBe(0);
  });

  it('charges reservation holding fee once using first segment tariff rate', () => {
    const segments: TariffSegment[] = [
      {
        tariff: {
          pricePerKwh: '0.30',
          pricePerMinute: null,
          pricePerSession: null,
          idleFeePricePerMinute: null,
          reservationFeePerMinute: '0.10',
          taxRate: '0',
        },
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: {
          pricePerKwh: '0.50',
          pricePerMinute: null,
          pricePerSession: null,
          idleFeePricePerMinute: null,
          reservationFeePerMinute: '0.20', // higher rate on second segment — should be ignored
          taxRate: '0',
        },
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: false,
      },
    ];

    // 15 minutes of holding, first segment rate = $0.10/min -> $1.50 = 150 cents
    const result = calculateSplitSessionCost(segments, 0, 15);
    expect(result.reservationHoldingFeeCents).toBe(150);
    // energy: (5 kWh * $0.30) + (5 kWh * $0.50) = $1.50 + $2.50 = $4.00 = 400 cents
    expect(result.energyCostCents).toBe(400);
    expect(result.subtotalCents).toBe(550); // 400 + 150
  });

  it('treats null per-segment taxRate as zero tax', () => {
    const noTaxTariff: TariffInput = {
      pricePerKwh: '0.40',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: null,
    };
    const segments: TariffSegment[] = [
      {
        tariff: noTaxTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: noTaxTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: false,
      },
    ];
    const result = calculateSplitSessionCost(segments, 0);
    // energy: 2 * (5 kWh * $0.40 = 200) = 400, no tax
    expect(result.energyCostCents).toBe(400);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(400);
  });

  it('treats null first-segment taxRate as zero when taxing the reservation holding fee', () => {
    const noTaxWithReservation: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '1.00',
      taxRate: null,
    };
    const segments: TariffSegment[] = [
      {
        tariff: noTaxWithReservation,
        durationMinutes: 30,
        energyDeliveredWh: 0,
        idleMinutes: 0,
        isFirstSegment: true,
      },
    ];
    // 10 min holding * $1.00 = 1000 cents, null taxRate -> 0 tax on the holding fee
    const result = calculateSplitSessionCost(segments, 0, 10);
    expect(result.reservationHoldingFeeCents).toBe(1000);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(1000);
  });
});

describe('reservation holding fee', () => {
  it('calculates holding fee when reservationFeePerMinute is set', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '0.05',
      taxRate: '0',
    };
    const result = calculateSessionCost(tariff, 10_000, 30, 0, 0, 20);
    // 20 min * $0.05 = $1.00 = 100 cents holding fee
    expect(result.reservationHoldingFeeCents).toBe(100);
    // 10 kWh * $0.30 = $3.00 = 300 cents energy cost
    expect(result.energyCostCents).toBe(300);
    expect(result.subtotalCents).toBe(400); // 300 + 100
  });

  it('returns zero holding fee when reservationFeePerMinute is null', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0',
    };
    const result = calculateSessionCost(tariff, 10_000, 30, 0, 0, 0);
    expect(result.reservationHoldingFeeCents).toBe(0);
  });

  it('returns zero holding fee when holdingMinutes is 0', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '0.10',
      taxRate: '0',
    };
    const result = calculateSessionCost(tariff, 0, 0, 0, 0, 0);
    expect(result.reservationHoldingFeeCents).toBe(0);
  });

  it('reservation holding fee included in tax base', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.00',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '1.00',
      taxRate: '0.10',
    };
    // 10 min * $1.00 = $10.00 = 1000 cents, 10% tax = 100 cents
    const result = calculateSessionCost(tariff, 0, 0, 0, 0, 10);
    expect(result.reservationHoldingFeeCents).toBe(1000);
    expect(result.subtotalCents).toBe(1000);
    expect(result.taxCents).toBe(100);
    expect(result.totalCents).toBe(1100);
  });
});

describe('tax lines', () => {
  const base: TariffInput = {
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: '0.10',
    taxRate: '0.19',
  };

  function seg(
    tariff: TariffInput,
    energyDeliveredWh: number,
    idleMinutes: number,
    isFirstSegment: boolean,
  ): TariffSegment {
    return { tariff, durationMinutes: 30, energyDeliveredWh, idleMinutes, isFirstSegment };
  }

  it('a single-tariff session has one line at its rate', () => {
    const result = calculateSessionCost(base, 10_000, 30);
    expect(result.taxLines).toEqual([
      {
        taxRate: 0.19,
        netCents: 300,
        taxCents: 57,
        energyCostCents: 300,
        timeCostCents: 0,
        sessionFeeCents: 0,
        idleFeeCents: 0,
        reservationHoldingFeeCents: 0,
      },
    ]);
  });

  it('a session with nothing billed has no lines', () => {
    expect(calculateSessionCost(base, 0, 0).taxLines).toEqual([]);
  });

  it('a split session has one line per rate that sums to its subtotal and tax', () => {
    const reduced: TariffInput = { ...base, taxRate: '0.07' };
    const segments = [
      seg(base, 10_000, 0, true),
      seg(reduced, 5_000, 0, false),
      seg(base, 3_333, 0, false),
    ];
    // Holding fee 10 min * $0.10 = 100 cents at the first rate (19%).
    const result = calculateSplitSessionCost(segments, 0, 10);
    // Segment 1: 300 net, tax 57. Segment 2: 150 net, tax round(10.5) = 11.
    // Segment 3: 100 net (3.333 kWh * 0.30 = 0.9999), tax 19. Holding: 100 net, tax 19.
    expect(result.taxLines).toEqual([
      expect.objectContaining({ taxRate: 0.07, netCents: 150, taxCents: 11 }),
      expect.objectContaining({
        taxRate: 0.19,
        netCents: 500,
        taxCents: 95,
        energyCostCents: 400,
        reservationHoldingFeeCents: 100,
      }),
    ]);
    expect(result.segments.map((s) => s.taxCents)).toEqual([57, 11, 19]);
    expect(result.reservationHolding).toMatchObject({
      netCents: 100,
      taxRate: 0.19,
      taxCents: 19,
      reservationHoldingFeeCents: 100,
    });
    expect(result.subtotalCents).toBe(650);
    expect(result.taxCents).toBe(106);
    expect(result.totalCents).toBe(756);
  });

  it('split segments carry the grace-adjusted idle and the session fee only on the first', () => {
    const idle: TariffInput = { ...base, pricePerSession: '1.00', idleFeePricePerMinute: '0.50' };
    const result = calculateSplitSessionCost([seg(idle, 0, 8, true), seg(idle, 0, 12, false)], 15);
    expect(result.segments.map((s) => s.idleFeeCents)).toEqual([250, 0]);
    expect(result.segments.map((s) => s.sessionFeeCents)).toEqual([100, 0]);
  });
});

describe('tax lines per cost dimension', () => {
  const base: TariffInput = {
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: '1.00',
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.19',
  };

  it('gives a single-tariff session one line equal to the breakdown', () => {
    const result = calculateSessionCost(base, 10_000, 30);
    expect(result.taxLines).toEqual([
      {
        taxRate: 0.19,
        energyCostCents: 300,
        timeCostCents: 0,
        sessionFeeCents: 100,
        idleFeeCents: 0,
        reservationHoldingFeeCents: 0,
        netCents: 400,
        taxCents: 76,
      },
    ]);
  });

  it('splits a session across tariffs with different rates into one line per rate', () => {
    const reduced: TariffInput = { ...base, pricePerKwh: '0.20', taxRate: '0.07' };
    const segment = (tariff: TariffInput, wh: number, first: boolean): TariffSegment => ({
      tariff,
      durationMinutes: 30,
      energyDeliveredWh: wh,
      idleMinutes: 0,
      isFirstSegment: first,
    });
    const result = calculateSplitSessionCost(
      [segment(base, 5_000, true), segment(reduced, 5_000, false), segment(base, 1_000, false)],
      0,
    );
    // 19%: 150 + 100 fee (first segment) = 250, then 30: net 280, tax 53 (53.2)
    // rounded once for the rate (per segment it was 48 + 6 = 54)
    // 7%: 100, tax 7
    expect(result.taxLines).toEqual([
      expect.objectContaining({
        taxRate: 0.07,
        netCents: 100,
        sessionFeeCents: 0,
        taxCents: 7,
      }),
      expect.objectContaining({
        taxRate: 0.19,
        netCents: 280,
        sessionFeeCents: 100,
        taxCents: 53,
      }),
    ]);
    const lineSubtotal = result.taxLines.reduce((sum, l) => sum + l.netCents, 0);
    const lineTax = result.taxLines.reduce((sum, l) => sum + l.taxCents, 0);
    expect(lineSubtotal).toBe(result.subtotalCents);
    expect(lineTax).toBe(result.taxCents);
  });

  it('puts the reservation holding fee on the first segment rate', () => {
    const result = calculateSplitSessionCost(
      [
        {
          tariff: { ...base, reservationFeePerMinute: '0.10' },
          durationMinutes: 10,
          energyDeliveredWh: 0,
          idleMinutes: 0,
          isFirstSegment: true,
        },
        {
          tariff: { ...base, taxRate: '0.07' },
          durationMinutes: 10,
          energyDeliveredWh: 0,
          idleMinutes: 0,
          isFirstSegment: false,
        },
      ],
      0,
      10,
    );
    const first = result.taxLines.find((l) => l.taxRate === 0.19);
    expect(first?.reservationHoldingFeeCents).toBe(100);
    expect(result.taxLines.reduce((sum, l) => sum + l.taxCents, 0)).toBe(result.taxCents);
  });

  it('returns no lines for an empty split session', () => {
    expect(calculateSplitSessionCost([], 0).taxLines).toEqual([]);
  });
});

describe('tax rounded once per rate (audit N3)', () => {
  const at = (pricePerKwh: string, taxRate: string): TariffInput => ({
    pricePerKwh,
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate,
  });
  const kwh = (tariff: TariffInput, first: boolean): TariffSegment => ({
    tariff,
    durationMinutes: 20,
    energyDeliveredWh: 1_000,
    idleMinutes: 0,
    isFirstSegment: first,
  });
  const priced = (tariffs: TariffInput[], basis: TaxBasis) =>
    calculateSplitSessionCost(
      tariffs.map((t, i) => kwh(t, i === 0)),
      0,
      0,
      basis,
    );

  it('net basis, several segments at one rate: tax on the summed net, shown net and gross', () => {
    // 33 net three times at 19%: 99 * 0.19 = 18.81 -> 19 (per segment 6 * 3 = 18).
    const result = priced([at('0.33', '0.19'), at('0.33', '0.19'), at('0.33', '0.19')], 'net');
    expect(result.subtotalCents).toBe(99);
    expect(result.taxCents).toBe(19);
    expect(result.totalCents).toBe(118);
    expect(result.segments.map((s) => s.taxCents)).toEqual([7, 6, 6]);
    // Net display: 99 net + 19 tax = 118. Gross display: 118 containing 19 tax at 19%.
    expect(sessionCostTax(toSessionCostBreakdown(result))).toEqual({
      netCents: 99,
      taxCents: 19,
      taxRate: '0.19',
    });
  });

  it('gross basis, several segments at one rate: contained tax taken from the summed gross', () => {
    // 39 gross three times at 19%: 117 gross, net round(117 / 1.19) = 98, tax 19
    // (per segment 39 - 33 = 6, so 18).
    const result = priced([at('0.39', '0.19'), at('0.39', '0.19'), at('0.39', '0.19')], 'gross');
    expect(result.totalCents).toBe(117);
    expect(result.subtotalCents).toBe(98);
    expect(result.taxCents).toBe(19);
    // Each segment's net plus tax is still its gross amount.
    expect(result.segments.map((s) => s.subtotalCents + s.taxCents)).toEqual([39, 39, 39]);
    expect(sessionCostTax(toSessionCostBreakdown(result))).toEqual({
      netCents: 98,
      taxCents: 19,
      taxRate: '0.19',
    });
  });

  it('net basis, two rates: tax once per rate, no single rate to show', () => {
    // 19%: 33 + 33 = 66 -> 12.54 -> 13 (per segment 12). 7%: 50 -> 3.5 -> 4.
    const result = priced([at('0.33', '0.19'), at('0.50', '0.07'), at('0.33', '0.19')], 'net');
    expect(result.taxLines.map((l) => [l.taxRate, l.netCents, l.taxCents])).toEqual([
      [0.07, 50, 4],
      [0.19, 66, 13],
    ]);
    expect(result.totalCents).toBe(116 + 17);
    expect(sessionCostTax(toSessionCostBreakdown(result))).toEqual({
      netCents: 116,
      taxCents: 17,
      taxRate: null,
    });
  });

  it('gross basis, two rates: contained tax once per rate', () => {
    // 19%: 39 + 39 = 78 gross, net 66, tax 12. 7%: 53 gross, net 50, tax 3.
    const result = priced([at('0.39', '0.19'), at('0.53', '0.07'), at('0.39', '0.19')], 'gross');
    expect(result.taxLines.map((l) => [l.taxRate, l.netCents, l.taxCents])).toEqual([
      [0.07, 50, 3],
      [0.19, 66, 12],
    ]);
    expect(result.totalCents).toBe(131);
    expect(sessionCostTax(toSessionCostBreakdown(result))).toEqual({
      netCents: 116,
      taxCents: 15,
      taxRate: null,
    });
  });

  it('taxPerRate spreads each rate tax over its parts by amount, in input order', () => {
    expect(
      taxPerRate(
        [
          { taxRate: 0.19, amountCents: 33 },
          { taxRate: 0.07, amountCents: 50 },
          { taxRate: 0.19, amountCents: 33 },
          { taxRate: 0.19, amountCents: 0 },
        ],
        'net',
      ),
    ).toEqual([
      { taxRate: 0.19, netCents: 33, taxCents: 7 },
      { taxRate: 0.07, netCents: 50, taxCents: 4 },
      { taxRate: 0.19, netCents: 33, taxCents: 6 },
      { taxRate: 0.19, netCents: 0, taxCents: 0 },
    ]);
    expect(taxPerRate([{ taxRate: 0.19, amountCents: 78 }], 'gross')).toEqual([
      { taxRate: 0.19, netCents: 66, taxCents: 12 },
    ]);
    expect(taxPerRate([], 'net')).toEqual([]);
  });
});
