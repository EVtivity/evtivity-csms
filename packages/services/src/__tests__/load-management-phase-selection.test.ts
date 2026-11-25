// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Phase selection for single-phase cars (OCPP 2.x K01.FR.19, K01.FR.20,
// K01.FR.46) and single-phase chargers counted on their own phase.

import { describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import type {
  AllocationResult,
  EvseSessionInfo,
  HierarchyNode,
  StationPowerInfo,
} from '../load-management-model.js';
import { computeEvseLimits } from '../evse-limits.js';
import {
  appliedEvseLimit,
  buildEvseLimitProfile,
  parseAppliedEvseLimits,
} from '../evse-limit-profiles.js';

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const fake: FakeDb = createFakeDb();
  return fakeDatabaseModule(fake, { isOperatorStation: () => 'OPERATOR_STATION' });
});

const { selectSessionPhases, PHASE_TO_USE_SETTLE_MS, siteEvseLimits } =
  await import('../load-management-phase-selection.js');
const {
  emptyPhaseCapabilities,
  readPhaseCapability,
  phaseSwitchingSupported,
  stationSupplyPhases,
  stationSinglePhase,
  stationsWithAcEvse,
} = await import('../load-management-site-status.js');
const {
  singlePhaseChargerLoad,
  computeHierarchicalAllocation,
  wattLimitPhaseLoad,
  stationSplitWeights,
  fixedPhaseLoad,
  stationMinKw,
  stationStopKw,
  reduceAllocations,
} = await import('../load-management-allocation.js');
const { withPhaseWeights } = await import('../load-management-site-allocation.js');

const NOW = Date.parse('2026-11-24T10:00:00Z');

function session(overrides: Partial<EvseSessionInfo> = {}): EvseSessionInfo {
  return {
    sessionId: 'ses_1',
    transactionId: 'tx-1',
    evseDbId: 'evs_1',
    evseNumber: 1,
    unitId: null,
    kind: 'ac',
    ratingKw: 22,
    ratingA: 32,
    tariffId: null,
    tariffMaxCurrentA: null,
    phases: 'L1',
    startedAt: new Date('2026-11-24T09:00:00Z'),
    measuredPhases: 'L1',
    rotation: 'RST',
    phaseSwitching: true,
    drawKw: 3,
    ...overrides,
  };
}

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
    balancingMode: 'evse',
    ...overrides,
  };
}

function node(overrides: Partial<HierarchyNode> & { type: HierarchyNode['type'] }): HierarchyNode {
  return {
    id: overrides.type === 'circuit' ? 'cir_a' : 'pnl_a',
    name: 'node',
    maxContinuousKw: 100,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations: [],
    children: [],
    phases: 3,
    breakerRatingAmps: 100,
    voltageV: 230,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    ...overrides,
  };
}

function site(st: StationPowerInfo, phaseLoad = { L1: 8, L2: 2, L3: 5 }): HierarchyNode {
  const circuit = node({ type: 'circuit', phaseConnections: 'L1L2L3', stations: [st] });
  return node({ type: 'panel', perPhaseCapacityKw: 10, phaseLoad, children: [circuit] });
}

function select(st: StationPowerInfo, phaseLoad?: { L1: number; L2: number; L3: number }) {
  selectSessionPhases([site(st, phaseLoad)], NOW);
  return st.sessions?.[0];
}

const cap = (
  rows: Array<{ component: string; evseId: number | null; variable: string; value: string }>,
) => {
  const caps = emptyPhaseCapabilities();
  for (const row of rows) readPhaseCapability(caps, row);
  return caps;
};

