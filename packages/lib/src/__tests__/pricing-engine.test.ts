// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Golden, hand-calculated cases of the pricing engine. Each case is checked
// against the engine and against the independent oracle, so a rule change
// must change the hand numbers here.

import { describe, expect, it } from 'vitest';
import { CostInputError, calculateSessionCost } from '../cost-calculator.js';
import type { SessionPricingInput, TariffInput } from '../cost-calculator.js';
import type { SessionCostInput } from '../pricing-engine.js';
import { allocateCents, netFromGross, taxOnNet } from '../price-display.js';
import { platformFeeCents } from '../platform-fee.js';
import {
  centsFromMajorUnits,
  chargeSplit,
  multiplyCents,
  priceEnergyCents,
  priceFee,
  priceSessionCost,
  priceTimedFee,
  pricedSessionFromBreakdown,
  sessionCostDimensions,
} from '../pricing-engine.js';
import { priceSegments, priceTimeline } from '../testing/pricing-oracle.js';

const NONE: TariffInput = {
  pricePerKwh: null,
  pricePerMinute: null,
  pricePerSession: null,
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: null,
};
const T = (o: Partial<TariffInput>): TariffInput => ({ ...NONE, ...o });
const START = new Date('2026-03-01T10:00:00Z');
const minutesAfter = (m: number): Date => new Date(START.getTime() + m * 60_000);

function session(o: Partial<SessionCostInput> & { tariff: TariffInput }): SessionCostInput {
  return {
    basis: 'net',
    startedAt: START,
    at: minutesAfter(60),
    energyWh: 0,
    idleMinutes: 0,
    gracePeriodMinutes: 0,
    reservationHoldingMinutes: 0,
    segments: [],
    ...o,
  };
}

describe('TC-T1-01..03 exact tax (B12)', () => {
  it('TC-T1-01 taxes 360 at 8.75% as 32 (31.5 half up), not the float 31', () => {
    expect(taxOnNet(360, 0.0875)).toBe(32);
    expect(taxOnNet(680, 0.0875)).toBe(60);
    const priced = priceSessionCost(
      session({ tariff: T({ pricePerKwh: '0.36', taxRate: '0.0875' }), energyWh: 10_000 }),
    );
    expect([priced.netCents, priced.taxCents, priced.grossCents]).toEqual([360, 32, 392]);
    const oracle = priceSegments({
      basis: 'net',
      graceMinutes: 0,
      segments: [
        {
          tariff: { pricePerKwh: '0.36', taxRate: '0.0875' },
          durationMinutes: 60,
          energyWh: 10_000,
          idleMinutes: 0,
        },
      ],
    });
    expect([oracle.netCents, oracle.taxCents, oracle.grossCents]).toEqual([360, 32, 392]);
  });

  it('TC-T1-02 splits a gross back to the exact net', () => {
    expect(netFromGross(392, 0.0875)).toBe(360);
    expect(chargeSplit(392, '0.0875')).toEqual({
      taxRate: 0.0875,
      netCents: 360,
      taxCents: 32,
      grossCents: 392,
    });
  });

  it('TC-T1-03 shares cents exactly: equal remainders go to the earlier part', () => {
    // 2 over weights 1, 22, 7: exact 0.067, 1.467, 0.467; the tie of the last
    // two goes to the earlier. Floating point gave [0, 1, 1].
    expect(allocateCents(2, [1, 22, 7])).toEqual([0, 2, 0]);
  });
});

