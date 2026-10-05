// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  calculateSessionCost,
  calculateSessionCostAt,
  calculateSplitSessionCost,
  toSessionCostBreakdown,
} from '../cost-calculator.js';
import type { SessionPricingInput, SessionSegmentInput, TariffInput } from '../cost-calculator.js';
import { dimensionAmounts, parseSessionCostBreakdown, COST_DIMENSIONS } from '../price-display.js';
import {
  legacySessionCostTotal,
  legacySplitSessionCostTotal,
} from './fixtures/legacy-cost-reference.js';
import {
  perRateSessionCostCentsAt,
  perRateSplitSessionCostTotal,
} from './fixtures/per-rate-cost-reference.js';

/** Deterministic pseudo-random numbers (LCG), so a failure is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PRICES = [null, '0', '0.01', '0.05', '0.1234', '0.2152', '0.30', '0.4999', '1.00', '2.505'];
const RATES = [null, '0', '0.05', '0.07', '0.0825', '0.10', '0.19', '0.2', '0.25'];

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)] as T;
}

function randomTariff(next: () => number): TariffInput {
  return {
    pricePerKwh: pick(next, PRICES),
    pricePerMinute: pick(next, PRICES),
    pricePerSession: pick(next, PRICES),
    idleFeePricePerMinute: pick(next, PRICES),
    reservationFeePerMinute: pick(next, PRICES),
    taxRate: pick(next, RATES),
  };
}

const START = new Date('2026-03-01T10:00:00Z');

function randomScenario(next: () => number): SessionPricingInput {
  const segmentCount = Math.floor(next() * 4); // 0 to 3 segments
  const totalMinutes = 1 + next() * 300;
  const at = new Date(START.getTime() + totalMinutes * 60000);
  const energyWh = Math.round(next() * 80_000 * 1000) / 1000;
  const idleMinutes = next() < 0.5 ? 0 : next() * 60;
  const segments: SessionSegmentInput[] = [];
  let segStart = START;
  let energyStart = 0;
  let closedIdle = 0;
  for (let i = 0; i < segmentCount; i++) {
    const isLast = i === segmentCount - 1;
    const closeOpen = next() < 0.5;
    const endMs = START.getTime() + ((i + 1) / segmentCount) * totalMinutes * 60000;
    const energyEnd = isLast ? energyWh : Math.round(((i + 1) / segmentCount) * energyWh);
    const segIdle = isLast ? Math.max(0, idleMinutes - closedIdle) : (idleMinutes * next()) / 4;
    const open = isLast && !closeOpen;
    segments.push({
      tariff: randomTariff(next),
      startedAt: segStart,
      endedAt: open ? null : new Date(endMs),
      energyWhStart: energyStart,
      energyWhEnd: open ? null : energyEnd,
      idleMinutes: open ? 0 : segIdle,
    });
    closedIdle += segIdle;
    segStart = new Date(endMs);
    energyStart = energyEnd;
  }
  return {
    basis: 'net',
    tariff: segments[0]?.tariff ?? randomTariff(next),
    startedAt: START,
    at,
    energyWh,
    idleMinutes,
    gracePeriodMinutes: pick(next, [0, 0, 5, 10, 15]),
    reservationHoldingMinutes: next() < 0.6 ? 0 : Math.ceil(next() * 30),
    segments,
  };
}

describe('calculateSessionCostAt against the reference assembly (net basis)', () => {
  it('charges the reference amount to the cent for 5000 single and split sessions', () => {
    const next = random(33);
    for (let i = 0; i < 5000; i++) {
      const input = randomScenario(next);
      // Single-tariff sessions bill as the legacy calculator did; split
      // sessions round tax once per rate.
      const reference = perRateSessionCostCentsAt({
        tariff: input.tariff,
        startedAt: input.startedAt,
        endedAt: input.at,
        energyWh: input.energyWh,
        idleMinutes: input.idleMinutes,
        gracePeriodMinutes: input.gracePeriodMinutes,
        holdingMinutes: input.reservationHoldingMinutes,
        segments: input.segments.map((seg) => ({ ...seg })),
      });
      const breakdown = calculateSessionCostAt(input);
      expect({ i, total: breakdown.totalCents }).toEqual({ i, total: reference });
      const stored = toSessionCostBreakdown(breakdown);
      expect(stored.grossCents).toBe(reference);
      expect(stored.netCents + stored.taxCents).toBe(reference);
      // The per-segment components add up to the tax of each rate.
      const componentTax = new Map<number, number>();
      for (const group of stored.components ?? []) {
        for (const line of group.taxLines) {
          componentTax.set(line.taxRate, (componentTax.get(line.taxRate) ?? 0) + line.taxCents);
        }
      }
      for (const line of stored.taxLines) {
        expect(componentTax.get(line.taxRate) ?? 0).toBe(line.taxCents);
      }
    }
  });

  it('keeps the subtotal and tax of the legacy calculator for single tariffs', () => {
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      const tariff = randomTariff(next);
      const energy = Math.round(next() * 100_000);
      const minutes = next() * 600;
      const idle = next() * 90;
      const grace = pick(next, [0, 5, 10]);
      const holding = Math.floor(next() * 40);
      const legacy = legacySessionCostTotal(tariff, energy, minutes, idle, grace, holding);
      const result = calculateSessionCost(tariff, energy, minutes, idle, grace, holding, 'net');
      expect({
        subtotal: result.subtotalCents,
        tax: result.taxCents,
        total: result.totalCents,
      }).toEqual({
        subtotal: legacy.subtotalCents,
        tax: legacy.taxCents,
        total: legacy.totalCents,
      });
    }
  });

  it('rounds tax once per rate for split sessions', () => {
    const next = random(11);
    for (let i = 0; i < 1000; i++) {
      const count = 1 + Math.floor(next() * 4);
      const segments = Array.from({ length: count }, (_, index) => ({
        tariff: randomTariff(next),
        durationMinutes: next() * 120,
        energyDeliveredWh: Math.round(next() * 30_000),
        idleMinutes: next() < 0.5 ? 0 : next() * 30,
        isFirstSegment: index === 0,
      }));
      const grace = pick(next, [0, 5, 10]);
      const holding = Math.floor(next() * 40);
      const reference = perRateSplitSessionCostTotal(segments, grace, holding);
      const result = calculateSplitSessionCost(segments, grace, holding, 'net');
      expect({ s: result.subtotalCents, t: result.taxCents }).toEqual({
        s: reference.subtotalCents,
        t: reference.taxCents,
      });
    }
  });

  it('keeps the legacy amounts when no two parts of a split session share a rate', () => {
    const rates = ['0.05', '0.07', '0.19', '0.25'];
    const next = random(17);
    for (let i = 0; i < 500; i++) {
      const count = 1 + Math.floor(next() * 4);
      const segments = Array.from({ length: count }, (_, index) => ({
        tariff: {
          ...randomTariff(next),
          // A rate per segment, and no holding fee to share the first rate.
          taxRate: rates[index] ?? null,
          reservationFeePerMinute: null,
        },
        durationMinutes: next() * 120,
        energyDeliveredWh: Math.round(next() * 30_000),
        idleMinutes: next() < 0.5 ? 0 : next() * 30,
        isFirstSegment: index === 0,
      }));
      const legacy = legacySplitSessionCostTotal(segments, 5, 10);
      const result = calculateSplitSessionCost(segments, 5, 10, 'net');
      expect({ s: result.subtotalCents, t: result.taxCents }).toEqual({
        s: legacy.subtotalCents,
        t: legacy.taxCents,
      });
    }
  });

  it('prices an open last segment as if it closed at the moment priced', () => {
    const tariffA: TariffInput = {
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.10',
      reservationFeePerMinute: '0.05',
      taxRate: '0.19',
    };
    const tariffB: TariffInput = { ...tariffA, pricePerKwh: '0.50', taxRate: '0.07' };
    const mid = new Date(START.getTime() + 30 * 60000);
    const end = new Date(START.getTime() + 60 * 60000);
    const open: SessionPricingInput = {
      basis: 'net',
      tariff: tariffA,
      startedAt: START,
      at: end,
      energyWh: 20_000,
      idleMinutes: 20,
      gracePeriodMinutes: 5,
      reservationHoldingMinutes: 10,
      segments: [
        {
          tariff: tariffA,
          startedAt: START,
          endedAt: mid,
          energyWhStart: 0,
          energyWhEnd: 10_000,
          idleMinutes: 4,
        },
        {
          tariff: tariffB,
          startedAt: mid,
          endedAt: null,
          energyWhStart: 10_000,
          energyWhEnd: null,
          idleMinutes: 0,
        },
      ],
    };
    const closed: SessionPricingInput = {
      ...open,
      segments: [
        open.segments[0] as SessionSegmentInput,
        {
          ...(open.segments[1] as SessionSegmentInput),
          endedAt: end,
          energyWhEnd: 20_000,
          idleMinutes: 16,
        },
      ],
    };
    const before = calculateSessionCostAt(open);
    expect(calculateSessionCostAt(closed)).toEqual(before);
    // Idle 4 + 16 = 20 minutes, 5 minutes grace taken from the last segment.
    // Segment 1: 300 + 100 fee + 4 * 0.10 = 440 net at 19%.
    // Segment 2: 500 + 11 * 0.10 = 610 net at 7%, tax 42.7 -> 43.
    // Holding: 10 min * 0.05 = 50 at 19%.
    // 19% once on 440 + 50 = 490: 93.1 -> 93 (per part it was 84 + 10 = 94).
    expect(before.totalCents).toBe(440 + 610 + 50 + 93 + 43);
  });

  it('uses the session snapshot when there is one segment or none', () => {
    const tariff: TariffInput = {
      pricePerKwh: '0.25',
      pricePerMinute: '0.02',
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: '0.10',
      taxRate: '0.08',
    };
    const base: SessionPricingInput = {
      basis: 'net',
      tariff,
      startedAt: START,
      at: new Date(START.getTime() + 45 * 60000),
      energyWh: 12_000,
      idleMinutes: 0,
      gracePeriodMinutes: 0,
      reservationHoldingMinutes: 15,
      segments: [],
    };
    const expected = calculateSessionCost(tariff, 12_000, 45, 0, 0, 15, 'net');
    expect(calculateSessionCostAt(base)).toEqual(expected);
    expect(
      calculateSessionCostAt({
        ...base,
        segments: [
          {
            tariff: { ...tariff, pricePerKwh: '9.99' },
            startedAt: START,
            endedAt: null,
            energyWhStart: 0,
            energyWhEnd: null,
            idleMinutes: 0,
          },
        ],
      }),
    ).toEqual(expected);
    // Holding fee 15 * 0.10 = 150 is in the cost: 300 + 90 + 150 = 540 net, 43.2 -> 43 tax.
    expect(expected.totalCents).toBe(583);
  });
});

describe('gross tax basis', () => {
  const grossTariff: TariffInput = {
    pricePerKwh: '0.357',
    pricePerMinute: '0.0119',
    pricePerSession: '1.19',
    idleFeePricePerMinute: '0.119',
    reservationFeePerMinute: '0.0595',
    taxRate: '0.19',
  };

  it('charges gross unit price times quantity exactly, per component', () => {
    const result = calculateSessionCost(grossTariff, 12_345, 47, 13, 5, 7, 'gross');
    // 12.345 kWh * 0.357 = 4.407165 -> 441; 47 * 0.0119 = 0.5593 -> 56; 119;
    // (13 - 5) * 0.119 = 0.952 -> 95; 7 * 0.0595 = 0.4165 -> 42.
    expect(result.energyCostCents).toBe(441);
    expect(result.timeCostCents).toBe(56);
    expect(result.sessionFeeCents).toBe(119);
    expect(result.idleFeeCents).toBe(95);
    expect(result.reservationHoldingFeeCents).toBe(42);
    expect(result.totalCents).toBe(441 + 56 + 119 + 95 + 42);
    // The tax contained in 753: 753 - round(753 / 1.19) = 753 - 633 = 120.
    expect(result.subtotalCents).toBe(633);
    expect(result.taxCents).toBe(120);
    expect(result.basis).toBe('gross');
  });

  it('gives invoice lines whose net plus tax equal each gross component', () => {
    const result = calculateSessionCost(grossTariff, 12_345, 47, 13, 5, 7, 'gross');
    const [line] = result.taxLines;
    expect(line).toBeDefined();
    if (line == null) return;
    const amounts = dimensionAmounts(line, 'gross');
    let net = 0;
    let tax = 0;
    for (const d of COST_DIMENSIONS) {
      expect(amounts[d].netCents + amounts[d].taxCents).toBe(line[d]);
      net += amounts[d].netCents;
      tax += amounts[d].taxCents;
    }
    expect(net).toBe(result.subtotalCents);
    expect(tax).toBe(result.taxCents);
  });

  it('equals the net basis without tax', () => {
    const next = random(99);
    for (let i = 0; i < 500; i++) {
      const tariff = { ...randomTariff(next), taxRate: '0' };
      const energy = Math.round(next() * 50_000);
      const minutes = next() * 200;
      expect(calculateSessionCost(tariff, energy, minutes, 0, 0, 0, 'gross').totalCents).toBe(
        calculateSessionCost(tariff, energy, minutes, 0, 0, 0, 'net').totalCents,
      );
    }
  });

  it('charges the same as the net basis for prices that are exact grosses of round net prices', () => {
    // 0.30 net at 19% is 0.357 gross. 10 kWh: 300 net + 57 tax = 357 either way.
    const net: TariffInput = {
      ...grossTariff,
      pricePerKwh: '0.30',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
    };
    const gross: TariffInput = { ...net, pricePerKwh: '0.357' };
    expect(calculateSessionCost(gross, 10_000, 0, 0, 0, 0, 'gross').totalCents).toBe(357);
    expect(calculateSessionCost(net, 10_000, 0, 0, 0, 0, 'net').totalCents).toBe(357);
  });

  it('extracts tax once per rate on split sessions', () => {
    const reduced: TariffInput = { ...grossTariff, pricePerKwh: '0.321', taxRate: '0.07' };
    const result = calculateSplitSessionCost(
      [
        {
          tariff: grossTariff,
          durationMinutes: 30,
          energyDeliveredWh: 10_000,
          idleMinutes: 0,
          isFirstSegment: true,
        },
        {
          tariff: reduced,
          durationMinutes: 30,
          energyDeliveredWh: 10_000,
          idleMinutes: 0,
          isFirstSegment: false,
        },
      ],
      0,
      10,
      'gross',
    );
    // Segment 1: 357 + 30 * 0.0119 = 0.357 -> 36 + 119 = 512 gross at 19%.
    // Segment 2: 321 + 36 = 357 gross at 7%: net 334, tax 23.
    // Holding: 10 * 0.0595 = 0.595 -> 60 gross at 19%.
    // 19% once on 512 + 60 = 572 gross: net 481, tax 91 (per part it was
    // 82 + 10 = 92). Shares by gross: 81.45 and 9.55, so 81 and 10.
    expect(result.segments.map((s) => s.totalCents)).toEqual([512, 357]);
    expect(result.segments.map((s) => s.taxCents)).toEqual([81, 23]);
    expect(result.reservationHolding).toMatchObject({
      netCents: 50,
      taxCents: 10,
      reservationHoldingFeeCents: 60,
    });
    expect(result.taxLines.map((l) => [l.taxRate, l.netCents, l.taxCents])).toEqual([
      [0.07, 334, 23],
      [0.19, 481, 91],
    ]);
    expect(result.totalCents).toBe(512 + 357 + 60);
    expect(result.taxCents).toBe(91 + 23);
    expect(result.subtotalCents + result.taxCents).toBe(result.totalCents);
  });

  it('prices a session through calculateSessionCostAt on the gross basis', () => {
    const at = new Date(START.getTime() + 47 * 60000);
    const result = calculateSessionCostAt({
      basis: 'gross',
      tariff: grossTariff,
      startedAt: START,
      at,
      energyWh: 12_345,
      idleMinutes: 13,
      gracePeriodMinutes: 5,
      reservationHoldingMinutes: 7,
      segments: [],
    });
    expect(result.totalCents).toBe(753);
  });
});

describe('toSessionCostBreakdown', () => {
  const tariff: TariffInput = {
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: '1.00',
    idleFeePricePerMinute: null,
    reservationFeePerMinute: '0.10',
    taxRate: '0.19',
  };

  it('stores a single-tariff cost as one component group', () => {
    const stored = toSessionCostBreakdown(calculateSessionCost(tariff, 10_000, 30, 0, 0, 5));
    expect(stored).toEqual({
      basis: 'net',
      netCents: 450,
      taxCents: 86,
      grossCents: 536,
      taxLines: [{ taxRate: 0.19, netCents: 450, taxCents: 86 }],
      components: [
        {
          segment: null,
          taxLines: [
            {
              taxRate: 0.19,
              netCents: 450,
              taxCents: 86,
              energyCostCents: 300,
              timeCostCents: 0,
              sessionFeeCents: 100,
              idleFeeCents: 0,
              reservationHoldingFeeCents: 50,
            },
          ],
        },
      ],
    });
    expect(parseSessionCostBreakdown(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('stores a split cost per segment with the holding fee as segment null', () => {
    const stored = toSessionCostBreakdown(
      calculateSplitSessionCost(
        [
          {
            tariff,
            durationMinutes: 30,
            energyDeliveredWh: 5000,
            idleMinutes: 0,
            isFirstSegment: true,
          },
          {
            tariff: { ...tariff, taxRate: '0.07' },
            durationMinutes: 30,
            energyDeliveredWh: 5000,
            idleMinutes: 0,
            isFirstSegment: false,
          },
        ],
        0,
        5,
      ),
    );
    expect(stored.components?.map((g) => g.segment)).toEqual([1, 2, null]);
    // Segment 1: 150 + 100 fee = 250 at 19%. Segment 2: 150 at 7%, tax 10.5
    // -> 11. Holding: 5 * 0.10 = 50 at 19%. 19% once on 300: 57 (per part it
    // was 48 + 10 = 58), shared 47.5 and 9.5: 48 and 9.
    expect(stored.taxLines).toEqual([
      { taxRate: 0.07, netCents: 150, taxCents: 11 },
      { taxRate: 0.19, netCents: 300, taxCents: 57 },
    ]);
    expect(stored.components?.map((g) => g.taxLines[0]?.taxCents)).toEqual([48, 11, 9]);
    expect(stored.grossCents).toBe(150 + 11 + 300 + 57);
  });

  it('stores a zero cost without components', () => {
    const stored = toSessionCostBreakdown(
      calculateSessionCost({ ...tariff, pricePerSession: null }, 0, 0),
    );
    expect(stored).toEqual({
      basis: 'net',
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
      taxLines: [],
      components: [],
    });
    expect(toSessionCostBreakdown(calculateSplitSessionCost([], 0)).components).toEqual([]);
  });
});