describe('phase capabilities from the 2.x device model', () => {
  it('reads ACPhaseSwitchingSupported per EVSE, true only when defined and true', () => {
    const caps = cap([
      {
        component: 'SmartChargingCtrlr',
        evseId: 1,
        variable: 'ACPhaseSwitchingSupported',
        value: 'true',
      },
      {
        component: 'SmartChargingCtrlr',
        evseId: 2,
        variable: 'ACPhaseSwitchingSupported',
        value: 'false',
      },
    ]);
    expect(phaseSwitchingSupported(caps, 1)).toBe(true);
    expect(phaseSwitchingSupported(caps, 2)).toBe(false);
    expect(phaseSwitchingSupported(caps, 3)).toBe(false);
  });

  it('applies a station value to EVSEs without their own, and ignores another component', () => {
    const caps = cap([
      {
        component: 'SmartChargingCtrlr',
        evseId: null,
        variable: 'ACPhaseSwitchingSupported',
        value: 'True',
      },
      {
        component: 'SmartChargingCtrlr',
        evseId: 2,
        variable: 'ACPhaseSwitchingSupported',
        value: 'false',
      },
      { component: 'EVSE', evseId: 3, variable: 'ACPhaseSwitchingSupported', value: 'true' },
    ]);
    expect(phaseSwitchingSupported(caps, 1)).toBe(true);
    expect(phaseSwitchingSupported(caps, 2)).toBe(false);
    expect(
      cap([{ component: 'EVSE', evseId: 3, variable: 'ACPhaseSwitchingSupported', value: 'true' }])
        .phaseSwitching.size,
    ).toBe(0);
  });

  it('reads SupplyPhases of the station, else the one value every EVSE reports', () => {
    expect(
      stationSupplyPhases(
        cap([{ component: 'ChargingStation', evseId: null, variable: 'SupplyPhases', value: '1' }]),
        [1, 2],
      ),
    ).toBe(1);
    const evses = [
      { component: 'EVSE', evseId: 1, variable: 'SupplyPhases', value: '1' },
      { component: 'EVSE', evseId: 2, variable: 'SupplyPhases', value: '1' },
    ];
    expect(stationSupplyPhases(cap(evses), [1, 2])).toBe(1);
    expect(stationSupplyPhases(cap([evses[0]!, { ...evses[1]!, value: '3' }]), [1, 2])).toBeNull();
    expect(stationSupplyPhases(cap([evses[0]!]), [1, 2])).toBeNull();
    expect(stationSupplyPhases(cap([{ ...evses[0]!, value: '0' }]), [1])).toBeNull();
  });

  it('reads Connector SupplyPhases for its EVSE, the shape the simulator reports', () => {
    const connector = { component: 'Connector', evseId: 1, variable: 'SupplyPhases', value: '1' };
    expect(stationSupplyPhases(cap([connector]), [1])).toBe(1);
    // Two connectors that disagree say nothing; the EVSE's own value wins.
    expect(stationSupplyPhases(cap([connector, { ...connector, value: '3' }]), [1])).toBeNull();
    expect(
      stationSupplyPhases(
        cap([connector, { component: 'EVSE', evseId: 1, variable: 'SupplyPhases', value: '3' }]),
        [1],
      ),
    ).toBe(3);
    expect(stationSupplyPhases(cap([{ ...connector, evseId: null }]), [1])).toBeNull();
  });

  it('reads the phase a single-phase charger is wired to from its PhaseRotation', () => {
    const caps = cap([
      { component: 'ChargingStation', evseId: null, variable: 'PhaseRotation', value: 'Sxx' },
    ]);
    expect(stationSinglePhase(caps, [1])).toBe('L2');
    expect(stationSinglePhase(cap([]), [1])).toBeNull();
  });
});