describe('TC-T1-04..06 dimensions, net and gross basis', () => {
  const tariff = T({
    pricePerKwh: '0.30',
    pricePerMinute: '0.05',
    pricePerSession: '1.00',
    idleFeePricePerMinute: '0.10',
    taxRate: '0.19',
  });

  it('TC-T1-04 prices each dimension, taxes once, and shares the tax over the dimensions', () => {
    const priced = priceSessionCost(
      session({
        tariff,
        at: minutesAfter(45),
        energyWh: 12_500,
        idleMinutes: 20,
        gracePeriodMinutes: 5,
      }),
    );
    // 375 + 225 + 100 + 15 * 10 = 850 net, 161.5 -> 162 tax.
    expect([priced.netCents, priced.taxCents, priced.grossCents]).toEqual([850, 162, 1012]);
    const seg = priced.segments[0];
    expect(seg?.billableIdleMinutes).toBe(15);
    const dims = seg?.dimensions;
    expect(dims?.energyCostCents).toEqual({
      taxRate: 0.19,
      netCents: 375,
      taxCents: 71,
      grossCents: 446,
    });
    expect(dims?.timeCostCents.taxCents).toBe(43);
    expect(dims?.sessionFeeCents.taxCents).toBe(19);
    expect(dims?.idleFeeCents.taxCents).toBe(29);
    const oracle = priceSegments({
      basis: 'net',
      graceMinutes: 5,
      segments: [{ tariff: tariff, durationMinutes: 45, energyWh: 12_500, idleMinutes: 20 }],
    });
    expect(oracle.segments[0]?.dimensions.energy).toEqual({
      amountCents: 375,
      netCents: 375,
      taxCents: 71,
      grossCents: 446,
    });
    expect(
      [oracle.dimensions.time, oracle.dimensions.sessionFee, oracle.dimensions.idleFee].map(
        (d) => d.taxCents,
      ),
    ).toEqual([43, 19, 29]);
    expect(oracle.grossCents).toBe(1012);
  });

  it('TC-T1-05 on the gross basis charges gross price times quantity and takes the tax out once', () => {
    const gross = T({ pricePerKwh: '0.357', pricePerSession: '1.19', taxRate: '0.19' });
    const priced = priceSessionCost(session({ basis: 'gross', tariff: gross, energyWh: 10_000 }));
    expect([priced.netCents, priced.taxCents, priced.grossCents]).toEqual([400, 76, 476]);
    expect(priced.dimensions?.energyCostCents).toEqual([
      { taxRate: 0.19, netCents: 300, taxCents: 57, grossCents: 357 },
    ]);
    expect(priced.dimensions?.sessionFeeCents).toEqual([
      { taxRate: 0.19, netCents: 100, taxCents: 19, grossCents: 119 },
    ]);
    const oracle = priceSegments({
      basis: 'gross',
      graceMinutes: 0,
      segments: [{ tariff: gross, durationMinutes: 60, energyWh: 10_000, idleMinutes: 0 }],
    });
    expect([oracle.netCents, oracle.taxCents, oracle.grossCents]).toEqual([400, 76, 476]);
  });

  it('TC-T1-06 rounds a half cent of energy up', () => {
    // 20 Wh at 0.25/kWh is 0.5 cent.
    expect(priceEnergyCents(20, '0.25')).toBe(1);
    expect(priceEnergyCents(1002, '0.25')).toBe(25);
  });
});

