// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceLogger } from '@evtivity/lib';

vi.mock('postgres', () => ({ default: vi.fn(() => vi.fn()) }));

const dbState = vi.hoisted(() => {
  const names = [
    'siteLoadManagement',
    'panels',
    'circuits',
    'unmanagedLoads',
    'chargingStations',
    'chargingSessions',
    'meterValues',
    'connectors',
    'evses',
    'loadAllocationLog',
    'evChargingNeeds',
    'stationConfigurations',
    'chargingProfiles',
    'transformers',
    'siteEnergyAssets',
    'energyAssetReadings',
    'sites',
  ];
  const tables: Record<string, { __table: string }> = {};
  for (const name of names) tables[name] = { __table: name };
  const results = new Map<string, unknown[]>();
  function chain(): unknown {
    let from = '';
    const c: Record<string, unknown> = {};
    c['from'] = (t: { __table: string }) => {
      from = t.__table;
      return c;
    };
    for (const k of ['innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) c[k] = () => c;
    c['then'] = (ok: (v: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(results.get(from) ?? []).then(ok, fail);
    return c;
  }
  const update = vi.fn(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: 1 }]),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(undefined).then(ok),
      }),
    }),
  }));
  const insert = vi.fn(() => ({ values: () => Promise.resolve() }));
  return { tables, results, db: { select: vi.fn(() => chain()), update, insert } };
});

vi.mock('@evtivity/database', () => ({
  db: dbState.db,
  ...dbState.tables,
  isOperatorStation: vi.fn(() => 'OPERATOR_STATION'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  asc: vi.fn(),
  desc: vi.fn(),
  isNotNull: vi.fn(),
}));

const planMock = vi.hoisted(() => ({
  departureAwareAllocation: vi.fn(),
  dispatchDepotPlanProfiles: vi.fn(),
  clearDepotPlanProfiles: vi.fn(),
}));
vi.mock('../charging-plan.service.js', () => planMock);

import {
  computeHierarchicalAllocation,
  computeSiteAllocation,
  runLoadManagementCycle,
  type HierarchyNode,
  type StationPowerInfo,
} from '../load-management.service.js';

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
    ...overrides,
  };
}

function tree(
  stations: StationPowerInfo[],
  circuitKw: number,
  panelKw: number,
  panelMarginKw = 0,
): HierarchyNode[] {
  const base = {
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    phases: 1,
    breakerRatingAmps: 100,
    voltageV: 240,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
  };
  const circuit: HierarchyNode = {
    ...base,
    type: 'circuit',
    id: 'cir_a',
    name: 'A',
    maxContinuousKw: circuitKw,
    safetyMarginKw: 0,
    stations,
    children: [],
  };
  return [
    {
      ...base,
      type: 'panel',
      id: 'pnl_root',
      name: 'Main',
      maxContinuousKw: panelKw,
      safetyMarginKw: panelMarginKw,
      stations: [],
      children: [circuit],
    },
  ];
}

function byId(allocations: Array<{ stationDbId: string; allocatedKw: number }>) {
  return new Map(allocations.map((a) => [a.stationDbId, a.allocatedKw]));
}

