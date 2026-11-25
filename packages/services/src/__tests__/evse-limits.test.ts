// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  acSessionFloorKw,
  computeEvseLimits,
  effectiveBalancingMode,
  EVSE_DEMAND_PROBE_MS,
  EVSE_DEMAND_PROBE_PERIOD_MS,
  EVSE_DEMAND_SETTLE_MS,
  measuredDemandCapKw,
  measuredDemandProbing,
  stationPhaseWeights,
  stationProfileWatts,
} from '../evse-limits.js';
import type { EvseSessionInfo, StationPowerInfo } from '../load-management-model.js';
import type { StationRate } from '../load-management-profiles.js';

function session(overrides: Partial<EvseSessionInfo> = {}): EvseSessionInfo {
  return {
    sessionId: 'ses_1',
    transactionId: 'tx-1',
    evseDbId: 'evs_1',
    evseNumber: 1,
    unitId: 'unt_1',
    kind: 'ac',
    ratingKw: 22,
    ratingA: 32,
    tariffId: 'trf_1',
    tariffMaxCurrentA: null,
    phases: null,
    startedAt: new Date('2026-06-04T10:00:00Z'),
    ...overrides,
  };
}

function station(overrides: Partial<StationPowerInfo> = {}): StationPowerInfo {
  return {
    id: 'sta_1',
    stationId: 'EM4-MASTER-01',
    circuitId: 'cir_1',
    currentDrawKw: 0,
    phasePowerKw: null,
    maxPowerKw: 44,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    minPowerKw: 0,
    rateUnit: 'A',
    profileId: 1_000_000_000,
    balancingMode: 'station',
    evseLimitsRefusedAt: null,
    circuitVoltageV: 230,
    circuitPhases: 3,
    sessions: [],
    ...overrides,
  };
}

const threePhase: StationRate = { rateUnit: 'A', voltageV: 230, phases: 3 };
// The kW a three-phase 230 V station draws at `amps` per phase.
const kwAt = (amps: number): number => (amps * 230 * 3) / 1000;

describe('effectiveBalancingMode', () => {
  it('limits per EVSE when chosen, or when an AC session has a tariff limit', () => {
    expect(effectiveBalancingMode(station())).toBe('station');
    expect(effectiveBalancingMode(station({ balancingMode: 'evse' }))).toBe('evse');
    expect(effectiveBalancingMode(station({ sessions: [session({ tariffMaxCurrentA: 6 })] }))).toBe(
      'evse',
    );
    expect(
      effectiveBalancingMode(
        station({ sessions: [session({ kind: 'dc', tariffMaxCurrentA: 6 })] }),
      ),
    ).toBe('station');
  });

  it('falls back to one station limit after the station refused EVSE limits', () => {
    expect(
      effectiveBalancingMode(
        station({
          balancingMode: 'evse',
          evseLimitsRefusedAt: new Date(),
          sessions: [session({ tariffMaxCurrentA: 6 })],
        }),
      ),
    ).toBe('station');
  });
});