describe('TC-T1-07..09 idle grace: the first idle minutes of the session (owner decision)', () => {
  const a = T({ idleFeePricePerMinute: '0.50' });
  const b = T({ idleFeePricePerMinute: '0.10' });
  const split = (grace: number): SessionPricingInput =>
    session({
      tariff: a,
      at: minutesAfter(120),
      idleMinutes: 13,
      gracePeriodMinutes: grace,
      segments: [
        {
          tariff: a,
          startedAt: START,
          endedAt: minutesAfter(60),
          energyWhStart: 0,
          energyWhEnd: 0,
          idleMinutes: 10,
        },
        {
          tariff: b,
          startedAt: minutesAfter(60),
          endedAt: null,
          energyWhStart: 0,
          energyWhEnd: null,
          idleMinutes: 0,
        },
      ],
    });

  it('TC-T1-07 takes the grace from the first segment forward', () => {
    // 10 idle minutes at 0.50 then 3 at 0.10, grace 5: 5 * 50 + 3 * 10 = 280.
    const priced = priceSessionCost(split(5));
    expect(priced.segments.map((s) => s.dimensions.idleFeeCents.netCents)).toEqual([250, 30]);
    expect(priced.netCents).toBe(280);
  });

  it('TC-T1-08 frees the same number of idle minutes with or without split billing', () => {
    const whole = priceSessionCost({ ...split(5), segments: [] });
    // 13 - 5 = 8 billable minutes either way; unsplit they are all at tariff a.
    expect(whole.segments[0]?.billableIdleMinutes).toBe(8);
    const splitMinutes = priceSessionCost(split(5)).segments.reduce(
      (s, g) => s + (g.billableIdleMinutes ?? 0),
      0,
    );
    expect(splitMinutes).toBe(8);
  });

  it('TC-T1-09 spends a grace longer than the first segment idle in the next segment', () => {
    // Grace 12: segment 1 free, 2 of the 3 minutes of segment 2 free: 1 * 10.
    expect(priceSessionCost(split(12)).netCents).toBe(10);
    const oracle = priceTimeline({
      basis: 'net',
      graceMinutes: 12,
      splitBilling: true,
      startedAt: START.getTime(),
      endedAt: minutesAfter(120).getTime(),
      tariffs: [
        { from: START.getTime(), tariff: { idleFeePricePerMinute: '0.50' } },
        { from: minutesAfter(60).getTime(), tariff: { idleFeePricePerMinute: '0.10' } },
      ],
      meter: [],
      idle: [
        { from: minutesAfter(50).getTime(), to: minutesAfter(60).getTime() },
        { from: minutesAfter(117).getTime(), to: minutesAfter(120).getTime() },
      ],
    });
    expect(oracle.netCents).toBe(10);
  });
});

describe('TC-T1-10..12 tax per rate, session fee, holding fee', () => {
  it('TC-T1-10 rounds tax once per rate over the segments', () => {
    // Two segments of 2 cents at 25%: per segment 0.5 -> 1 each (2), per rate 4 * 0.25 = 1.
    const t = T({ pricePerKwh: '0.02', taxRate: '0.25' });
    const priced = priceSessionCost(
      session({
        tariff: t,
        energyWh: 2000,
        segments: [
          {
            tariff: t,
            startedAt: START,
            endedAt: minutesAfter(30),
            energyWhStart: 0,
            energyWhEnd: 1000,
            idleMinutes: 0,
          },
          {
            tariff: t,
            startedAt: minutesAfter(30),
            endedAt: null,
            energyWhStart: 1000,
            energyWhEnd: null,
            idleMinutes: 0,
          },
        ],
      }),
    );
    expect([priced.netCents, priced.taxCents]).toEqual([4, 1]);
    expect(priced.segments.map((s) => s.total.taxCents)).toEqual([1, 0]);
  });

  it('TC-T1-11 bills the session fee once, on the first segment', () => {
    const t = T({ pricePerSession: '1.00' });
    const priced = priceSessionCost(
      session({
        tariff: t,
        segments: [
          {
            tariff: t,
            startedAt: START,
            endedAt: minutesAfter(30),
            energyWhStart: 0,
            energyWhEnd: 0,
            idleMinutes: 0,
          },
          {
            tariff: t,
            startedAt: minutesAfter(30),
            endedAt: null,
            energyWhStart: 0,
            energyWhEnd: null,
            idleMinutes: 0,
          },
        ],
      }),
    );
    // Segments that bill nothing are not stored; only segment 1 carries the fee.
    expect(priced.segments.map((s) => [s.segment, s.dimensions.sessionFeeCents.netCents])).toEqual([
      [1, 100],
    ]);
  });

  it('TC-T1-12 bills the holding fee at the first tariff and its rate', () => {
    // 12 minutes * 0.05 = 60 at 19% with the 300 of energy: 360 * 0.19 = 68.4 -> 68.
    const t = T({ pricePerKwh: '0.30', reservationFeePerMinute: '0.05', taxRate: '0.19' });
    const priced = priceSessionCost(
      session({ tariff: t, energyWh: 1000 * 10, reservationHoldingMinutes: 12 }),
    );
    expect(priced.dimensions?.reservationHoldingFeeCents[0]?.netCents).toBe(60);
    expect([priced.netCents, priced.taxCents, priced.grossCents]).toEqual([360, 68, 428]);
  });
});