function makeLogger(): ServiceLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('computeHierarchicalAllocation with planned stations', () => {
  it('gives a planned station its slot power and shares the rest equally', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b' }), station({ id: 'c' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 60, 200), 'departure_aware', new Map(), {
        kw: new Map([['a', 20]]),
      }),
    );
    expect(result.get('a')).toBe(20);
    expect(result.get('b')).toBe(20);
    expect(result.get('c')).toBe(20);
  });

  it('adds the equal share of an unplanned session to a planned station that shares', () => {
    const stations = [station({ id: 'a', maxPowerKw: 44 }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 60, 200), 'departure_aware', new Map(), {
        kw: new Map([['a', 10]]),
        sharing: new Set(['a']),
      }),
    );
    expect(result.get('a')).toBe(10 + 25);
    expect(result.get('b')).toBe(25);
  });

  it('cuts a plan that asks for more than its circuit holds', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 30, 200), 'departure_aware', new Map(), {
        kw: new Map([
          ['a', 25],
          ['b', 15],
        ]),
      }),
    );
    expect((result.get('a') ?? 0) + (result.get('b') ?? 0)).toBeCloseTo(30, 9);
  });

  it('lets the panel limit cut planned and unplanned stations alike', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 100, 50, 10), 'departure_aware', new Map(), {
        kw: new Map([['a', 30]]),
      }),
    );
    // Circuit: a 30 planned, b gets 50 (its max). Panel: 40 after the margin.
    expect(result.get('a')).toBeCloseTo(30 * (40 / 80), 9);
    expect(result.get('b')).toBeCloseTo(50 * (40 / 80), 9);
  });

  it('ignores the plan of an offline station, which stays a reservation', () => {
    const stations = [station({ id: 'a', isOnline: false }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(
        tree(stations, 60, 200),
        'departure_aware',
        new Map([['a', 22]]),
        { kw: new Map([['a', 30]]) },
      ),
    );
    expect(result.has('a')).toBe(false);
    expect(result.get('b')).toBe(38);
  });

  it('caps a planned station at its maximum', () => {
    const stations = [station({ id: 'a', maxPowerKw: 11 }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 60, 200), 'departure_aware', new Map(), {
        kw: new Map([['a', 30]]),
      }),
    );
    expect(result.get('a')).toBe(11);
    expect(result.get('b')).toBe(49);
  });

  it('never cuts a planned AC session below 6 A: the panel stops the station instead', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b' })];
    const result = byId(
      computeHierarchicalAllocation(tree(stations, 100, 10), 'departure_aware', new Map(), {
        kw: new Map([['a', 9]]),
        minKw: new Map([['a', 4.14]]),
      }),
    );
    const a = result.get('a') ?? 0;
    expect(a === 0 || a >= 4.14 - 1e-9).toBe(true);
    expect((result.get('a') ?? 0) + (result.get('b') ?? 0)).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('shares equally without a plan', () => {
    const stations = [station({ id: 'a' }), station({ id: 'b' })];
    const roots = tree(stations, 60, 200);
    expect(computeHierarchicalAllocation(roots, 'departure_aware')).toEqual(
      computeHierarchicalAllocation(roots, 'equal_share'),
    );
  });
});

describe('computeSiteAllocation for a departure-aware site', () => {
  beforeEach(() => {
    dbState.results.clear();
    dbState.results.set('chargingStations', [
      {
        id: 'a',
        stationId: 'A',
        isOnline: true,
        loadPriority: 5,
        loadMinPowerKw: null,
        circuitId: 'cir_a',
      },
      {
        id: 'b',
        stationId: 'B',
        isOnline: true,
        loadPriority: 5,
        loadMinPowerKw: null,
        circuitId: 'cir_a',
      },
    ]);
    dbState.results.set('connectors', [
      { stationId: 'a', evseDbId: 'ea', maxPowerKw: '50' },
      { stationId: 'b', evseDbId: 'eb', maxPowerKw: '50' },
    ]);
    dbState.results.set('chargingSessions', [{ stationId: 'a' }, { stationId: 'b' }]);
    dbState.results.set('panels', [
      {
        id: 'pnl_root',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 200,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '200',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1',
        phaseConnections: null,
      },
    ]);
    dbState.results.set('circuits', [
      {
        id: 'cir_a',
        panelId: 'pnl_root',
        name: 'A',
        breakerRatingAmps: 100,
        maxContinuousKw: '60',
        phaseConnections: null,
        voltageV: null,
      },
    ]);
  });

  it('shares power equally while fleet charging is off', async () => {
    planMock.departureAwareAllocation.mockResolvedValue(null);
    const { allocations } = await computeSiteAllocation('sit_1', 'departure_aware', null);
    expect(byId(allocations)).toEqual(
      new Map([
        ['a', 30],
        ['b', 30],
      ]),
    );
  });

  it('uses the planned allocations and lets only the cycle replan', async () => {
    planMock.departureAwareAllocation.mockResolvedValue([
      { stationId: 'A', stationDbId: 'a', allocatedKw: 45, currentDrawKw: 0 },
      { stationId: 'B', stationDbId: 'b', allocatedKw: 15, currentDrawKw: 0 },
    ]);
    const log = makeLogger();
    const { allocations } = await computeSiteAllocation('sit_1', 'departure_aware', null, {
      replan: true,
      log,
    });
    expect(byId(allocations).get('a')).toBe(45);
    expect(planMock.departureAwareAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1', replan: true, log }),
    );
    await computeSiteAllocation('sit_1', 'departure_aware', null);
    expect(planMock.departureAwareAllocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ replan: false }),
    );
  });

  it('falls back to equal share for the cycle when planning fails', async () => {
    planMock.departureAwareAllocation.mockRejectedValue(new Error('planner down'));
    const log = makeLogger();
    const { allocations } = await computeSiteAllocation('sit_1', 'departure_aware', null, {
      replan: true,
      log,
    });
    expect(byId(allocations).get('a')).toBe(30);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Depot charging plan failed, sharing power equally',
    );
  });

  it('never asks the planner for other strategies', async () => {
    await computeSiteAllocation('sit_1', 'equal_share', null, { replan: true });
    expect(planMock.departureAwareAllocation).not.toHaveBeenCalled();
  });
});