describe('selectSessionPhases', () => {
  it('sends a single-phase car to the panel phase with the most headroom', () => {
    // Headroom: L1 10 - 8 + 3 (its own draw) = 5, L2 8, L3 5.
    const s = select(station({ id: 'a', sessions: [session()] }));
    expect(s).toMatchObject({ phases: 'L2', phaseToUse: 2, phaseToUseSinceMs: NOW });
  });

  it("takes the car's own draw off the phase it is on now", () => {
    // L1 10 - 8 + 6 = 8 beats L2 and L3 at 4, so the car stays where it is.
    const s = select(station({ id: 'a', sessions: [session({ drawKw: 6 })] }), {
      L1: 8,
      L2: 6,
      L3: 6,
    });
    expect(s).toMatchObject({ phases: 'L1', phaseToUse: 1 });
  });

  it('names the EVSE phase wired to the chosen panel phase', () => {
    // RTS: EVSE phase 3 is panel L2.
    const s = select(station({ id: 'a', sessions: [session({ rotation: 'RTS' })] }));
    expect(s).toMatchObject({ phases: 'L2', phaseToUse: 3 });
  });

  it('keeps an earlier choice unless another phase is clearly better', () => {
    const since = NOW - 30_000;
    const held = session({ phaseToUse: 3, phaseToUseSinceMs: since });
    // L2 6, L3 5: 1 kW better is under the 1.5 kW margin.
    const kept = select(station({ id: 'a', sessions: [held] }), { L1: 8, L2: 4, L3: 5 });
    expect(kept).toMatchObject({ phases: 'L3', phaseToUse: 3, phaseToUseSinceMs: since });
    // L2 8, L3 5: 3 kW better moves it, and the settle time starts again.
    const moved = select(
      station({ id: 'b', sessions: [session({ phaseToUse: 3, phaseToUseSinceMs: since })] }),
    );
    expect(moved).toMatchObject({ phases: 'L2', phaseToUse: 2, phaseToUseSinceMs: NOW });
  });

  it('falls back to the measured phase when the car did not move after the settle time', () => {
    const late = session({ phaseToUse: 2, phaseToUseSinceMs: NOW - PHASE_TO_USE_SETTLE_MS });
    expect(select(station({ id: 'a', sessions: [late] }))).toMatchObject({
      phases: 'L1',
      phaseToUse: null,
      phaseToUseRefused: true,
    });
    const followed = session({
      phaseToUse: 2,
      phaseToUseSinceMs: NOW - 120_000,
      measuredPhases: 'L2',
    });
    expect(select(station({ id: 'b', sessions: [followed] }))).toMatchObject({ phaseToUse: 2 });
    const refused = session({ phaseToUseRefused: true });
    expect(select(station({ id: 'c', sessions: [refused] }))).toMatchObject({
      phases: 'L1',
      phaseToUse: null,
    });
  });

  it('chooses nothing without phase switching, a rotation, one measured phase, AC, EVSE mode or a connection', () => {
    const cases: StationPowerInfo[] = [
      station({ id: 'a', sessions: [session({ phaseSwitching: false })] }),
      station({ id: 'b', sessions: [session({ rotation: null })] }),
      station({ id: 'c', sessions: [session({ measuredPhases: 'L1L2L3', phases: 'L1L2L3' })] }),
      station({ id: 'd', sessions: [session({ kind: 'dc' })] }),
      station({ id: 'e', balancingMode: 'station', sessions: [session()] }),
      station({ id: 'f', isOnline: false, sessions: [session()] }),
      station({ id: 'g', singlePhaseOnThreePhase: true, circuitPhases: 1, sessions: [session()] }),
    ];
    for (const st of cases) {
      const s = select(st);
      expect(s?.phaseToUse ?? null, st.id).toBeNull();
      expect(s?.phases, st.id).not.toBe('L2');
    }
  });

  it('chooses nothing on a single-phase circuit', () => {
    const st = station({ id: 'a', circuitPhases: 1, sessions: [session()] });
    const circuit = node({ type: 'circuit', phases: 1, phaseConnections: 'L1', stations: [st] });
    selectSessionPhases(
      [
        node({
          type: 'panel',
          perPhaseCapacityKw: 10,
          phaseLoad: { L1: 8, L2: 2, L3: 5 },
          children: [circuit],
        }),
      ],
      NOW,
    );
    expect(st.sessions?.[0]?.phaseToUse ?? null).toBeNull();
  });
});

describe('phaseToUse in the EVSE limit and its profile', () => {
  it('keeps phaseToUse only for a single-phase session (K01.FR.19)', () => {
    const one = station({
      id: 'a',
      rateUnit: 'A',
      sessions: [session({ phaseToUse: 2, phaseToUseSinceMs: NOW })],
    });
    const [limit] = computeEvseLimits(one, 7, { rateUnit: 'A', voltageV: 230, phases: 3 });
    expect(limit).toMatchObject({ phases: 1, phaseToUse: 2, phaseToUseSinceMs: NOW });
    const three = station({
      id: 'b',
      rateUnit: 'A',
      sessions: [session({ phases: 'L1L2L3', phaseToUse: 2 })],
    });
    expect(
      computeEvseLimits(three, 7, { rateUnit: 'A', voltageV: 230, phases: 3 })[0],
    ).not.toHaveProperty('phaseToUse');
  });

  it('sends phaseToUse with numberPhases 1 on an AC period only', () => {
    const base = {
      sessionId: 'ses_1',
      transactionId: 'tx-1',
      evseNumber: 1,
      unitId: null,
      kind: 'ac' as const,
      limitA: 16,
      limitKw: 3.68,
      phases: 1,
      reason: 'circuit_limit' as const,
      paused: false,
      phaseToUse: 2,
    };
    const period = (l: typeof base | (typeof base & { phases: number })) =>
      (
        (
          buildEvseLimitProfile('CS-1', l, 'A', new Date(NOW))['chargingProfile'] as Record<
            string,
            unknown
          >
        )['chargingSchedule'] as Array<{ chargingSchedulePeriod: Array<Record<string, unknown>> }>
      )[0]!.chargingSchedulePeriod[0];
    expect(period(base)).toEqual({ startPeriod: 0, limit: 16, numberPhases: 1, phaseToUse: 2 });
    expect(period({ ...base, phases: 3 })).not.toHaveProperty('phaseToUse');
    expect(period({ ...base, phaseToUse: null } as never)).not.toHaveProperty('phaseToUse');
  });

  it('stores the choice in the applied limit and reads it back', () => {
    const stored = appliedEvseLimit(
      {
        sessionId: 'ses_1',
        transactionId: 'tx-1',
        evseNumber: 1,
        unitId: null,
        kind: 'ac',
        limitA: 16,
        limitKw: 3.68,
        phases: 1,
        reason: 'circuit_limit',
        paused: false,
        phaseToUse: 3,
        phaseToUseSinceMs: NOW,
      },
      'A',
    );
    expect(stored).toMatchObject({ phaseToUse: 3, phaseToUseSinceMs: NOW });
    expect(parseAppliedEvseLimits([stored])[0]).toMatchObject({
      phaseToUse: 3,
      phaseToUseSinceMs: NOW,
    });
    expect(parseAppliedEvseLimits([{ ...stored, phaseToUse: 4 }])[0]).not.toHaveProperty(
      'phaseToUse',
    );
    expect(
      parseAppliedEvseLimits([{ ...stored, phaseToUseRefused: true }])[0]?.phaseToUseRefused,
    ).toBe(true);
  });
});