describe('computeEvseLimits', () => {
  it('splits a 32 A box into 6 A for the capped session and 26 A for the other (discussion 64)', () => {
    const s = station({
      sessions: [
        session({ tariffMaxCurrentA: 6 }),
        session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2 }),
      ],
    });
    const limits = computeEvseLimits(s, kwAt(32), threePhase);
    expect(limits).toEqual([
      {
        sessionId: 'ses_1',
        transactionId: 'tx-1',
        evseNumber: 1,
        unitId: 'unt_1',
        kind: 'ac',
        limitA: 6,
        limitKw: kwAt(6),
        phases: 3,
        reason: 'tariff_limit',
        paused: false,
      },
      {
        sessionId: 'ses_2',
        transactionId: 'tx-2',
        evseNumber: 2,
        unitId: 'unt_1',
        kind: 'ac',
        limitA: 26,
        limitKw: kwAt(26),
        phases: 3,
        reason: 'station_share',
        paused: false,
      },
    ]);
  });

  it('pauses the later session at 0 A when a 10 A share cannot give both 6 A', () => {
    const s = station({
      sessions: [
        session(),
        session({
          sessionId: 'ses_2',
          evseNumber: 2,
          startedAt: new Date('2026-06-04T10:30:00Z'),
        }),
      ],
    });
    const [first, second] = computeEvseLimits(s, kwAt(10), threePhase);
    expect(first).toMatchObject({ limitA: 10, paused: false, reason: 'station_share' });
    expect(second).toMatchObject({ limitA: 0, limitKw: 0, paused: true, reason: 'ac_min_pause' });
  });

  it('holds a session to its EVSE rating when it binds before the tariff', () => {
    const s = station({ sessions: [session({ ratingA: 16, tariffMaxCurrentA: 20 })] });
    expect(computeEvseLimits(s, kwAt(32), threePhase)[0]).toMatchObject({
      limitA: 16,
      reason: 'connector_max',
    });
  });

  it('gives a single-phase session its phase and leaves the other phases to a three-phase one', () => {
    const s = station({
      sessions: [
        session({ phases: 'L1' }),
        session({ sessionId: 'ses_2', evseNumber: 2, phases: 'L1L2L3' }),
      ],
    });
    const [single, three] = computeEvseLimits(s, kwAt(32), threePhase);
    expect(single).toMatchObject({ limitA: 16, phases: 1, limitKw: (16 * 230) / 1000 });
    expect(three).toMatchObject({ limitA: 16, phases: 3 });
  });

  it('gives a DC session a kW limit and never pauses it', () => {
    const s = station({
      rateUnit: 'W',
      sessions: [
        session({ kind: 'dc', ratingKw: 150, ratingA: null }),
        session({ sessionId: 'ses_2', kind: 'dc', evseNumber: 2, ratingKw: 150, ratingA: null }),
      ],
    });
    const limits = computeEvseLimits(s, 3, { rateUnit: 'W', voltageV: 230, phases: 3 });
    expect(limits.map((l) => [l.limitKw, l.limitA, l.phases, l.paused])).toEqual([
      [1.5, null, null, false],
      [1.5, null, null, false],
    ]);
  });

  it('shares one kW budget between an AC and a DC session at the circuit voltage', () => {
    const s = station({
      rateUnit: 'W',
      sessions: [
        session({ tariffMaxCurrentA: 16 }),
        session({ sessionId: 'ses_2', kind: 'dc', evseNumber: 2, ratingKw: 50, ratingA: null }),
      ],
    });
    const [ac, dc] = computeEvseLimits(s, 40, { rateUnit: 'W', voltageV: 230, phases: 3 });
    expect(ac).toMatchObject({ limitA: 16, reason: 'tariff_limit' });
    expect(dc?.limitKw).toBeCloseTo(40 - kwAt(16), 9);
  });

  it('pauses every AC session of a stopped station', () => {
    const s = station({ sessions: [session({ tariffMaxCurrentA: 6 })] });
    expect(computeEvseLimits(s, 0, threePhase)[0]).toMatchObject({ limitA: 0, paused: true });
  });

  it('shares each unit budget between its EVSEs within the station share', () => {
    const s = station({
      maxPowerKw: 88,
      unitBudgets: [
        { unitId: 'unt_1', kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null },
        { unitId: 'unt_2', kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null },
      ],
      sessions: [
        session(),
        session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2 }),
        session({ sessionId: 'ses_3', transactionId: 'tx-3', evseNumber: 3, unitId: 'unt_2' }),
      ],
    });
    const limits = computeEvseLimits(s, kwAt(64), threePhase);
    // A 32 A box fuse holds a continuous load of 25.6 A (80 percent).
    expect(limits.map((l) => [l.limitA, l.reason])).toEqual([
      [12.8, 'unit_budget'],
      [12.8, 'unit_budget'],
      [25.6, 'unit_budget'],
    ]);
  });

  it('holds a single-phase box to its budget on one phase', () => {
    const s = station({
      unitBudgets: [{ unitId: 'unt_1', kind: 'ac', maxCurrentA: 20, phases: 1, maxPowerKw: null }],
      sessions: [
        session({ phases: 'L1' }),
        session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2, phases: 'L2' }),
      ],
    });
    const limits = computeEvseLimits(s, kwAt(64), threePhase);
    expect(limits.map((l) => l.limitA)).toEqual([8, 8]);
    expect(limits.every((l) => l.reason === 'unit_budget')).toBe(true);
  });

  it('pauses the later session of a unit whose budget cannot give both 6 A', () => {
    const s = station({
      unitBudgets: [{ unitId: 'unt_1', kind: 'ac', maxCurrentA: 10, phases: 3, maxPowerKw: null }],
      sessions: [session(), session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2 })],
    });
    expect(computeEvseLimits(s, kwAt(64), threePhase).map((l) => [l.limitA, l.paused])).toEqual([
      [8, false],
      [0, true],
    ]);
  });

  it('holds the DC sessions of a unit to its kW budget', () => {
    const dc = { kind: 'dc' as const, ratingKw: 150, ratingA: null };
    const s = station({
      rateUnit: 'W',
      maxPowerKw: 300,
      unitBudgets: [
        { unitId: 'unt_1', kind: 'dc', maxCurrentA: null, phases: null, maxPowerKw: 100 },
      ],
      sessions: [
        session(dc),
        session({ ...dc, sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2 }),
      ],
    });
    const limits = computeEvseLimits(s, 300, { rateUnit: 'W', voltageV: 230, phases: 3 });
    expect(limits.map((l) => [l.limitKw, l.reason])).toEqual([
      [40, 'unit_budget'],
      [40, 'unit_budget'],
    ]);
  });

  it('adds no constraint for a unit without a budget', () => {
    const s = station({ sessions: [session(), session({ sessionId: 'ses_2', evseNumber: 2 })] });
    expect(computeEvseLimits(s, kwAt(64), threePhase).map((l) => l.limitA)).toEqual([32, 32]);
  });

  it('returns no EVSE limit without a session or a circuit voltage', () => {
    expect(computeEvseLimits(station(), 10, threePhase)).toEqual([]);
    expect(
      computeEvseLimits(station({ circuitVoltageV: 0, sessions: [session()] }), 10, undefined),
    ).toEqual([]);
  });
});

