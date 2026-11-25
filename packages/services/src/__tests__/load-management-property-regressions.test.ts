// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Regressions for the counterexamples the load management property test found
// (api load-management-safety-property.test.ts), one case each.

import { describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import type { AppliedAllocation } from '../load-limit-entries.js';
import type { EvseSessionInfo, HierarchyNode, StationPowerInfo } from '../load-management-model.js';

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const fake: FakeDb = createFakeDb();
  return fakeDatabaseModule(fake, { isOperatorStation: () => 'OPERATOR_STATION' });
});

const { reservedStationLimitsKw } = await import('../load-management-site-allocation.js');
const { wattLimitPhaseLoad, computeHierarchicalAllocation, withSendRateUnits, fixedPhaseLoad } =
  await import('../load-management-allocation.js');
const { unitEvsesOf } = await import('../load-management-site-status.js');
const { unitBoxPlan } = await import('../load-management-unit-boxes.js');

function station(overrides: Partial<StationPowerInfo> & { id: string }): StationPowerInfo {
  return {
    stationId: overrides.id.toUpperCase(),
    circuitId: 'cir_a',
    currentDrawKw: 0,
    phasePowerKw: null,
    maxPowerKw: 22,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    minPowerKw: 0,
    rateUnit: 'W',
    profileId: 1_000_000_000,
    circuitVoltageV: 230,
    circuitPhases: 3,
    balancingMode: 'station',
    ...overrides,
  };
}

function session(overrides: Partial<EvseSessionInfo> = {}): EvseSessionInfo {
  return {
    sessionId: 'ses_1',
    transactionId: 'tx-1',
    evseDbId: 'evs_1',
    evseNumber: 1,
    unitId: null,
    kind: 'ac',
    ratingKw: null,
    ratingA: 100,
    tariffId: null,
    tariffMaxCurrentA: null,
    phases: 'L1L2L3',
    startedAt: new Date('2026-11-24T09:00:00Z'),
    measuredPhases: 'L1L2L3',
    rotation: null,
    phaseSwitching: false,
    drawKw: null,
    ...overrides,
  };
}

function node(overrides: Partial<HierarchyNode> & { type: HierarchyNode['type'] }): HierarchyNode {
  return {
    id: overrides.type === 'circuit' ? 'cir_a' : 'pnl_a',
    name: 'node',
    maxContinuousKw: 1000,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations: [],
    children: [],
    phases: 3,
    breakerRatingAmps: 1000,
    voltageV: 230,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    ...overrides,
  };
}

function tree(
  stations: StationPowerInfo[],
  circuit: Partial<HierarchyNode> = {},
  panel: Partial<HierarchyNode> = {},
): HierarchyNode[] {
  const c = node({ type: 'circuit', phaseConnections: 'L1L2L3', stations, ...circuit });
  return [node({ type: 'panel', perPhaseCapacityKw: 1000 / 3, children: [c], ...panel })];
}

const kwOf = (results: Array<{ stationDbId: string; allocatedKw: number }>, id: string): number =>
  results.find((r) => r.stationDbId === id)?.allocatedKw ?? 0;