describe('single-phase chargers on a three-phase circuit', () => {
  it('loads its own phase in full, every phase when the phase is not known', () => {
    expect(singlePhaseChargerLoad(station({ id: 'a' }))).toBeNull();
    expect(singlePhaseChargerLoad(station({ id: 'a', singlePhaseOnThreePhase: true }))).toEqual({
      L1: 1,
      L2: 1,
      L3: 1,
    });
    expect(
      singlePhaseChargerLoad(
        station({ id: 'a', singlePhaseOnThreePhase: true, supplyPanelPhase: 'L2' }),
      ),
    ).toEqual({ L1: 0, L2: 1, L3: 0 });
  });

  const singlePhase = (id: string, rateUnit: 'W' | 'A', phase: 'L1' | 'L2' | 'L3' | null) =>
    station({
      id,
      rateUnit,
      maxPowerKw: 7.4,
      circuitPhases: 1,
      singlePhaseOnThreePhase: true,
      supplyPanelPhase: phase,
      balancingMode: 'station',
    });

  for (const unit of ['W', 'A'] as const) {
    it(`holds a ${unit}-only charger to its phase share of the circuit`, () => {
      // 12 kW circuit: 4 kW a phase. P / 3 would let the 7.4 kW charger keep 7.4 kW.
      const st = singlePhase('a', unit, 'L1');
      const circuit = node({
        type: 'circuit',
        maxContinuousKw: 12,
        phaseConnections: 'L1L2L3',
        stations: [st],
      });
      const [result] = computeHierarchicalAllocation(
        [node({ type: 'panel', maxContinuousKw: 500, children: [circuit] })],
        'equal_share',
      );
      expect(result?.allocatedKw).toBeCloseTo(4, 6);
      expect(result?.limitedBy).toBe('circuit_limit');
    });
  }

  it('counts it in full on its panel phase, so two chargers on one phase share it', () => {
    const a = singlePhase('a', 'W', 'L1');
    const b = singlePhase('b', 'W', 'L1');
    const c = singlePhase('c', 'W', 'L2');
    const circuit = node({
      type: 'circuit',
      maxContinuousKw: 300,
      phaseConnections: 'L1L2L3',
      stations: [a, b, c],
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 300,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });
    const result = new Map(
      computeHierarchicalAllocation([panel], 'equal_share').map((r) => [
        r.stationDbId,
        r.allocatedKw,
      ]),
    );
    // L1 holds 10 kW for two 7.4 kW chargers; L2 has room for its one.
    expect((result.get('a') ?? 0) + (result.get('b') ?? 0)).toBeLessThanOrEqual(10 + 1e-6);
    expect(result.get('c')).toBeCloseTo(7.4, 6);
  });

  it('counts an unknown phase on every phase', () => {
    const a = singlePhase('a', 'W', null);
    const b = singlePhase('b', 'W', 'L3');
    const circuit = node({
      type: 'circuit',
      maxContinuousKw: 300,
      phaseConnections: 'L1L2L3',
      stations: [a, b],
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 300,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });
    const result = new Map(
      computeHierarchicalAllocation([panel], 'equal_share').map((r) => [
        r.stationDbId,
        r.allocatedKw,
      ]),
    );
    expect((result.get('a') ?? 0) + (result.get('b') ?? 0)).toBeLessThanOrEqual(10 + 1e-6);
  });
});