describe('TC-T1-13..14 cost ceiling', () => {
  it('TC-T1-13 caps at the ceiling and keeps the tariff price', () => {
    const t = T({
      pricePerKwh: '0.30',
      pricePerMinute: '0.05',
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.10',
      taxRate: '0.19',
    });
    const priced = priceSessionCost(
      session({
        tariff: t,
        at: minutesAfter(45),
        energyWh: 12_500,
        idleMinutes: 20,
        gracePeriodMinutes: 5,
        ceilingCents: 500,
      }),
    );
    // 500 / 1.19 = 420.17 -> 420 net, 80 tax.
    expect([priced.netCents, priced.taxCents, priced.grossCents]).toEqual([420, 80, 500]);
    expect(priced.pricedGrossCents).toBe(1012);
    expect(priced.dimensions).toBeNull();
  });

  it('TC-T1-14 shares a ceiling over two rates by their gross', () => {
    const oracle = priceSegments({
      basis: 'net',
      graceMinutes: 0,
      ceilingCents: 200,
      segments: [
        {
          tariff: { pricePerKwh: '0.30', taxRate: '0.19' },
          durationMinutes: 30,
          energyWh: 1000,
          idleMinutes: 0,
        },
        {
          tariff: { pricePerKwh: '0.30', taxRate: '0' },
          durationMinutes: 30,
          energyWh: 10_000,
          idleMinutes: 0,
        },
      ],
    });
    // Gross 36 at 19% (30 + 5.7 -> 6) and 300 at 0%: 200 shared 21.43 / 178.57 -> 21 / 179.
    // 21 / 1.19 = 17.65 -> 18 net, 3 tax.
    const expected = [
      { taxRate: 0, netCents: 179, taxCents: 0, grossCents: 179 },
      { taxRate: 0.19, netCents: 18, taxCents: 3, grossCents: 21 },
    ];
    expect(oracle.charged.rates).toEqual(expected);
    const a = T({ pricePerKwh: '0.30', taxRate: '0.19' });
    const b = T({ pricePerKwh: '0.30', taxRate: '0' });
    const priced = priceSessionCost(
      session({
        tariff: a,
        energyWh: 11_000,
        ceilingCents: 200,
        segments: [
          {
            tariff: a,
            startedAt: START,
            endedAt: minutesAfter(30),
            energyWhStart: 0,
            energyWhEnd: 1000,
            idleMinutes: 0,
          },
          {
            tariff: b,
            startedAt: minutesAfter(30),
            endedAt: null,
            energyWhStart: 1000,
            energyWhEnd: null,
            idleMinutes: 0,
          },
        ],
      }),
    );
    expect(priced.taxLines).toEqual(expected);
  });
});