describe('the cycle sends the depot plan profiles after the station limits', () => {
  function siteRows(strategy: string, applied: unknown, appliedAt: Date | null): void {
    dbState.results.set('siteLoadManagement', [
      { siteId: 'sit_1', strategy, appliedAllocations: applied, appliedAt, isEnabled: true },
    ]);
  }

  beforeEach(() => {
    planMock.departureAwareAllocation.mockResolvedValue([
      { stationId: 'A', stationDbId: 'a', allocatedKw: 30, currentDrawKw: 0 },
      { stationId: 'B', stationDbId: 'b', allocatedKw: 30, currentDrawKw: 0 },
    ]);
    planMock.dispatchDepotPlanProfiles.mockResolvedValue(1);
  });

  it('dispatches the plan profiles of a departure-aware site', async () => {
    siteRows('departure_aware', null, null);
    await runLoadManagementCycle(makeLogger(), 'sit_1');
    expect(planMock.dispatchDepotPlanProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
    );
  });

  it('dispatches them also when the station limits did not change', async () => {
    siteRows(
      'departure_aware',
      [
        { stationId: 'A', stationDbId: 'a', allocatedKw: 30 },
        { stationId: 'B', stationDbId: 'b', allocatedKw: 30 },
      ],
      new Date(),
    );
    await runLoadManagementCycle(makeLogger(), 'sit_1');
    expect(planMock.dispatchDepotPlanProfiles).toHaveBeenCalledTimes(1);
  });

  it('never dispatches plan profiles for other strategies, it clears what is left', async () => {
    planMock.clearDepotPlanProfiles.mockResolvedValue(0);
    siteRows('equal_share', null, null);
    await runLoadManagementCycle(makeLogger(), 'sit_1');
    expect(planMock.dispatchDepotPlanProfiles).not.toHaveBeenCalled();
    expect(planMock.clearDepotPlanProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
    );
  });

  it('keeps the cycle going when the clear fails', async () => {
    planMock.clearDepotPlanProfiles.mockRejectedValue(new Error('db down'));
    siteRows('equal_share', null, null);
    const log = makeLogger();
    await runLoadManagementCycle(log, 'sit_1');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Depot plan profiles not cleared, the next cycle tries again',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps the cycle going when the dispatch fails', async () => {
    siteRows('departure_aware', null, null);
    planMock.dispatchDepotPlanProfiles.mockRejectedValue(new Error('db down'));
    const log = makeLogger();
    await runLoadManagementCycle(log, 'sit_1');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Depot plan profiles not sent, the station limits hold',
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});