describe('a car that has not moved to its chosen phase (review H2)', () => {
  it('keeps the measured phase as pending until the car follows the choice', () => {
    expect(select(station({ id: 'a', sessions: [session()] }))).toMatchObject({
      phases: 'L2',
      phaseToUse: 2,
      pendingPhases: 'L1',
    });
    const followed = session({
      phaseToUse: 2,
      phaseToUseSinceMs: NOW - 10_000,
      measuredPhases: 'L2',
    });
    expect(select(station({ id: 'b', sessions: [followed] }))).toMatchObject({
      phases: 'L2',
      pendingPhases: null,
    });
  });

  it('counts the car on both phases, so the EVSE limits fit what the tree counts', () => {
    // EVSE 1 was sent L2 but still charges on L1, next to EVSE 2 on L1.
    const moving = session({
      phases: 'L2',
      pendingPhases: 'L1',
      phaseToUse: 2,
      phaseToUseSinceMs: NOW,
    });
    const staying = session({
      sessionId: 'ses_2',
      transactionId: 'tx-2',
      evseDbId: 'evs_2',
      evseNumber: 2,
      phases: 'L1',
    });
    const st = station({ id: 'a', rateUnit: 'A', maxPowerKw: 44, sessions: [moving, staying] });
    const circuit = node({ type: 'circuit', phaseConnections: 'L1L2L3', stations: [st] });
    const [weighted] = withPhaseWeights(
      [{ stationId: 'A', stationDbId: 'a', allocatedKw: 22, currentDrawKw: 0 }],
      [node({ type: 'panel', children: [circuit] })],
    );
    const weights = weighted?.phaseWeights ?? { L1: 1 / 3, L2: 1 / 3, L3: 1 / 3 };
    const rates = new Map([
      ['a', { rateUnit: 'A' as const, voltageV: 230, phases: 3, profileId: 1 }],
    ]);
    const limits =
      siteEvseLimits([st], weighted != null ? [weighted] : [], rates, 'equal_share').get('a') ?? [];
    // Both cars draw on L1 now: within the busiest share the tree counts on every phase.
    const l1Amps = limits.reduce((sum, l) => sum + (l.limitA ?? 0), 0);
    const countedAmps = (22_000 * Math.max(weights.L1, weights.L2, weights.L3)) / 230;
    expect(limits).toHaveLength(2);
    expect(l1Amps).toBeLessThanOrEqual(countedAmps + 1e-6);
    const sent = limits.find((l) => l.sessionId === 'ses_1');
    expect(sent).toMatchObject({ phases: 1, phaseToUse: 2 });
    expect(sent?.limitKw).toBeCloseTo(((sent?.limitA ?? 0) * 230) / 1000, 6);
  });
});