describe('load management property test counterexamples', () => {
  it('fits a retry against the limit another station still enforces, not its unconfirmed cut (2)', () => {
    // s0 accepted 21 kW and is cut to 0 this cycle; s1 refused and is retried.
    // The cut may not land (a CALLERROR), so the retry must leave s0's 21 kW.
    // A limits hold every phase, so the circuit total decides.
    const s0 = station({ id: 's0', rateUnit: 'A', supportedRateUnits: ['A'] });
    const s1 = station({ id: 's1', rateUnit: 'A', supportedRateUnits: ['A'] });
    const roots = tree([s0, s1], { maxContinuousKw: 32 });
    const limits = reservedStationLimitsKw(
      roots,
      'equal_share',
      new Map([['s1', 46]]),
      [{ stationId: 'S0', stationDbId: 's0', allocatedKw: 0, currentDrawKw: 0 }],
      ['s1'],
      new Map([['s0', 21]]),
    );
    expect(limits.get('s1')).toBeCloseTo(11, 6);
    // Without what s0 still enforces the retry took its whole maximum.
    expect(
      reservedStationLimitsKw(
        roots,
        'equal_share',
        new Map([['s1', 46]]),
        [{ stationId: 'S0', stationDbId: 's0', allocatedKw: 0, currentDrawKw: 0 }],
        ['s1'],
      ).get('s1'),
    ).toBeCloseTo(22, 6);
  });

  it('counts a reserved per-EVSE station by its W limit and checks the circuit per phase (3)', () => {
    // A reserved 1.6 W limit of 3 kW may sit on one phase; the DC station shares
    // the 20.4 kW circuit (6.8 kW a phase) and must leave that phase room.
    const reserved = station({ id: 's1', balancingMode: 'evse', sessions: [] });
    const dc = station({
      id: 's0',
      maxPowerKw: 50,
      rateUnit: 'A',
      sessions: [session({ kind: 'dc', ratingKw: 50, ratingA: null })],
    });
    // Limited per EVSE or not, a 1.6 W limit counts in full on every phase.
    expect(wattLimitPhaseLoad(reserved)).toEqual({ L1: 1, L2: 1, L3: 1 });
    const results = computeHierarchicalAllocation(
      tree([dc, reserved], { maxContinuousKw: 20.4 }),
      'equal_share',
      new Map([['s1', 3]]),
    );
    expect(kwOf(results, 's0')).toBeCloseTo(3 * (20.4 / 3 - 3), 3);
  });

  it('counts a station in the unit it is sent after a refusal or an accepted A limit (4)', () => {
    const s = station({ id: 's0', supportedRateUnits: [] });
    const previous = [
      { stationId: 'S0', stationDbId: 's0', allocatedKw: 4, rejectedUnits: ['W'] },
    ] as unknown as AppliedAllocation[];
    withSendRateUnits([s], previous);
    expect(s.rateUnit).toBe('A');
    // An A limit holds every phase: no W rule.
    expect(wattLimitPhaseLoad(s)).toBeNull();
    // A station that reports no unit but accepted an A limit stays on A limits
    // (unit rule 2026-11-24, second round), so it is never counted by the W rule.
    const accepted = station({ id: 's1', supportedRateUnits: [] });
    withSendRateUnits([accepted], [
      { stationId: 'S1', stationDbId: 's1', allocatedKw: 4, acceptedUnits: ['A'] },
    ] as unknown as AppliedAllocation[]);
    expect(accepted.rateUnit).toBe('A');
    const onlyW = station({ id: 's2', supportedRateUnits: [] });
    withSendRateUnits([onlyW], [
      { stationId: 'S2', stationDbId: 's2', allocatedKw: 4, acceptedUnits: ['W'] },
    ] as unknown as AppliedAllocation[]);
    expect(onlyW.rateUnit).toBe('W');
  });

  it('counts a per-EVSE station that shares its circuit by its W limit (5)', () => {
    // The per-phase split counts only a station alone on its circuit; here a
    // single-phase session on L1 may take the whole W limit on L1.
    const evse = station({
      id: 's0',
      balancingMode: 'evse',
      sessions: [session({ phases: 'L1', measuredPhases: 'L1' })],
    });
    const idle = station({ id: 's1', hasActiveSession: false, isOnline: false, sessions: [] });
    const results = computeHierarchicalAllocation(
      tree([evse, idle], {}, { perPhaseCapacityKw: 10 }),
      'equal_share',
      new Map([['s1', 0]]),
    );
    expect(kwOf(results, 's0')).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('counts the accepted limit of a station split per phase at its circuit share (6)', () => {
    // Split per phase only in A: the limit was sent at three times its busiest share.
    const split = station({
      id: 's0',
      rateUnit: 'A',
      balancingMode: 'evse',
      sessions: [session({ phases: 'L2', measuredPhases: 'L2' })],
    });
    const counted = { L1: 0, L2: 0, L3: 0 };
    fixedPhaseLoad(tree([split])[0] as HierarchyNode, new Map([['s0', 12]]), counted);
    expect(counted.L2).toBeCloseTo(4, 6);
    // The same station in W counts in full on every phase (never split).
    const watts = { L1: 0, L2: 0, L3: 0 };
    const w = { ...split, rateUnit: 'W' as const };
    fixedPhaseLoad(tree([w])[0] as HierarchyNode, new Map([['s0', 12]]), watts);
    expect(watts).toEqual({ L1: 12, L2: 12, L3: 12 });
  });

  it('counts a held W limit in full on every phase while an A cut is unconfirmed (seed 1, I1)', () => {
    // An A and W station holding an accepted 2 kW W limit is sent a 0 A cut:
    // until the station accepts it, the 2 kW may land in full on one phase.
    const held = station({ id: 's0', rateUnit: 'A', heldWattLimit: true, sessions: [session()] });
    const counted = { L1: 0, L2: 0, L3: 0 };
    fixedPhaseLoad(tree([held])[0] as HierarchyNode, new Map([['s0', 2]]), counted);
    expect(counted).toEqual({ L1: 2, L2: 2, L3: 2 });
    const settled = { L1: 0, L2: 0, L3: 0 };
    fixedPhaseLoad(
      tree([{ ...held, heldWattLimit: false }])[0] as HierarchyNode,
      new Map([['s0', 2]]),
      settled,
    );
    expect(settled.L1).toBeCloseTo(2 / 3, 6);
  });

  it('holds a station to a unit box its EVSEs could pass until its defaults hold it (7, I2)', () => {
    // Box u1 (32 A, 25.6 A continuous) holds EVSE 1 and 2, 32 A each; EVSE 3
    // charges outside it. Without accepted defaults a car that starts in the
    // box before the next cycle holds no limit: the station limit is held to 25.6 A.
    const rows = [
      {
        stationId: 's0',
        evseDbId: 'e1',
        evseNumber: 1,
        unitId: 'u1',
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: 32,
      },
      {
        stationId: 's0',
        evseDbId: 'e2',
        evseNumber: 2,
        unitId: 'u1',
        connectorType: 'Type2',
        maxPowerKw: '22',
      },
      {
        stationId: 's0',
        evseDbId: 'e3',
        evseNumber: 3,
        unitId: null,
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: 32,
      },
      {
        stationId: 's0',
        evseDbId: 'e4',
        evseNumber: 4,
        unitId: 'u2',
        connectorType: 'CCS2',
        maxPowerKw: '50',
      },
      {
        stationId: 's0',
        evseDbId: 'e5',
        evseNumber: 5,
        unitId: 'u3',
        connectorType: 'Type2',
        maxPowerKw: null,
      },
    ];
    // EVSE 2 rated in kW only counts its single-phase current; an unrated EVSE 32 A.
    const units = unitEvsesOf(rows).get('s0') ?? [];
    expect(units.map((e) => e.evseNumber)).toEqual([1, 2, 4, 5]);
    expect(units.find((e) => e.evseNumber === 2)?.ratingA).toBeCloseTo(22_000 / 230, 6);
    expect(units.find((e) => e.evseNumber === 4)?.kind).toBe('dc');
    expect(units.find((e) => e.evseNumber === 5)?.ratingA).toBe(32);
    const box = units.filter((e) => e.unitId === 'u1').map((e) => ({ ...e, ratingA: 32 }));
    const st = station({
      id: 's0',
      rateUnit: 'A',
      balancingMode: 'evse',
      unitBudgets: [{ unitId: 'u1', kind: 'ac', maxCurrentA: 32, phases: 3, maxPowerKw: null }],
      unitEvses: box,
      sessions: [],
    });
    const rate: { rateUnit: 'A' | 'W'; voltageV: number; phases: number; profileId: number } = {
      rateUnit: 'A',
      voltageV: 230,
      phases: 3,
      profileId: 1,
    };
    const plan = (s: StationPowerInfo, r = rate) =>
      unitBoxPlan(s, undefined, [], r, { sendDefaults: true });
    expect(plan(st).capKw).toBeCloseTo((32 * 0.8 * 230 * 3) / 1000, 6);
    // EVSEs that fit the box together need no cap.
    expect(plan({ ...st, unitEvses: box.map((e) => ({ ...e, ratingA: 12.8 })) }).capKw).toBeNull();
    // In W the box takes its single-phase worst case.
    expect(plan(st, { ...rate, rateUnit: 'W' as const }).capKw).toBeCloseTo(
      (32 * 0.8 * 230) / 1000,
      6,
    );
    // A station limited as a whole is held to the box too: it gets no defaults.
    const whole = plan({ ...st, balancingMode: 'station' });
    expect(whole.defaults).toEqual([]);
    expect(whole.capKw).toBeCloseTo((32 * 0.8 * 230 * 3) / 1000, 6);
  });

  it('does not pause a station on an empty circuit for its free EVSEs (review item 1)', () => {
    // 2.x W station, one three-phase car, free EVSEs, alone on a 40 A
    // three-phase circuit (7.36 kW a phase). Its W limit counts in full on every
    // phase, which covers a car that starts on a free EVSE, so it gets the
    // phase capacity and is never paused for them.
    const lone = station({
      id: 's0',
      maxPowerKw: 44,
      sessions: [session({ ratingA: 32, ratingKw: 22 })],
    });
    const capacity = (40 * 230 * 3 * 0.8) / 1000;
    const results = computeHierarchicalAllocation(
      tree([lone], { maxContinuousKw: capacity }),
      'equal_share',
    );
    expect(kwOf(results, 's0')).toBeCloseTo(capacity / 3, 3);
  });

  it('counts a reserved W station in full on every phase, an allocated one not at all (8)', () => {
    // fixedPhaseLoad counts the stations of its map: the reserved W station in
    // full on every phase; the allocated station adds nothing here (the phase
    // reductions count it from its allocation).
    const reserved = station({ id: 's1', sessions: [session()] });
    const allocated = station({ id: 's0', sessions: [session()] });
    const into = { L1: 0, L2: 0, L3: 0 };
    fixedPhaseLoad(tree([allocated, reserved])[0] as HierarchyNode, new Map([['s1', 10]]), into);
    expect(into).toEqual({ L1: 10, L2: 10, L3: 10 });
  });
});
