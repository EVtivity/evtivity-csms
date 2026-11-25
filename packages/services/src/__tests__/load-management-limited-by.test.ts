// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import type { EvseSessionInfo, HierarchyNode, StationPowerInfo } from '../load-management-model.js';

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const fake: FakeDb = createFakeDb();
  return fakeDatabaseModule(fake, { isOperatorStation: () => 'OPERATOR_STATION' });
});

const {
  computeEqualShareAllocation,
  computePriorityAllocation,
  demandLimitReason,
  computeHierarchicalAllocation,
  reduceAllocations,
} = await import('../load-management-allocation.js');

function station(overrides: Partial<StationPowerInfo> & { id: string }): StationPowerInfo {
  return {
    stationId: overrides.id.toUpperCase(),
    circuitId: 'cir_a',
    currentDrawKw: 0,
    phasePowerKw: null,
    maxPowerKw: 50,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    minPowerKw: 0,
    rateUnit: 'W',
    profileId: 1_000_000_000,
    circuitVoltageV: 230,
    circuitPhases: 3,
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
    ratingKw: 22,
    ratingA: 32,
    tariffId: 'trf_1',
    tariffMaxCurrentA: null,
    phases: null,
    startedAt: new Date('2026-06-04T10:00:00Z'),
    ...overrides,
  };
}

const nodeBase = {
  unmanagedLoadKw: 0,
  currentDrawKw: 0,
  safetyMarginKw: 0,
  phases: 1,
  breakerRatingAmps: 100,
  voltageV: 240,
  oversubscriptionRatio: 1,
  phaseConnections: null,
  phaseLoad: null,
  perPhaseCapacityKw: null,
};

function circuit(stations: StationPowerInfo[], maxContinuousKw: number): HierarchyNode {
  return {
    ...nodeBase,
    type: 'circuit',
    id: 'cir_a',
    name: 'Circuit A',
    maxContinuousKw,
    stations,
    children: [],
  };
}

function parent(
  type: 'panel' | 'transformer',
  maxContinuousKw: number,
  children: HierarchyNode[],
): HierarchyNode {
  return {
    ...nodeBase,
    type,
    id: `${type}_1`,
    name: type,
    maxContinuousKw,
    stations: [],
    children,
  };
}

function reasons(results: { stationDbId: string; limitedBy?: string }[]): Record<string, string> {
  return Object.fromEntries(results.map((r) => [r.stationDbId, r.limitedBy ?? 'none']));
}

describe('what set each station limit', () => {
  it('a circuit share is circuit_limit, a station that got its maximum station_max', () => {
    const result = computeEqualShareAllocation(
      [station({ id: 'a', maxPowerKw: 10 }), station({ id: 'b', maxPowerKw: 100 })],
      40,
    );
    expect(reasons(result)).toEqual({ a: 'station_max', b: 'circuit_limit' });
  });

  it('a station held by a tariff current limit is tariff_limit', () => {
    const capped = station({
      id: 'a',
      maxPowerKw: 22,
      sessions: [session({ tariffMaxCurrentA: 10 })],
    });
    const result = computePriorityAllocation([capped, station({ id: 'b' })], 100);
    expect(reasons(result)).toEqual({ a: 'tariff_limit', b: 'station_max' });
  });

  it('a station held lower by a unit budget is unit_budget', () => {
    const budgeted = station({
      id: 'a',
      maxPowerKw: 44,
      sessions: [
        session({ unitId: 'unt_1' }),
        session({ sessionId: 'ses_2', transactionId: 'tx-2', evseNumber: 2, unitId: 'unt_1' }),
      ],
      unitBudgets: [{ unitId: 'unt_1', kind: 'ac', maxCurrentA: 16, phases: 3, maxPowerKw: null }],
    });
    expect(demandLimitReason(budgeted)).toBe('unit_budget');
    expect(reasons(computeEqualShareAllocation([budgeted], 100))).toEqual({
      a: 'unit_budget',
    });
  });

  it('a station stopped because the minimums do not fit is min_power_stop', () => {
    const result = computeEqualShareAllocation(
      [
        station({ id: 'a', minPowerKw: 8, loadPriority: 9 }),
        station({ id: 'b', minPowerKw: 8, loadPriority: 1 }),
      ],
      10,
    );
    expect(reasons(result)).toEqual({ a: 'circuit_limit', b: 'min_power_stop' });
  });

  it('a cut by a panel is panel_limit and by a transformer transformer_limit', () => {
    // Limits in A hold each phase, so the three-phase circuit counts a third per phase.
    const stations = [
      station({ id: 'a', maxPowerKw: 30, rateUnit: 'A' }),
      station({ id: 'b', maxPowerKw: 30, rateUnit: 'A' }),
    ];
    const panel = computeHierarchicalAllocation(
      [parent('panel', 40, [circuit(stations, 100)])],
      'equal_share',
    );
    expect(reasons(panel)).toEqual({ a: 'panel_limit', b: 'panel_limit' });
    const transformer = computeHierarchicalAllocation(
      [parent('transformer', 40, [parent('panel', 200, [circuit(stations, 100)])])],
      'equal_share',
    );
    expect(reasons(transformer)).toEqual({ a: 'transformer_limit', b: 'transformer_limit' });
  });

  it('a panel that does not cut keeps the circuit reason', () => {
    const stations = [station({ id: 'a', maxPowerKw: 30 })];
    const result = computeHierarchicalAllocation(
      [parent('panel', 200, [circuit(stations, 100)])],
      'equal_share',
    );
    expect(reasons(result)).toEqual({ a: 'station_max' });
  });

  it('a planned station is depot_plan', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b', maxPowerKw: 5 })];
    const result = computeHierarchicalAllocation(
      [parent('panel', 200, [circuit(stations, 100)])],
      'departure_aware',
      new Map(),
      { kw: new Map([['a', 20]]) },
    );
    expect(reasons(result)).toEqual({ a: 'depot_plan', b: 'station_max' });
  });

  it('a reduce stops the lowest priority as min_power_stop and cuts the rest with its reason', () => {
    const a = station({ id: 'a', minPowerKw: 10, loadPriority: 9 });
    const b = station({ id: 'b', minPowerKw: 10, loadPriority: 1 });
    const entries = [
      {
        station: a,
        alloc: { stationId: 'A', stationDbId: 'a', allocatedKw: 20, currentDrawKw: 0 },
      },
      {
        station: b,
        alloc: { stationId: 'B', stationDbId: 'b', allocatedKw: 20, currentDrawKw: 0 },
      },
    ];
    reduceAllocations(entries, 15, 'panel_limit');
    expect(reasons(entries.map((e) => e.alloc))).toEqual({
      a: 'panel_limit',
      b: 'min_power_stop',
    });
  });
});