describe('W station limits on three-phase circuits (owner decision 2026-11-24)', () => {
  const wStation = (
    overrides: Partial<StationPowerInfo> = {},
    car: Partial<EvseSessionInfo> = {},
  ): StationPowerInfo =>
    station({
      id: 'w',
      rateUnit: 'W',
      balancingMode: 'station',
      sessions: [session({ phaseSwitching: false, ...car })],
      ...overrides,
    });
  // A 22.08 kW three-phase circuit under a panel of 10 kW a phase; an
  // unmanaged load can take L2.
  function allocate(st: StationPowerInfo, l2LoadKw = 0): number {
    const circuit = node({
      type: 'circuit',
      id: 'cir_w',
      maxContinuousKw: 22.08,
      phaseConnections: 'L1L2L3',
      stations: [st],
    });
    const l2 = node({
      type: 'circuit',
      id: 'cir_l2',
      maxContinuousKw: 50,
      phaseConnections: 'L2',
      unmanagedLoadKw: l2LoadKw,
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 300,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit, l2],
    });
    return (
      computeHierarchicalAllocation([panel], 'equal_share').find((a) => a.stationDbId === 'w')
        ?.allocatedKw ?? 0
    );
  }

  // The W rule (owner decision 2026-11-24, second round): only W-only stations
  // get W, and a W limit counts in full on every phase whatever the car, since
  // it bounds the total only (the earlier per-car phase marking, a third on the
  // phases of a known single-phase car, left a car that starts on a free EVSE
  // uncounted). The tests of that marking are replaced by these.
  it('counts a W limit in full on every phase, whatever car charges', () => {
    for (const st of [
      wStation(),
      wStation({}, { rotation: null }),
      wStation({}, { measuredPhases: 'L1L2', phases: 'L1L2' }),
      wStation({}, { measuredPhases: 'L1L2L3', phases: 'L1L2L3' }),
      wStation({ balancingMode: 'evse' }),
    ]) {
      expect(wattLimitPhaseLoad(st)).toEqual({ L1: 1, L2: 1, L3: 1 });
    }
    // All of it may go on one phase: the circuit breaker per phase holds it.
    expect(allocate(wStation())).toBeCloseTo(22.08 / 3, 6);
    expect(allocate(wStation({}, { measuredPhases: 'L1L2L3', phases: 'L1L2L3' }))).toBeCloseTo(
      22.08 / 3,
      6,
    );
    // An 8 kW load on L2 leaves that phase 2 kW, which binds the whole W limit.
    expect(allocate(wStation(), 8)).toBeCloseTo(2, 6);
  });

  it('never splits a W station per phase: its limit counts in full anyway', () => {
    const sessions = [
      session({ phases: 'L1', measuredPhases: 'L1' }),
      session({
        sessionId: 'ses_2',
        transactionId: 'tx-2',
        evseDbId: 'evs_2',
        evseNumber: 2,
        phases: 'L2',
        measuredPhases: 'L2',
      }),
    ];
    const split = station({ id: 'a', rateUnit: 'A', sessions });
    const circuit = node({
      type: 'circuit',
      id: 'cir_split',
      maxContinuousKw: 22.08,
      phaseConnections: 'L1L2L3',
      stations: [split],
    });
    expect(stationSplitWeights(circuit, split)).not.toBeNull();
    expect(stationSplitWeights(circuit, { ...split, rateUnit: 'W' })).toBeNull();
  });

  it('chooses no phase for a station limited as a whole, so its W load has no pending phase (third review 8)', () => {
    const st = wStation({ isOnline: true });
    const circuit = node({
      type: 'circuit',
      id: 'cir_w',
      maxContinuousKw: 22.08,
      phaseConnections: 'L1L2L3',
      stations: [st],
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 300,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 9, L2: 0, L3: 0 },
      children: [circuit],
    });
    const before = st.sessions;
    selectSessionPhases([panel], Date.now());
    expect(st.sessions).toBe(before);
    expect(st.sessions?.every((s) => s.pendingPhases == null && s.phaseToUse == null)).toBe(true);
  });

  it('counts the start allowance of an idle W station in full on every phase (third review 4)', () => {
    const idle = wStation({ hasActiveSession: false, sessions: [] });
    expect(wattLimitPhaseLoad(idle)).toEqual({ L1: 1, L2: 1, L3: 1 });
    const bare = wStation({ hasActiveSession: false });
    delete bare.sessions;
    expect(wattLimitPhaseLoad(bare)).toEqual({ L1: 1, L2: 1, L3: 1 });
    // Its 6 kW allowance, reserved, on a panel whose L1 already carries 8 kW of a
    // single-phase load: L1 holds 10 kW, so only 2 kW of it fits there.
    const circuit = node({
      type: 'circuit',
      id: 'cir_w',
      maxContinuousKw: 22.08,
      phaseConnections: 'L1L2L3',
      stations: [idle],
    });
    const l1 = node({
      type: 'circuit',
      id: 'cir_l1',
      maxContinuousKw: 50,
      phaseConnections: 'L1',
      unmanagedLoadKw: 8,
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 300,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit, l1],
    });
    const into = { L1: 0, L2: 0, L3: 0 };
    fixedPhaseLoad(panel, new Map([['w', 6]]), into);
    expect(into.L1).toBeCloseTo(14, 6);
    expect(into.L2).toBeCloseTo(6, 6);
    // An A limit holds each phase: it keeps the third.
    expect(wattLimitPhaseLoad({ ...idle, rateUnit: 'A' })).toBeNull();
  });

  it('keeps a third for A limits', () => {
    expect(wattLimitPhaseLoad(wStation({ rateUnit: 'A' }))).toBeNull();
    expect(wattLimitPhaseLoad(wStation({ circuitPhases: 1 }))).toBeNull();
    expect(allocate(wStation({ rateUnit: 'A' }))).toBeCloseTo(22, 6);
  });
});