describe('per-phase split of the station limit (owner decision 3)', () => {
  const singles = [
    session({ sessionId: 'ses_a', evseNumber: 1, phases: 'L1' }),
    session({ sessionId: 'ses_b', evseNumber: 2, transactionId: 'tx-2', phases: 'L2' }),
  ];

  it('gives each phase the share its sessions ask for', () => {
    const s = station({ balancingMode: 'evse', sessions: singles });
    expect(stationPhaseWeights(s)).toEqual({ L1: 0.5, L2: 0.5, L3: 0 });
    // 11 kW split per phase: 5.5 kW on L1 and on L2, 23.9 A each (an even
    // spread over three phases would leave each car 15.9 A).
    const limits = computeEvseLimits(s, 11, threePhase, 'equal_share', stationPhaseWeights(s));
    expect(limits.map((l) => l.limitA)).toEqual([23.9, 23.9]);
    expect(limits.map((l) => l.phases)).toEqual([1, 1]);
    expect(limits.reduce((sum, l) => sum + l.limitKw, 0)).toBeLessThanOrEqual(11);
  });

  it('keeps a single-phase car within its phase next to a three-phase car', () => {
    const s = station({
      balancingMode: 'evse',
      sessions: [
        session({ sessionId: 'ses_a', phases: 'L1' }),
        session({ sessionId: 'ses_b', evseNumber: 2, transactionId: 'tx-2', phases: 'L1L2L3' }),
      ],
    });
    expect(stationPhaseWeights(s)).toEqual({ L1: 0.5, L2: 0.25, L3: 0.25 });
    const [a, b] = computeEvseLimits(
      s,
      kwAt(32),
      threePhase,
      'equal_share',
      stationPhaseWeights(s),
    );
    // 22.08 kW: L1 holds 48 A for both cars, L2 and L3 24 A for the
    // three-phase car, so each gets 24 A and the whole limit is used (an even
    // spread of 32 A per phase gave each 16 A, 14.7 kW).
    expect(b?.limitA).toBe(24);
    expect(a?.limitA).toBe(24);
    expect((a?.limitKw ?? 0) + (b?.limitKw ?? 0)).toBeLessThanOrEqual(kwAt(32) + 1e-9);
  });

  it('keeps the even spread for balanced, unknown, DC, station mode and fewer phases', () => {
    const three = [session({ phases: 'L1L2L3' })];
    expect(stationPhaseWeights(station({ balancingMode: 'evse', sessions: three }))).toBeNull();
    expect(
      stationPhaseWeights(station({ balancingMode: 'evse', sessions: [session()] })),
    ).toBeNull();
    expect(stationPhaseWeights(station({ sessions: singles }))).toBeNull();
    expect(
      stationPhaseWeights(
        station({ balancingMode: 'evse', sessions: [...singles, session({ kind: 'dc' })] }),
      ),
    ).toBeNull();
    expect(
      stationPhaseWeights(station({ balancingMode: 'evse', circuitPhases: 1, sessions: singles })),
    ).toBeNull();
    const even = computeEvseLimits(
      station({ balancingMode: 'evse', sessions: three }),
      11,
      threePhase,
    );
    expect(even[0]?.limitA).toBe(15.9);
  });

  it('counts a tariff limit and the EVSE rating in a phase share', () => {
    const s = station({
      balancingMode: 'evse',
      sessions: [
        session({ sessionId: 'ses_a', phases: 'L1', tariffMaxCurrentA: 8 }),
        session({ sessionId: 'ses_b', evseNumber: 2, transactionId: 'tx-2', phases: 'L2' }),
      ],
    });
    expect(stationPhaseWeights(s)).toEqual({ L1: 0.2, L2: 0.8, L3: 0 });
  });

  it('sends the station limit at three times its highest phase', () => {
    expect(stationProfileWatts(11, null)).toBe(11_000);
    expect(stationProfileWatts(11, { L1: 0.5, L2: 0.5, L3: 0 })).toBe(16_500);
    // Rounded down, never above the allocation, past float noise.
    expect(stationProfileWatts(3.6799, null)).toBe(3679);
    expect(stationProfileWatts(3.68, null)).toBe(3680);
    expect(stationProfileWatts(11, { L1: 1 / 3, L2: 1 / 3, L3: 1 / 3 })).toBe(11_000);
  });
});

