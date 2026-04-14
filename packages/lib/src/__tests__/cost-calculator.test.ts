// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { calculateSessionCost, calculateSplitSessionCost } from '../cost-calculator.js';
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
      currency: 'USD',
    };

    const result = calculateSessionCost(tariff, 10000, 60);

    expect(result.energyCostCents).toBe(300); // 10 kWh * $0.30 = $3.00
    expect(result.timeCostCents).toBe(300); // 60 min * $0.05 = $3.00
    expect(result.sessionFeeCents).toBe(100); // $1.00
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(700); // $7.00
    expect(result.taxCents).toBe(56); // $7.00 * 0.08 = $0.56
    expect(result.totalCents).toBe(756); // $7.56
    expect(result.currency).toBe('USD');
  });

  it('handles null tariff values as zero', () => {
    const tariff: TariffInput = {
      pricePerKwh: null,
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: null,
      currency: 'EUR',
    };

    const result = calculateSessionCost(tariff, 5000, 30);

    expect(result.energyCostCents).toBe(0);
    expect(result.timeCostCents).toBe(0);
    expect(result.sessionFeeCents).toBe(0);
    expect(result.idleFeeCents).toBe(0);
    expect(result.subtotalCents).toBe(0);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.currency).toBe('EUR');
  });

  it('handles zero energy and duration', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.25',
      pricePerMinute: '0.10',
      pricePerSession: '2.00',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.10',
      currency: 'USD',
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
      currency: 'GBP',
    };

    // 3.333 kWh * $0.33 = $1.09989 -> 110 cents
    const result = calculateSessionCost(tariff, 3333, 0);

    expect(result.energyCostCents).toBe(110);
    expect(result.idleFeeCents).toBe(0);
    expect(result.totalCents).toBe(110);
    expect(result.currency).toBe('GBP');
  });

  it('handles energy-only tariff', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.50',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.05',
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
    currency: 'USD',
  };

  const offPeakTariff: TariffInput = {
    pricePerKwh: '0.20',
    pricePerMinute: '0.05',
    pricePerSession: '1.00',
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.08',
    currency: 'USD',
  };

  it('returns zero breakdown for empty segments', () => {
    const result = calculateSplitSessionCost([], 0);
    expect(result.totalCents).toBe(0);
    expect(result.currency).toBe('USD');
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
      currency: 'USD',
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
      currency: 'USD',
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
          currency: 'USD',
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
          currency: 'USD',
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

  it('throws on mixed currencies across segments', () => {
    const usdTariff: TariffInput = { ...peakTariff, currency: 'USD' };
    const eurTariff: TariffInput = { ...offPeakTariff, currency: 'EUR' };

    const segments: TariffSegment[] = [
      {
        tariff: usdTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: true,
      },
      {
        tariff: eurTariff,
        durationMinutes: 30,
        energyDeliveredWh: 5000,
        idleMinutes: 0,
        isFirstSegment: false,
      },
    ];

    expect(() => calculateSplitSessionCost(segments, 0)).toThrow('Mixed currencies');
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
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
      currency: 'USD',
    };
    // 10 min * $1.00 = $10.00 = 1000 cents, 10% tax = 100 cents
    const result = calculateSessionCost(tariff, 0, 0, 0, 0, 10);
    expect(result.reservationHoldingFeeCents).toBe(1000);
    expect(result.subtotalCents).toBe(1000);
    expect(result.taxCents).toBe(100);
    expect(result.totalCents).toBe(1100);
  });
});
