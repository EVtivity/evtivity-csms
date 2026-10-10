// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Property-based tests of the pricing engine (fast-check): the invariants of
// the tariff audit (test catalog TC-T1-30 to TC-T1-42), and the engine
// against the independent oracle on random sessions. A failure prints the
// seed and the shrunk counterexample; rerun with that seed to reproduce.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SessionPricingInput, SessionSegmentInput, TariffInput } from '../cost-calculator.js';
import type { TaxBasis } from '../price-display.js';
import { allocateCents, netFromGross, taxOnNet } from '../price-display.js';
import { priceSessionCost } from '../pricing-engine.js';
import type { PricedSession } from '../pricing-engine.js';
import {
  ORACLE_DIMENSIONS,
  exactNetFromGross,
  exactTaxOnNet,
  largestRemainder,
  minutesFromMs,
  priceSegments,
} from '../testing/pricing-oracle.js';
import type { OracleResult } from '../testing/pricing-oracle.js';

const START = Date.parse('2026-03-01T10:00:00Z');

/** A decimal string with up to 4 fraction digits, k / 10^4. */
const decimal4 = (max: number): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max }).map((k) => (k / 10_000).toFixed(4));

const priceArb = fc.option(decimal4(20_000), { nil: null }); // up to 2.0000
const rateArb = fc.option(decimal4(2_500), { nil: null }); // up to 25%

const tariffArb: fc.Arbitrary<TariffInput> = fc.record({
  pricePerKwh: priceArb,
  pricePerMinute: priceArb,
  pricePerSession: priceArb,
  idleFeePricePerMinute: priceArb,
  reservationFeePerMinute: priceArb,
  taxRate: rateArb,
});

interface RandomSegment {
  tariff: TariffInput;
  seconds: number;
  wh: number;
  idleSeconds: number;
}

const segmentArb: fc.Arbitrary<RandomSegment> = fc
  .record({
    tariff: tariffArb,
    seconds: fc.integer({ min: 0, max: 3 * 3600 }),
    wh: fc.integer({ min: 0, max: 50_000 }),
    idleShare: fc.integer({ min: 0, max: 100 }),
  })
  .map(({ tariff, seconds, wh, idleShare }) => ({
    tariff,
    seconds,
    wh,
    idleSeconds: Math.floor((seconds * idleShare) / 100),
  }));

interface RandomSession {
  basis: TaxBasis;
  segments: RandomSegment[];
  graceMinutes: number;
  holdingMinutes: number;
  ceilingCents: number | null;
}

const sessionArb: fc.Arbitrary<RandomSession> = fc.record({
  basis: fc.constantFrom<TaxBasis>('net', 'gross'),
  segments: fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
  graceMinutes: fc.integer({ min: 0, max: 30 }),
  holdingMinutes: fc.integer({ min: 0, max: 60 }),
  ceilingCents: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
});

/** The engine input for a random session: closed segments, or the session snapshot for one. */
function engineInput(s: RandomSession): SessionPricingInput & { ceilingCents: number | null } {
  let t = START;
  let wh = 0;
  const segments: SessionSegmentInput[] = s.segments.map((seg) => {
    const out: SessionSegmentInput = {
      tariff: seg.tariff,
      startedAt: new Date(t),
      endedAt: new Date(t + seg.seconds * 1000),
      energyWhStart: wh,
      energyWhEnd: wh + seg.wh,
      idleMinutes: seg.idleSeconds / 60,
    };
    t += seg.seconds * 1000;
    wh += seg.wh;
    return out;
  });
  const first = s.segments[0] as RandomSegment;
  return {
    basis: s.basis,
    tariff: first.tariff,
    startedAt: new Date(START),
    at: new Date(t),
    energyWh: wh,
    idleMinutes: s.segments.reduce((m, seg) => m + seg.idleSeconds, 0) / 60,
    gracePeriodMinutes: s.graceMinutes,
    reservationHoldingMinutes: s.holdingMinutes,
    segments: segments.length > 1 ? segments : [],
    ceilingCents: s.ceilingCents,
  };
}