describe('measured-draw cap at a lower supply voltage (review H3)', () => {
  const start = Date.parse('2026-06-04T10:00:00Z');
  // Held 6 A x 230 V x 3, drawing 6 A at 220 V and power factor 0.99.
  const heldKw = (6 * 230 * 3) / 1000;
  const drawKw = (6 * 220 * 3 * 0.99) / 1000;
  const capped = session({ startedAt: new Date(start), heldLimitKw: heldKw, drawKw });
  const at = (minutes: number): number => start + minutes * 60_000;

  it('reads the car at its limit from the measured current and lifts the cap', () => {
    expect(measuredDemandCapKw({ ...capped, drawA: 6, heldLimitA: 6 }, at(5))).toBeNull();
    // A car really drawing less in current keeps its cap.
    expect(
      measuredDemandCapKw({ ...capped, drawKw: 2, drawA: 2.9, heldLimitA: 6 }, at(5)),
    ).not.toBeNull();
  });

  it('lifts the cap in each probe window without measured current', () => {
    // Between probes the 94.7 percent reading keeps the cap at the held limit.
    expect(measuredDemandCapKw(capped, at(5))).toBeCloseTo(heldKw, 6);
    const firstProbe =
      start + EVSE_DEMAND_SETTLE_MS + EVSE_DEMAND_PROBE_PERIOD_MS - EVSE_DEMAND_PROBE_MS;
    expect(measuredDemandProbing(start, firstProbe - 1)).toBe(false);
    expect(measuredDemandProbing(start, firstProbe)).toBe(true);
    expect(measuredDemandCapKw(capped, firstProbe)).toBeNull();
    expect(measuredDemandCapKw(capped, firstProbe + EVSE_DEMAND_PROBE_MS - 1)).toBeNull();
    // The window repeats every period, and ends with it.
    expect(measuredDemandProbing(start, firstProbe + EVSE_DEMAND_PROBE_MS)).toBe(false);
    expect(measuredDemandProbing(start, firstProbe + EVSE_DEMAND_PROBE_PERIOD_MS)).toBe(true);
    expect(measuredDemandProbing(start, start + EVSE_DEMAND_SETTLE_MS - 1)).toBe(false);
  });
});

