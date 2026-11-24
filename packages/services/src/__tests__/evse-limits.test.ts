// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  computeEvseLimits,
  effectiveBalancingMode,
  stationPhaseWeights,
  stationProfileWatts,
} from '../evse-limits.js';
import type { EvseSessionInfo, StationPowerInfo, StationRate } from '../load-management.service.js';

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
    expect(limits.map((l) => [l.limitA, l.reason])).toEqual([
      [16, 'unit_budget'],
      [16, 'unit_budget'],
      [32, 'connector_max'],
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
    expect(limits.map((l) => l.limitA)).toEqual([10, 10]);
    expect(limits.every((l) => l.reason === 'unit_budget')).toBe(true);
  });

  it('pauses the later session of a unit whose budget cannot give both 6 A', () => {
    const s = station({
      unitBudgets: [{ unitId: 'unt_1', kind: 'ac', maxCurrentA: 10, phases: 3, maxPowerKw: null }],
      sessions: [session(), session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2 })],
    });
    expect(computeEvseLimits(s, kwAt(64), threePhase).map((l) => [l.limitA, l.paused])).toEqual([
      [10, false],
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
      [50, 'unit_budget'],
      [50, 'unit_budget'],
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
    expect(stationProfileWatts(11, { L1: 1 / 3, L2: 1 / 3, L3: 1 / 3 })).toBe(11_000);
  });
});