/** The oracle for the same session. One segment uses the first tariff for the whole session. */
function oracleOf(s: RandomSession): OracleResult {
  return priceSegments({
    basis: s.basis,
    graceMinutes: s.graceMinutes,
    reservationHoldingMinutes: s.holdingMinutes,
    ceilingCents: s.ceilingCents,
    segments: s.segments.map((seg) => ({
      tariff: seg.tariff,
      durationMinutes: minutesFromMs(seg.seconds * 1000),
      energyWh: seg.wh,
      idleMinutes: minutesFromMs(seg.idleSeconds * 1000),
    })),
  });
}

const ENGINE_DIMENSION = {
  energy: 'energyCostCents',
  time: 'timeCostCents',
  sessionFee: 'sessionFeeCents',
  idleFee: 'idleFeeCents',
  reservationHoldingFee: 'reservationHoldingFeeCents',
} as const;

function oracleDimensionLines(o: OracleResult): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const d of ORACLE_DIMENSIONS) {
    out[ENGINE_DIMENSION[d]] = o.rates
      .filter((r) => r.dimensions[d].amountCents !== 0)
      .map((r) => ({
        taxRate: r.taxRate,
        netCents: r.dimensions[d].netCents,
        taxCents: r.dimensions[d].taxCents,
        grossCents: r.dimensions[d].grossCents,
      }));
  }
  return out;
}

const RUNS = { numRuns: 3000 };

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * A rate k / 10^6 (a percentage with up to 4 decimals) and a net amount whose
 * tax at that rate is exactly a half cent: net = M / 2 + j * M with
 * M = 10^6 / gcd(k, 10^6) even. Random amounts almost never hit a tie, and a
 * tie is where a float product rounds the wrong way (B12).
 */
const taxTieArb = fc
  .record({ k: fc.integer({ min: 1, max: 250_000 }), j: fc.integer({ min: 0, max: 1000 }) })
  .map(({ k, j }) => {
    const m = 1_000_000 / gcd(k, 1_000_000);
    return { k, rate: (k / 1_000_000).toFixed(6), net: m / 2 + j * m, even: m % 2 === 0 };
  })
  .filter((x) => x.even && x.net <= 100_000_000);

/**
 * A rate k / 10^6 and a gross amount whose net, gross / (1 + rate), is exactly
 * a half cent: gross = B / 2 + j * B with B = (10^6 + k) / gcd(10^6, 10^6 + k).
 * B is even exactly when k holds the factor 2 six times (k = 64 * odd), so the
 * generator builds k that way instead of filtering.
 */
const grossTieArb = fc
  .record({ m: fc.integer({ min: 0, max: 1952 }), j: fc.integer({ min: 0, max: 1000 }) })
  .map(({ m, j }) => {
    const k = 64 * (2 * m + 1);
    const b = (1_000_000 + k) / gcd(1_000_000, 1_000_000 + k);
    return { rate: (k / 1_000_000).toFixed(6), gross: b / 2 + j * b };
  });