describe('acSessionFloorKw (A3, I3)', () => {
  const one = (phases: string): EvseSessionInfo => session({ sessionId: phases, phases });

  it('counts 6 A on the busiest phase three times on a three-phase circuit', () => {
    // A limit spread evenly over three phases: a one-phase car needs 6 A on its phase.
    expect(acSessionFloorKw(station({ sessions: [one('L1')] }))).toBeCloseTo(kwAt(6), 9);
    expect(acSessionFloorKw(station({ sessions: [one('L1'), one('L2')] }))).toBeCloseTo(kwAt(6), 9);
    expect(acSessionFloorKw(station({ sessions: [one('L1'), one('L1')] }))).toBeCloseTo(
      kwAt(12),
      9,
    );
    expect(acSessionFloorKw(station({ sessions: [session()] }))).toBeCloseTo(kwAt(6), 9);
  });

  it('counts each session at its own 6 A power when the limit counts in full on every phase', () => {
    const st = station({ sessions: [one('L1'), session({ sessionId: 's3' })] });
    expect(acSessionFloorKw(st, true)).toBeCloseTo((6 * 230 * 1 + 6 * 230 * 3) / 1000, 9);
    // Phases not aligned to the panel: the measured count still holds.
    const measured = station({
      sessions: [
        session({ sessionId: 'a', phases: null, measuredPhases: 'L1' }),
        session({ sessionId: 'b', phases: null, measuredPhases: 'L2' }),
      ],
    });
    expect(acSessionFloorKw(measured, true)).toBeCloseTo((2 * 6 * 230) / 1000, 9);
  });

  it('counts 6 A per session on a single-phase circuit, and nothing without an AC session', () => {
    const single = station({
      circuitPhases: 1,
      sessions: [session(), session({ sessionId: 's2' })],
    });
    expect(acSessionFloorKw(single)).toBeCloseTo((2 * 6 * 230) / 1000, 9);
    expect(acSessionFloorKw(station({ sessions: [session({ kind: 'dc' })] }))).toBe(0);
    expect(acSessionFloorKw(station({ circuitVoltageV: 0, sessions: [session()] }))).toBe(0);
  });
});

describe('W stations split per EVSE on a three-phase circuit (A3, I3)', () => {
  const wRate: StationRate = { rateUnit: 'W', voltageV: 230, phases: 3 };
  const wStation = (sessions: EvseSessionInfo[]): StationPowerInfo =>
    station({ rateUnit: 'W', balancingMode: 'evse', sessions });

  it('lets a one-phase session take the whole W limit on its phase', () => {
    const [limit] = computeEvseLimits(wStation([session({ phases: 'L1' })]), 1.748, wRate);
    expect(limit?.paused).toBe(false);
    expect(limit?.limitA).toBeCloseTo(7.6, 9);
  });

  it('keeps sessions on different phases within the W limit together', () => {
    const sessions = ['L1', 'L2', 'L3'].map((phases, i) =>
      session({
        sessionId: `s${String(i)}`,
        transactionId: `t${String(i)}`,
        evseNumber: i + 1,
        phases,
      }),
    );
    const limits = computeEvseLimits(wStation(sessions), 6.9, wRate);
    const totalKw = limits.reduce((sum, l) => sum + ((l.limitA ?? 0) * 230) / 1000, 0);
    expect(totalKw).toBeLessThanOrEqual(6.9 + 1e-9);
    expect(limits.every((l) => (l.limitA ?? 0) >= 6)).toBe(true);
  });
});

describe('W-only stations and unit boxes (A3, I2)', () => {
  const wRate: StationRate = { rateUnit: 'W', voltageV: 230, phases: 3 };
  const boxed = (s: EvseSessionInfo): StationPowerInfo =>
    station({
      rateUnit: 'W',
      supportedRateUnits: ['W'],
      balancingMode: 'evse',
      unitBudgets: [{ unitId: 'unt_1', kind: 'ac', maxCurrentA: 16, phases: 1, maxPowerKw: null }],
      sessions: [s],
    });
  // A 16 A box carries 12.8 A continuous.
  const boxA = 16 * 0.8;

  it('keeps a W limit for a session of unknown phases within the box on any one phase', () => {
    const [limit] = computeEvseLimits(boxed(session({ phases: null })), 22, wRate);
    expect(((limit?.limitKw ?? 0) * 1000) / 230).toBeLessThanOrEqual(boxA + 1e-9);
  });

  it('converts the limit of a session measured on one phase at that one phase', () => {
    const one = session({ phases: null, measuredPhases: 'L1' });
    const [limit] = computeEvseLimits(boxed(one), 22, wRate);
    expect(limit?.paused).toBe(false);
    expect(limit?.limitA).toBeCloseTo(boxA, 9);
    expect(limit?.phases).toBe(1);
    expect(limit?.limitKw).toBeCloseTo(((limit?.limitA ?? 0) * 230) / 1000, 9);
    expect(((limit?.limitKw ?? 0) * 1000) / 230).toBeLessThanOrEqual(boxA + 1e-9);
  });
});