describe('TC-T1-15..18 input validation (B23)', () => {
  it('TC-T1-15 refuses negative energy', () => {
    expect(() => calculateSessionCost(T({ pricePerKwh: '0.30' }), -5000, 10)).toThrow(
      CostInputError,
    );
  });

  it('TC-T1-16 refuses a price that is not a number', () => {
    expect(() => calculateSessionCost(T({ pricePerKwh: 'abc' }), 1000, 0)).toThrow(
      /tariff\.pricePerKwh/,
    );
  });

  it('TC-T1-17 refuses non-finite durations and negative tax rates', () => {
    expect(() => calculateSessionCost(NONE, 0, Infinity)).toThrow(/durationMinutes/);
    expect(() => calculateSessionCost(T({ taxRate: '-0.1' }), 0, 0)).toThrow(/tariff\.taxRate/);
    expect(() => calculateSessionCost(NONE, NaN, 0)).toThrow(/energyDeliveredWh/);
  });

  it('TC-T1-18 refuses a segment with negative duration', () => {
    const t = T({ pricePerMinute: '0.10' });
    expect(() =>
      priceSessionCost(
        session({
          tariff: t,
          at: minutesAfter(10),
          segments: [
            {
              tariff: t,
              startedAt: START,
              endedAt: minutesAfter(30),
              energyWhStart: 0,
              energyWhEnd: 0,
              idleMinutes: 0,
            },
            {
              tariff: t,
              startedAt: minutesAfter(30),
              endedAt: null,
              energyWhStart: 0,
              energyWhEnd: null,
              idleMinutes: 0,
            },
          ],
        }),
      ),
    ).toThrow(CostInputError);
  });
});

describe('TC-T1-19..23 fee and amount entry points', () => {
  it('TC-T1-19 prices a fee entered net or gross', () => {
    expect(priceFee({ amountCents: 500, taxRate: '0.19', basis: 'net' })).toEqual({
      taxRate: 0.19,
      netCents: 500,
      taxCents: 95,
      grossCents: 595,
    });
    expect(priceFee({ amountCents: 595, taxRate: '0.19', basis: 'gross' })).toEqual({
      taxRate: 0.19,
      netCents: 500,
      taxCents: 95,
      grossCents: 595,
    });
    expect(() => priceFee({ amountCents: 1.5, taxRate: null, basis: 'net' })).toThrow(RangeError);
  });

  it('TC-T1-20 prices a per-minute fee exactly', () => {
    // 15 minutes at 0.333 = 4.995 -> 500 cents; 7.5 minutes at 0.10 = 75.
    expect(
      priceTimedFee({ pricePerMinute: '0.333', minutes: 15, taxRate: null, basis: 'net' }).netCents,
    ).toBe(500);
    expect(
      priceTimedFee({ pricePerMinute: '0.10', minutes: 7.5, taxRate: '0.2', basis: 'net' }),
    ).toEqual({
      taxRate: 0.2,
      netCents: 75,
      taxCents: 15,
      grossCents: 90,
    });
  });

  it('TC-T1-21 converts major units to cents exactly, half up', () => {
    expect(centsFromMajorUnits('12.34')).toBe(1234);
    expect(centsFromMajorUnits(1.005)).toBe(101);
    expect(centsFromMajorUnits(0.285)).toBe(29);
    expect(() => centsFromMajorUnits('')).toThrow(RangeError);
    expect(() => centsFromMajorUnits('abc')).toThrow(RangeError);
  });

  it('TC-T1-22 multiplies a percentage exactly (platform fee)', () => {
    expect(multiplyCents(1250, 2.9, 100)).toBe(36);
    expect(multiplyCents(50, 2.9, 100)).toBe(1);
    expect(multiplyCents(-25, 0.1)).toBe(-2);
    expect(platformFeeCents(1190, 0.19, 10)).toBe(100);
  });

  it('TC-T1-23 reads the same view back from a stored breakdown', () => {
    const t = T({ pricePerKwh: '0.30', pricePerSession: '1.00', taxRate: '0.19' });
    const priced = priceSessionCost(session({ tariff: t, energyWh: 10_000 }));
    const read = pricedSessionFromBreakdown(priced.breakdown);
    expect(read).toEqual(priced);
    expect(sessionCostDimensions(priced.breakdown)?.energyCostCents).toEqual([
      { taxRate: 0.19, netCents: 300, taxCents: 57, grossCents: 357 },
    ]);
  });
});