describe('pricing engine properties', () => {
  it('TC-T1-30 taxes every rate with up to 4 decimals (percent with up to 4) exactly, half up', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (net, k) => {
          const rate = (k / 1_000_000).toFixed(6);
          expect(taxOnNet(net, Number(rate))).toBe(exactTaxOnNet(net, rate));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('TC-T1-31 recovers the net of net plus tax exactly (netFromGross round trip)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (net, k) => {
          const rate = Number((k / 1_000_000).toFixed(6));
          const gross = net + taxOnNet(net, rate);
          expect(netFromGross(gross, rate)).toBe(net);
          expect(netFromGross(gross, rate)).toBe(exactNetFromGross(gross, rate));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('TC-T1-32 shares cents exactly by largest remainder, ties to the earlier part', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 }),
        (total, weights) => {
          const parts = allocateCents(total, weights);
          expect(parts).toEqual(largestRemainder(total, weights));
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('TC-T1-30b rounds every exact half cent of tax up, for any rate with up to 4 percent decimals', () => {
    fc.assert(
      fc.property(taxTieArb, ({ k, rate, net }) => {
        const product = BigInt(net) * BigInt(k);
        // A tie: net * rate is a whole number of cents plus one half...
        expect(product % 1_000_000n).toBe(500_000n);
        // ...and it rounds up.
        const up = Number((product + 500_000n) / 1_000_000n);
        expect(exactTaxOnNet(net, rate)).toBe(up);
        expect(taxOnNet(net, Number(rate))).toBe(up);
      }),
      { numRuns: 20_000 },
    );
  });

  it('TC-T1-31b rounds every exact half cent of net up when splitting a gross', () => {
    fc.assert(
      fc.property(grossTieArb, ({ rate, gross }) => {
        expect(netFromGross(gross, Number(rate))).toBe(exactNetFromGross(gross, rate));
      }),
      { numRuns: 20_000 },
    );
  });

  it('TC-T1-32b breaks equal remainders toward the earlier part (small amounts, many ties)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 2, maxLength: 5 }),
        (total, weights) => {
          expect(allocateCents(total, weights)).toEqual(largestRemainder(total, weights));
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it('TC-T1-33 equals the independent oracle on random sessions (totals, rates, dimensions, segments)', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        const priced = priceSessionCost(engineInput(s));
        const oracle = oracleOf(s);
        expect(priced.grossCents).toBe(oracle.charged.grossCents);
        expect(priced.netCents).toBe(oracle.charged.netCents);
        expect(priced.taxCents).toBe(oracle.charged.taxCents);
        expect(priced.taxLines).toEqual(oracle.charged.rates);
        if (!oracle.charged.capped) {
          expect(priced.dimensions).toEqual(oracleDimensionLines(oracle));
          if (s.segments.length > 1) {
            const bySegment = new Map(priced.segments.map((g) => [g.segment, g]));
            oracle.segments.forEach((seg, i) => {
              const got = bySegment.get(i + 1);
              expect(got?.total.grossCents ?? 0).toBe(seg.grossCents);
              expect(got?.total.taxCents ?? 0).toBe(seg.taxCents);
              for (const d of ORACLE_DIMENSIONS) {
                expect(got?.dimensions[ENGINE_DIMENSION[d]].taxCents ?? 0).toBe(
                  seg.dimensions[d].taxCents,
                );
              }
            });
          }
        }
      }),
      RUNS,
    );
  });

  it('TC-T1-34 charges net plus tax, never below 0, with parts that add up', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        const priced = priceSessionCost(engineInput(s));
        expect(priced.netCents + priced.taxCents).toBe(priced.grossCents);
        expect(priced.netCents).toBeGreaterThanOrEqual(0);
        expect(priced.taxCents).toBeGreaterThanOrEqual(0);
        const lines = priced.taxLines;
        expect(lines.reduce((a, l) => a + l.grossCents, 0)).toBe(priced.grossCents);
        for (const line of lines) {
          expect(line.netCents).toBeGreaterThanOrEqual(0);
          expect(line.taxCents).toBeGreaterThanOrEqual(0);
        }
        if (priced.dimensions != null) {
          const all = Object.values(priced.dimensions).flat();
          for (const d of all) {
            expect(d.netCents).toBeGreaterThanOrEqual(0);
            expect(d.taxCents).toBeGreaterThanOrEqual(0);
          }
          expect(all.reduce((a, d) => a + d.grossCents, 0)).toBe(priced.grossCents);
          expect(all.reduce((a, d) => a + d.taxCents, 0)).toBe(priced.taxCents);
        }
        if (priced.segments.length > 0) {
          expect(priced.segments.reduce((a, g) => a + g.total.grossCents, 0)).toBe(
            priced.grossCents,
          );
        }
      }),
      RUNS,
    );
  });

  it('TC-T1-35 respects the ceiling: charges the lesser of price and ceiling', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        const priced = priceSessionCost(engineInput(s));
        const uncapped = priceSessionCost({ ...engineInput(s), ceilingCents: null });
        const expected =
          s.ceilingCents == null
            ? uncapped.grossCents
            : Math.min(uncapped.grossCents, s.ceilingCents);
        expect(priced.grossCents).toBe(expected);
        if (priced.grossCents < uncapped.grossCents) {
          expect(priced.pricedGrossCents).toBe(uncapped.grossCents);
        }
      }),
      RUNS,
    );
  });

  it('TC-T1-36 never charges less for more energy, time, or idle (single tariff)', () => {
    fc.assert(
      fc.property(
        tariffArb,
        fc.constantFrom<TaxBasis>('net', 'gross'),
        fc.integer({ min: 0, max: 30 }),
        fc.tuple(fc.integer({ min: 0, max: 7200 }), fc.integer({ min: 0, max: 3600 })),
        fc.tuple(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 20_000 })),
        fc.tuple(fc.integer({ min: 0, max: 3600 }), fc.integer({ min: 0, max: 1800 })),
        (tariff, basis, grace, [sec, dSec], [wh, dWh], [idle, dIdle]) => {
          const at = (seconds: number, energy: number, idleSeconds: number): PricedSession =>
            priceSessionCost({
              basis,
              tariff,
              startedAt: new Date(START),
              at: new Date(START + seconds * 1000),
              energyWh: energy,
              idleMinutes: idleSeconds / 60,
              gracePeriodMinutes: grace,
              reservationHoldingMinutes: 0,
              segments: [],
            });
          const before = at(sec, wh, Math.min(idle, sec));
          const after = at(sec + dSec, wh + dWh, Math.min(idle, sec) + Math.min(dIdle, dSec));
          expect(after.grossCents).toBeGreaterThanOrEqual(before.grossCents);
        },
      ),
      RUNS,
    );
  });

  it('TC-T1-37 shows a running cost at or below the final cost (split session, no ceiling)', () => {
    fc.assert(
      fc.property(sessionArb, fc.integer({ min: 0, max: 100 }), (s, share) => {
        const final = engineInput({ ...s, ceilingCents: null });
        if (final.segments.length < 2) return;
        // The moment priced lies in the last segment, which is open then.
        const last = final.segments[final.segments.length - 1] as SessionSegmentInput;
        const lastSeg = s.segments[s.segments.length - 1] as RandomSegment;
        const elapsed = Math.floor((lastSeg.seconds * share) / 100);
        const closedIdle = final.segments.slice(0, -1).reduce((m, seg) => m + seg.idleMinutes, 0);
        const running: SessionPricingInput = {
          ...final,
          at: new Date(last.startedAt.getTime() + elapsed * 1000),
          energyWh: last.energyWhStart + Math.floor((lastSeg.wh * share) / 100),
          idleMinutes: closedIdle + Math.min(lastSeg.idleSeconds, elapsed) / 60,
          segments: [
            ...final.segments.slice(0, -1),
            { ...last, endedAt: null, energyWhEnd: null, idleMinutes: 0 },
          ],
        };
        expect(priceSessionCost(running).grossCents).toBeLessThanOrEqual(
          priceSessionCost(final).grossCents,
        );
      }),
      RUNS,
    );
  });

  it('TC-T1-38 frees the same idle minutes whether or not the session is split (grace independent of split)', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        const tariff: TariffInput = {
          ...(s.segments[0] as RandomSegment).tariff,
          idleFeePricePerMinute: '1.0000',
        };
        const same = { ...s, segments: s.segments.map((seg) => ({ ...seg, tariff })) };
        const split = priceSessionCost({ ...engineInput(same), ceilingCents: null });
        const whole = priceSessionCost({
          ...engineInput(same),
          segments: [],
          ceilingCents: null,
        });
        const billable = (p: PricedSession): number =>
          p.segments.reduce((m, g) => m + (g.billableIdleMinutes ?? 0), 0);
        const idle = s.segments.reduce((m, seg) => m + seg.idleSeconds, 0) / 60;
        const expected = Math.max(0, idle - s.graceMinutes);
        expect(billable(split)).toBeCloseTo(expected, 9);
        expect(billable(whole)).toBeCloseTo(expected, 9);
      }),
      RUNS,
    );
  });

  it('TC-T1-39 prices a split session of one tariff within the rounding of its parts of the whole', () => {
    fc.assert(
      fc.property(sessionArb, (s) => {
        if (s.segments.length < 2) return;
        const tariff = { ...(s.segments[0] as RandomSegment).tariff };
        const same = { ...s, segments: s.segments.map((seg) => ({ ...seg, tariff })) };
        const split = priceSessionCost({ ...engineInput(same), ceilingCents: null });
        const whole = priceSessionCost({
          ...engineInput(same),
          segments: [],
          ceilingCents: null,
        });
        // Energy, time, and idle round once per segment: at most half a cent
        // each per segment, plus a cent of tax rounding.
        const bound = Math.ceil(1.5 * same.segments.length * 1.25) + 1;
        expect(Math.abs(split.grossCents - whole.grossCents)).toBeLessThanOrEqual(bound);
      }),
      RUNS,
    );
  });
});