describe('phase cuts in phase terms (review C3 integration finding)', () => {
  const threePhase = (id: string, overrides: Partial<StationPowerInfo>): StationPowerInfo =>
    station({ id, circuitId: 'cir_3', balancingMode: 'station', ...overrides });

  it('keeps every minimum when the minimums fit the phase, whatever share each station loads it with', () => {
    // Two three-phase A stations spread their limits (a third on L1), a W
    // station with an AC EVSE counts in full on L1, a single-phase station on
    // L1 in full: 1.38 kW each on L1, 5.52 kW, inside the 5.67 kW the panel
    // phase carries, though the minimums add up to 11.04 kW as stations.
    const spread = threePhase('a', {
      rateUnit: 'A',
      sessions: [session({ evseNumber: 1, phases: 'L1L2L3', phaseSwitching: false })],
    });
    const spread2 = threePhase('b', {
      rateUnit: 'A',
      sessions: [session({ evseNumber: 1, phases: 'L1L2L3', phaseSwitching: false })],
    });
    const watts = threePhase('w', {
      rateUnit: 'W',
      sessions: [session({ evseNumber: 1, phases: 'L1', phaseSwitching: false })],
    });
    const single = station({
      id: 's',
      circuitId: 'cir_1',
      circuitPhases: 1,
      rateUnit: 'A',
      balancingMode: 'station',
      sessions: [session({ evseNumber: 1, phases: 'L1', phaseSwitching: false })],
    });
    const panel = node({
      type: 'panel',
      maxContinuousKw: 100,
      perPhaseCapacityKw: 5.67,
      children: [
        node({
          type: 'circuit',
          id: 'cir_3',
          phaseConnections: 'L1L2L3',
          stations: [spread, spread2, watts],
        }),
        node({
          type: 'circuit',
          id: 'cir_1',
          phaseConnections: 'L1',
          phases: 1,
          stations: [single],
        }),
      ],
    });
    const result = computeHierarchicalAllocation([panel], 'equal_share');
    const byId = new Map(result.map((r) => [r.stationDbId, r]));
    for (const st of [spread, spread2, watts, single]) {
      expect(byId.get(st.id)?.limitedBy, st.id).not.toBe('min_power_stop');
      expect(byId.get(st.id)?.allocatedKw ?? 0, st.id).toBeGreaterThanOrEqual(
        stationMinKw(st) - 1e-6,
      );
    }
    const l1 =
      (byId.get('a')?.allocatedKw ?? 0) / 3 +
      (byId.get('b')?.allocatedKw ?? 0) / 3 +
      (byId.get('w')?.allocatedKw ?? 0) +
      (byId.get('s')?.allocatedKw ?? 0);
    expect(l1).toBeLessThanOrEqual(5.67 + 1e-6);
  });

  it('counts the W limit of a DC-only station evenly, an AC one in full', () => {
    const dc = station({ id: 'd', rateUnit: 'W', balancingMode: 'station', hasAcEvse: false });
    expect(wattLimitPhaseLoad(dc)).toBeNull();
    expect(wattLimitPhaseLoad({ ...dc, hasAcEvse: true })).toEqual({ L1: 1, L2: 1, L3: 1 });
    const unknown = { ...dc };
    delete unknown.hasAcEvse;
    expect(wattLimitPhaseLoad(unknown)).toEqual({ L1: 1, L2: 1, L3: 1 });
    // An EVSE without a typed connector, or one with an AC connector, is AC.
    const rows = [
      { stationId: 'dc', evseDbId: 'e1', connectorType: 'CCS2', maxPowerKw: '150' },
      { stationId: 'mixed', evseDbId: 'e2', connectorType: 'CCS2', maxPowerKw: '50' },
      { stationId: 'mixed', evseDbId: 'e2', connectorType: 'Type2', maxPowerKw: '22' },
      { stationId: 'untyped', evseDbId: 'e3', connectorType: null, maxPowerKw: null },
    ];
    expect([...stationsWithAcEvse(rows)].sort()).toEqual(['mixed', 'untyped']);
  });

  it('keeps every session floor while it fits, stops a station limited per EVSE only below one', () => {
    const sessions = [1, 2].map((n) =>
      session({ evseNumber: n, phases: 'L1L2L3', phaseSwitching: false }),
    );
    const perEvse = station({ id: 'e', rateUnit: 'A', balancingMode: 'evse', sessions });
    const whole = { ...perEvse, balancingMode: 'station' as const };
    // 6 A on three phases: 4.14 kW a session.
    expect(stationMinKw(perEvse)).toBeCloseTo(8.28, 6);
    expect(stationStopKw(perEvse)).toBeCloseTo(4.14, 6);
    expect(stationMinKw(whole)).toBeCloseTo(8.28, 6);
    expect(stationStopKw(whole)).toBeCloseTo(8.28, 6);
    // A cut takes another station's surplus before a session floor.
    const other = station({
      id: 'o',
      rateUnit: 'A',
      balancingMode: 'station',
      minPowerKw: 0,
      sessions: [session({ evseNumber: 1, phases: 'L1L2L3', phaseSwitching: false })],
    });
    const entries = [
      {
        station: perEvse,
        alloc: {
          stationId: 'E',
          stationDbId: 'e',
          allocatedKw: 10,
          currentDrawKw: 0,
        } as AllocationResult,
      },
      {
        station: other,
        alloc: {
          stationId: 'O',
          stationDbId: 'o',
          allocatedKw: 10,
          currentDrawKw: 0,
        } as AllocationResult,
      },
    ];
    reduceAllocations(entries, 13);
    expect(entries[0]!.alloc.allocatedKw).toBeGreaterThanOrEqual(8.28 - 1e-6);
    expect(entries[1]!.alloc.allocatedKw).toBeCloseTo(13 - entries[0]!.alloc.allocatedKw, 6);
    // Floors that do not fit: the per-EVSE station runs between its stop floor and its minimum.
    const tight = [
      {
        station: perEvse,
        alloc: {
          stationId: 'E',
          stationDbId: 'e',
          allocatedKw: 10,
          currentDrawKw: 0,
        } as AllocationResult,
      },
    ];
    reduceAllocations(tight, 6);
    expect(tight[0]!.alloc.allocatedKw).toBeCloseTo(6, 6);
    expect(tight[0]!.alloc.limitedBy).not.toBe('min_power_stop');
  });

  it('scales an own minimum by what reaches cars that may share a phase', () => {
    const cars = (measured: string[]) =>
      station({
        id: 'x',
        rateUnit: 'A',
        balancingMode: 'station',
        minPowerKw: 6,
        sessions: measured.map((m, i) =>
          session({ evseNumber: i + 1, phases: null, measuredPhases: m, phaseSwitching: false }),
        ),
      });
    // Two one-phase cars of unknown wiring may share one phase: a third of the limit reaches them.
    expect(stationMinKw(cars(['L1', 'L1']))).toBeCloseTo(18, 6);
    // A one-phase car beside a three-phase one: half of the shared phase each, two thirds in all.
    expect(stationMinKw(cars(['L1', 'L1L2L3']))).toBeCloseTo(9, 6);
  });

  it('raises a split station floor until each phase share holds its sessions 6 A (review I3 M1)', () => {
    const split = station({
      id: 'sp',
      rateUnit: 'A',
      balancingMode: 'evse',
      minPowerKw: 0,
      phaseSplit: true,
      sessions: [
        session({
          evseNumber: 1,
          phases: 'L1',
          measuredPhases: 'L1',
          ratingA: 32,
          phaseSwitching: false,
        }),
        session({
          evseNumber: 2,
          phases: 'L2',
          measuredPhases: 'L2',
          ratingA: 32,
          tariffMaxCurrentA: 10,
          phaseSwitching: false,
        }),
      ],
    });
    // Weights by demand: L1 32/42, L2 10/42. L2 needs 6 A of its share: 1.38 kW / (10/42).
    const min = stationMinKw(split);
    expect(min).toBeCloseTo((6 * 230 * 42) / (10 * 1000), 6);
    expect((min * (10 / 42) * 1000) / 230).toBeGreaterThanOrEqual(6 - 1e-6);
  });

  it('stops no station with no floor to fit the others (review I3 L1)', () => {
    const high = station({
      id: 'h',
      rateUnit: 'A',
      balancingMode: 'station',
      loadPriority: 9,
      minPowerKw: 5,
      sessions: [session({ evseNumber: 1, phases: 'L1L2L3', phaseSwitching: false })],
    });
    const low = station({
      id: 'l',
      rateUnit: 'A',
      balancingMode: 'station',
      loadPriority: 1,
      minPowerKw: 0,
      sessions: [session({ evseNumber: 1, kind: 'dc', phases: null, measuredPhases: null })],
    });
    const entries = [
      {
        station: high,
        alloc: {
          stationId: 'H',
          stationDbId: 'h',
          allocatedKw: 6,
          currentDrawKw: 0,
        } as AllocationResult,
      },
      {
        station: low,
        alloc: {
          stationId: 'L',
          stationDbId: 'l',
          allocatedKw: 2,
          currentDrawKw: 0,
        } as AllocationResult,
      },
    ];
    reduceAllocations(entries, 4);
    // The high one cannot keep its 5 kW and stops; the DC one keeps its 2 kW.
    expect(entries[0]!.alloc.allocatedKw).toBe(0);
    expect(entries[1]!.alloc.allocatedKw).toBeCloseTo(2, 6);
  });

  it('counts a DC session in the floor of a station that shares one limit', () => {
    const mixed = station({
      id: 'm',
      rateUnit: 'W',
      balancingMode: 'station',
      minPowerKw: 0,
      sessions: [
        session({ evseNumber: 1, kind: 'dc', phases: null, measuredPhases: null }),
        session({ evseNumber: 2, phases: 'L1', measuredPhases: 'L1', phaseSwitching: false }),
      ],
    });
    // 6 A for the AC car on its phase, and 6 A on three phases for the DC session.
    expect(stationMinKw(mixed)).toBeCloseTo(1.38 + 4.14, 6);
  });

  it('holds a station split onto its car phase at its own minimum, not three times it', () => {
    const alone = station({
      id: 'a',
      circuitId: 'cir_s',
      rateUnit: 'A',
      balancingMode: 'evse',
      minPowerKw: 2,
      sessions: [
        session({ evseNumber: 1, phases: 'L1', measuredPhases: 'L1', phaseSwitching: false }),
      ],
    });
    const circuit = node({
      type: 'circuit',
      id: 'cir_s',
      maxContinuousKw: 17.664,
      phaseConnections: 'L1L2L3',
      stations: [alone],
    });
    const panel = node({ type: 'panel', maxContinuousKw: 100, children: [circuit] });
    const [result] = computeHierarchicalAllocation([panel], 'equal_share');
    // Its limit reaches the car whole: 2 kW, inside the 5.888 kW of L1.
    expect(result?.limitedBy).not.toBe('min_power_stop');
    expect(result?.allocatedKw ?? 0).toBeGreaterThanOrEqual(2 - 1e-6);
  });
});
