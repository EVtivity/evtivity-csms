// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceLogger } from '@evtivity/lib';
import { computeMaxContinuousKw } from '@evtivity/lib/load-allocation';

vi.mock('postgres', () => ({
  default: vi.fn(() => vi.fn()),
}));

// Distinct table identities so the db mock can route results by `.from(table)`.
// Each table is a tagged object; the chainable select mock reads `__table`.
type TableName =
  | 'siteLoadManagement'
  | 'panels'
  | 'circuits'
  | 'unmanagedLoads'
  | 'chargingStations'
  | 'chargingSessions'
  | 'meterValues'
  | 'connectors'
  | 'evses'
  | 'loadAllocationLog'
  | 'evChargingNeeds'
  | 'stationConfigurations'
  | 'chargingProfiles'
  | 'transformers'
  | 'siteEnergyAssets'
  | 'energyAssetReadings'
  | 'sites';

// vi.hoisted so the mutable state is constructed before the vi.mock factories run
// and is referenceable from both the factory and the test bodies.
const dbState = vi.hoisted(() => {
  // Tagged table objects. Columns referenced by the source (e.g. evses.stationId)
  // resolve to `undefined` which is fine because drizzle-orm operators are mocked.
  const tables: Record<string, { __table: string }> = {};
  for (const name of [
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
  ]) {
    tables[name] = { __table: name };
  }

  // results: TableName -> rows[] returned by a select rooted at that table.
  const results = new Map<string, unknown[]>();
  // insertCalls: TableName -> array of inserted value objects.
  const insertCalls: Array<{ table: string; values: unknown }> = [];

  // updateCalls: every db.update(table).set(values) call.
  const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  // Rows a db.update(...).returning() resolves to (an empty array: nothing claimed).
  const updateReturning: { rows: unknown[] } = { rows: [{ id: 1 }] };

  function reset(): void {
    results.clear();
    insertCalls.length = 0;
    updateCalls.length = 0;
    updateReturning.rows = [{ id: 1 }];
  }

  // Build a thenable chainable that resolves to the routed result for `from`'s table.
  function makeSelectChain(): unknown {
    let fromTable: string | null = null;
    const chain: Record<string, unknown> = {};
    const resolve = (): unknown[] => results.get(fromTable ?? '') ?? [];

    chain['from'] = (table: { __table?: string }) => {
      fromTable = table.__table ?? null;
      return chain;
    };
    chain['innerJoin'] = () => chain;
    chain['leftJoin'] = () => chain;
    chain['where'] = () => chain;
    chain['orderBy'] = () => chain;
    chain['limit'] = () => chain;
    // Make the chain awaitable: `await db.select(...).from(...).where(...)`.
    // A table whose read fails: results holds an Error for it.
    chain['then'] = (
      onFulfilled: (v: unknown[]) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      const failure = results.get(fromTable ?? '');
      return (failure instanceof Error ? Promise.reject(failure) : Promise.resolve(resolve())).then(
        onFulfilled,
        onRejected,
      );
    };
    return chain;
  }

  const makeSelectFactory = () => () => makeSelectChain();

  const db = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn((table: { __table?: string }) => ({
      values: vi.fn((values: unknown) => {
        insertCalls.push({ table: table.__table ?? 'unknown', values });
        return Promise.resolve();
      }),
    })),
    update: vi.fn((table: { __table?: string }) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table: table.__table ?? 'unknown', values });
        const where = {
          returning: () => Promise.resolve(updateReturning.rows),
          then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(undefined).then(onFulfilled, onRejected),
        };
        return { where: () => where };
      }),
    })),
  };

  return {
    tables,
    results,
    insertCalls,
    updateCalls,
    updateReturning,
    reset,
    db,
    makeSelectFactory,
  };
});

vi.mock('@evtivity/database', () => ({
  db: dbState.db,
  siteLoadManagement: dbState.tables['siteLoadManagement'],
  panels: dbState.tables['panels'],
  circuits: dbState.tables['circuits'],
  unmanagedLoads: dbState.tables['unmanagedLoads'],
  chargingStations: dbState.tables['chargingStations'],
  chargingSessions: dbState.tables['chargingSessions'],
  meterValues: dbState.tables['meterValues'],
  connectors: dbState.tables['connectors'],
  evses: dbState.tables['evses'],
  loadAllocationLog: dbState.tables['loadAllocationLog'],
  evChargingNeeds: dbState.tables['evChargingNeeds'],
  stationConfigurations: dbState.tables['stationConfigurations'],
  chargingProfiles: dbState.tables['chargingProfiles'],
  transformers: dbState.tables['transformers'],
  siteEnergyAssets: dbState.tables['siteEnergyAssets'],
  energyAssetReadings: dbState.tables['energyAssetReadings'],
  sites: dbState.tables['sites'],
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

// PubSub stub injected via setPubSub so applyAllocations/broadcastLoadUpdate publish
// against a controllable spy instead of the no-op fallback.
const pubsubState = vi.hoisted(() => {
  const publish = vi
    .fn<(channel: string, message: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  return { publish };
});

vi.mock('@evtivity/lib/pubsub-instance', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib/pubsub-instance')>(
    '@evtivity/lib/pubsub-instance',
  );
  return {
    ...actual,
    getPubSub: vi.fn(() => ({
      publish: pubsubState.publish,
      subscribe: vi.fn(),
      ping: vi.fn(async () => true),
    })),
  };
});

import {
  computeEqualShareAllocation,
  computePriorityAllocation,
  computeHierarchicalAllocation,
  getSitePowerStatus,
  buildSiteHierarchy,
  logAllocations,
  dispatchAllocations,
  clearLoadManagementProfiles,
  runLoadManagementCycle,
  stationMaxPowerKw,
  offlineReservations,
  summarizeSiteCapacity,
  buildLoadManagementProfile,
  LOAD_MANAGEMENT_PROFILE_ID,
  LOAD_MANAGEMENT_REFRESH_MS,
  chargingRateUnitFor,
  limitInUnit,
  loadManagementProfileId,
  supportedRateUnits,
  unconfirmedReservations,
  sendRateUnit,
  parseAppliedAllocations,
  isLoadManagementProfile,
  profileRateUnit,
  profileLimitKw,
  lastAcceptedLimitsKw,
  orderLimitChanges,
  stationRates,
  stepDownPrimaryPhases,
  nodeCapacityKw,
  fixedPhaseLoad,
  fixedLoadKw,
  localGenerationKw,
  clearRememberedEnergyAssets,
  forgetRememberedEnergyAssets,
  pruneRememberedEnergyAssets,
  rememberedEnergyAssetSiteIds,
  REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS,
  withoutRaises,
  withoutAssetReadings,
  splitCreditLimits,
  limitCommands,
  orderLimitCommands,
  LOAD_MANAGEMENT_CREDIT_STACK_LEVEL,
  LOAD_MANAGEMENT_CREDIT_RESEND_MS,
  type HierarchyNode,
  type StationPowerInfo,
  type AllocationResult,
} from '../load-management.service.js';
import { buildPlanNodes, phaseNodeId } from '../charging-plan.service.js';

function setResult(table: TableName, rows: unknown[]): void {
  dbState.results.set(table, rows);
}

function makeStation(
  overrides: Partial<StationPowerInfo> & { id: string; stationId: string },
): StationPowerInfo {
  return {
    circuitId: null,
    currentDrawKw: 0,
    maxPowerKw: 50,
    loadPriority: 1,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    phasePowerKw: { L1: 0, L2: 0, L3: 0 },
    minPowerKw: 0,
    rateUnit: 'W',
    profileId: 1_000_000_000,
    ...overrides,
  };
}

function makeLogger(): ServiceLogger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  dbState.reset();
  clearRememberedEnergyAssets();
  // Restore the default routing select factory in case a test replaced it.
  dbState.db.select.mockReset();
  dbState.db.select.mockImplementation(() => dbState.makeSelectFactory()());
  pubsubState.publish.mockClear();
  pubsubState.publish.mockResolvedValue(undefined);
});

describe('computeEqualShareAllocation', () => {
  it('returns empty array for empty stations', () => {
    const result = computeEqualShareAllocation([], 100);

    expect(result).toEqual([]);
  });

  it('gives single station the full allocation', () => {
    const stations = [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })];

    const result = computeEqualShareAllocation(stations, 80);

    expect(result).toHaveLength(1);
    expect(result[0]?.allocatedKw).toBe(80);
    expect(result[0]?.stationId).toBe('CS-001');
  });

  it('splits equally between two stations', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
    ];

    const result = computeEqualShareAllocation(stations, 80);

    expect(result).toHaveLength(2);
    const totalAllocated = result.reduce((sum, r) => sum + r.allocatedKw, 0);
    expect(totalAllocated).toBe(80);
    expect(result[0]?.allocatedKw).toBe(40);
    expect(result[1]?.allocatedKw).toBe(40);
  });

  it('caps station at maxPowerKw and redistributes surplus', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 20 }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
    ];

    const result = computeEqualShareAllocation(stations, 100);

    // Equal share = 50 each. CS-001 capped at 20, surplus 30 goes to CS-002
    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    expect(s1?.allocatedKw).toBe(20);
    expect(s2?.allocatedKw).toBe(80);
  });

  it('excludes offline station', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', isOnline: false }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
    ];

    const result = computeEqualShareAllocation(stations, 100);

    expect(result).toHaveLength(1);
    expect(result[0]?.stationId).toBe('CS-002');
    expect(result[0]?.allocatedKw).toBe(100);
  });

  it('excludes station without active session', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', hasActiveSession: false }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
    ];

    const result = computeEqualShareAllocation(stations, 60);

    expect(result).toHaveLength(1);
    expect(result[0]?.stationId).toBe('CS-002');
    expect(result[0]?.allocatedKw).toBe(60);
  });

  it('gives 0 when no power is available, so the station stops instead of keeping its old limit', () => {
    const stations = [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 50 })];

    const result = computeEqualShareAllocation(stations, 0);

    expect(result.map((r) => r.allocatedKw)).toEqual([0]);
  });

  it('falls back to share as cap when maxPowerKw is zero', () => {
    // maxPowerKw === 0 means cap = share, so every station is capped at its share
    // and allocated exactly the share without redistribution.
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 0 }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 0 }),
    ];

    const result = computeEqualShareAllocation(stations, 40);

    expect(result).toHaveLength(2);
    expect(result[0]?.allocatedKw).toBe(20);
    expect(result[1]?.allocatedKw).toBe(20);
  });

  it('redistributes across three rounds until all stations are capped', () => {
    // available 100 / 3 = 33.33. s1(10) caps, surplus carried. Next round 90/2=45,
    // s2(20) caps. Final round s3 gets the rest, bounded by its own 100 cap.
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 10 }),
      makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 20 }),
      makeStation({ id: 's3', stationId: 'CS-003', maxPowerKw: 100 }),
    ];

    const result = computeEqualShareAllocation(stations, 100);

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    const s3 = result.find((r) => r.stationId === 'CS-003');
    expect(s1?.allocatedKw).toBe(10);
    expect(s2?.allocatedKw).toBe(20);
    expect(s3?.allocatedKw).toBe(70);
  });

  it('carries currentDrawKw into the allocation result', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100, currentDrawKw: 12.5 }),
    ];

    const result = computeEqualShareAllocation(stations, 50);

    expect(result[0]?.currentDrawKw).toBe(12.5);
    expect(result[0]?.stationDbId).toBe('s1');
  });
});

describe('computePriorityAllocation', () => {
  it('returns empty array for empty stations', () => {
    const result = computePriorityAllocation([], 100);

    expect(result).toEqual([]);
  });

  it('gives higher priority stations power first', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, maxPowerKw: 50 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 1, maxPowerKw: 50 }),
    ];

    const result = computePriorityAllocation(stations, 60);

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    // Priority 10 gets full 50 (capped at max), priority 1 gets remaining 10
    expect(s1?.allocatedKw).toBe(50);
    expect(s2?.allocatedKw).toBe(10);
  });

  it('splits equally within same priority group', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 5, maxPowerKw: 100 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 80);

    expect(result).toHaveLength(2);
    expect(result[0]?.allocatedKw).toBe(40);
    expect(result[1]?.allocatedKw).toBe(40);
  });

  it('gives lower priority group the remaining power', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, maxPowerKw: 30 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, maxPowerKw: 100 }),
      makeStation({ id: 's3', stationId: 'CS-003', loadPriority: 1, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 100);

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    const s3 = result.find((r) => r.stationId === 'CS-003');
    // Priority 10: gets 30 (capped at max). Remaining: 70
    // Priority 5: gets 70 (under 100 cap). Remaining: 0
    // Priority 1: no remaining power, limit 0 (it would keep an old, higher limit)
    expect(s1?.allocatedKw).toBe(30);
    expect(s2?.allocatedKw).toBe(70);
    expect(s3?.allocatedKw).toBe(0);
  });

  it('caps stations at maxPowerKw within priority group', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 5, maxPowerKw: 20 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 100);

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    // Equal share = 50 each. CS-001 caps at 20, leaving 80 for CS-002 which is under its cap.
    expect(s1?.allocatedKw).toBe(20);
    expect(s2?.allocatedKw).toBe(80);
  });

  it('filters out offline and inactive stations', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, isOnline: false }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, hasActiveSession: false }),
      makeStation({ id: 's3', stationId: 'CS-003', loadPriority: 1, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 100);

    expect(result).toHaveLength(1);
    expect(result[0]?.stationId).toBe('CS-003');
    expect(result[0]?.allocatedKw).toBe(100);
  });

  it('breaks ties within a group by earliest departure time first', () => {
    // Same priority. Equal share is enough for both, so both allocate; the sort
    // determines insertion order (earlier departure first).
    const early = new Date('2026-06-04T08:00:00Z');
    const late = new Date('2026-06-04T18:00:00Z');
    const stations = [
      makeStation({
        id: 's1',
        stationId: 'CS-LATE',
        loadPriority: 5,
        maxPowerKw: 100,
        departureTime: late,
      }),
      makeStation({
        id: 's2',
        stationId: 'CS-EARLY',
        loadPriority: 5,
        maxPowerKw: 100,
        departureTime: early,
      }),
    ];

    const result = computePriorityAllocation(stations, 40);

    expect(result[0]?.stationId).toBe('CS-EARLY');
    expect(result[1]?.stationId).toBe('CS-LATE');
    expect(result[0]?.allocatedKw).toBe(20);
    expect(result[1]?.allocatedKw).toBe(20);
  });

  it('orders a station with a departure time ahead of one without', () => {
    const dep = new Date('2026-06-04T08:00:00Z');
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-NODEP', loadPriority: 5, maxPowerKw: 100 }),
      makeStation({
        id: 's2',
        stationId: 'CS-DEP',
        loadPriority: 5,
        maxPowerKw: 100,
        departureTime: dep,
      }),
    ];

    const result = computePriorityAllocation(stations, 40);

    expect(result[0]?.stationId).toBe('CS-DEP');
    expect(result[1]?.stationId).toBe('CS-NODEP');
  });

  it('keeps order stable when neither station has a departure time', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-A', loadPriority: 5, maxPowerKw: 100 }),
      makeStation({ id: 's2', stationId: 'CS-B', loadPriority: 5, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 40);

    expect(result.map((r) => r.stationId)).toEqual(['CS-A', 'CS-B']);
  });

  it('ranks the first station first when only the first has a departure time', () => {
    // Exercises the `if (a.departureTime != null) return -1` branch where b has none.
    const dep = new Date('2026-06-04T08:00:00Z');
    const stations = [
      makeStation({
        id: 's1',
        stationId: 'CS-A',
        loadPriority: 5,
        maxPowerKw: 100,
        departureTime: dep,
      }),
      makeStation({ id: 's2', stationId: 'CS-B', loadPriority: 5, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 40);

    expect(result[0]?.stationId).toBe('CS-A');
  });

  it('ranks the second station first when only the second has a departure time', () => {
    // Exercises the `if (b.departureTime != null) return 1` branch where a has none.
    const dep = new Date('2026-06-04T08:00:00Z');
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-A', loadPriority: 5, maxPowerKw: 100 }),
      makeStation({
        id: 's2',
        stationId: 'CS-B',
        loadPriority: 5,
        maxPowerKw: 100,
        departureTime: dep,
      }),
    ];

    const result = computePriorityAllocation(stations, 40);

    expect(result[0]?.stationId).toBe('CS-B');
  });

  it('stops allocating once power is exhausted across priority groups', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, maxPowerKw: 100 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 1, maxPowerKw: 100 }),
    ];

    const result = computePriorityAllocation(stations, 100);

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    // Priority 10 takes all 100 (under cap). Priority 1 group sees remaining <= 0 and breaks.
    expect(s1?.allocatedKw).toBe(100);
    expect(s2?.allocatedKw).toBe(0);
  });

  it('falls back to share cap when maxPowerKw is zero within a group', () => {
    const stations = [
      makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 5, maxPowerKw: 0 }),
      makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, maxPowerKw: 0 }),
    ];

    const result = computePriorityAllocation(stations, 60);

    expect(result).toHaveLength(2);
    expect(result[0]?.allocatedKw).toBe(30);
    expect(result[1]?.allocatedKw).toBe(30);
  });
});

describe('computeHierarchicalAllocation', () => {
  function circuitNode(overrides: Partial<HierarchyNode>): HierarchyNode {
    return {
      type: 'circuit',
      id: 'c1',
      name: 'Circuit 1',
      maxContinuousKw: 100,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [],
      children: [],
      phases: 1,
      breakerRatingAmps: 100,
      voltageV: 240,
      oversubscriptionRatio: 1.0,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
      ...overrides,
    };
  }

  function panelNode(overrides: Partial<HierarchyNode>): HierarchyNode {
    return {
      type: 'panel',
      id: 'p1',
      name: 'Panel 1',
      maxContinuousKw: 200,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [],
      children: [],
      phases: 1,
      breakerRatingAmps: 200,
      voltageV: 240,
      oversubscriptionRatio: 1.0,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
      ...overrides,
    };
  }

  it('allocates within a single circuit under a panel (equal_share)', () => {
    const circuit = circuitNode({
      maxContinuousKw: 80,
      stations: [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
      ],
    });
    const panel = panelNode({ maxContinuousKw: 200, children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result).toHaveLength(2);
    const total = result.reduce((sum, r) => sum + r.allocatedKw, 0);
    // Circuit available = 80 - 0 unmanaged = 80, split equally = 40 each.
    expect(total).toBe(80);
    expect(result.every((r) => r.allocatedKw === 40)).toBe(true);
  });

  it('holds a dual-port pedestal to its one shared circuit, not the sum of its ports', () => {
    // Two 32 A ports at 208 V (6.66 kW each) on one 2-pole 40 A circuit of a
    // 208Y/120 V panel: 32 A continuous for the station (NEC 625.42, ChargePoint
    // CT4000 Power Share), which the station shares between its ports.
    const maxPowerKw = stationMaxPowerKw([
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '6.66' },
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: '6.66' },
    ]).get('sta_1');
    expect(maxPowerKw).toBeCloseTo(13.32, 2);
    const circuitKw = computeMaxContinuousKw(40, 120, 2);
    const circuit = circuitNode({
      maxContinuousKw: circuitKw,
      voltageV: 120,
      phases: 2,
      breakerRatingAmps: 40,
      phaseConnections: 'L1L2',
      stations: [makeStation({ id: 's1', stationId: 'CS-3054', maxPowerKw: maxPowerKw ?? 0 })],
    });
    const panel = panelNode({
      maxContinuousKw: computeMaxContinuousKw(225, 120, 3),
      voltageV: 120,
      phases: 3,
      breakerRatingAmps: 225,
      children: [circuit],
    });

    const [only] = computeHierarchicalAllocation([panel], 'equal_share');

    expect(only?.allocatedKw).toBeCloseTo(circuitKw, 3);
    // 32 A at 208 V.
    expect(((only?.allocatedKw ?? 0) * 1000) / (120 * Math.sqrt(3))).toBeCloseTo(32, 1);
  });

  it('subtracts circuit unmanaged load from available power', () => {
    const circuit = circuitNode({
      maxContinuousKw: 100,
      unmanagedLoadKw: 30,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({ maxContinuousKw: 500, children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    // available = 100 - 30 = 70
    expect(result[0]?.allocatedKw).toBe(70);
  });

  it('scales down circuit allocations when panel capacity is exceeded', () => {
    const circuitA = circuitNode({
      id: 'cA',
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const circuitB = circuitNode({
      id: 'cB',
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 })],
    });
    // Child demand = 100 + 100 = 200, panel available = 120 -> scale 0.6
    const panel = panelNode({ maxContinuousKw: 120, children: [circuitA, circuitB] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    const s1 = result.find((r) => r.stationId === 'CS-001');
    const s2 = result.find((r) => r.stationId === 'CS-002');
    expect(s1?.allocatedKw).toBeCloseTo(60, 6);
    expect(s2?.allocatedKw).toBeCloseTo(60, 6);
  });

  it('applies panel safety margin and unmanaged load to available capacity', () => {
    const circuit = circuitNode({
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    // panelAvailable = 100 - 20 safety - 10 unmanaged = 70. Child demand = 100 -> scale 0.7
    const panel = panelNode({
      maxContinuousKw: 100,
      safetyMarginKw: 20,
      unmanagedLoadKw: 10,
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(70, 6);
  });

  it('recurses into sub-panels and enforces parent capacity', () => {
    const childCircuit = circuitNode({
      id: 'cc',
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const subPanel = panelNode({ id: 'sub', maxContinuousKw: 100, children: [childCircuit] });
    // parent available 50 < child demand 100 -> scale 0.5
    const rootPanel = panelNode({ id: 'root', maxContinuousKw: 50, children: [subPanel] });

    const result = computeHierarchicalAllocation([rootPanel], 'priority_based');

    expect(result[0]?.allocatedKw).toBeCloseTo(50, 6);
  });

  it('does not scale when demand is within panel capacity', () => {
    const circuit = circuitNode({
      maxContinuousKw: 50,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({ maxContinuousKw: 500, children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBe(50);
  });

  it('enforces per-phase limits on three-phase panels', () => {
    // Three-phase panel: perPhaseCapacityKw provided. A circuit on L1 only draws
    // 100 kW allocated, perPhaseLimit forces it down.
    const circuit = circuitNode({
      id: 'cL1',
      maxContinuousKw: 100,
      phaseConnections: 'L1',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    // perPhaseCapacityKw = 30 -> perPhaseLimit = 30 - 0 - 0 = 30. Circuit allocates 100 on L1.
    // phaseScale = 30/100 = 0.3, so the station scales to 30.
    const panel = panelNode({
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 30,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(30, 6);
  });

  it('recurses through a sub-panel when enforcing three-phase per-phase limits', () => {
    // Root is three-phase with a per-phase cap. Its child is a SUB-PANEL (not a
    // circuit), whose own child circuit is on L1 only and over the per-phase
    // limit. This forces both computePhaseAllocations and scaleCircuitsOnPhase to
    // recurse into the sub-panel branch.
    const subCircuit = circuitNode({
      id: 'subC',
      maxContinuousKw: 100,
      phaseConnections: 'L1',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const subPanel = panelNode({
      id: 'sub',
      maxContinuousKw: 1000,
      phases: 3,
      children: [subCircuit],
    });
    // Root per-phase limit = 25. The sub-panel circuit allocates 100 on L1.
    // phaseScale = 25/100 = 0.25 -> station scales to 25.
    const root = panelNode({
      id: 'root',
      maxContinuousKw: 5000,
      phases: 3,
      perPhaseCapacityKw: 25,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [subPanel],
    });

    const result = computeHierarchicalAllocation([root], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(25, 6);
  });

  it('counts unmanaged loads on circuits against the panel', () => {
    // Circuit A: 40 kW breaker with a 30 kW unmanaged load -> its station gets 10.
    // Circuit B: 40 kW, its station gets 40. Panel 50 kW carries 30 + 10 + 40 = 80
    // without the fix. The stations may only use 50 - 30 = 20 of it.
    const circuitA = circuitNode({
      id: 'cA',
      maxContinuousKw: 40,
      unmanagedLoadKw: 30,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const circuitB = circuitNode({
      id: 'cB',
      maxContinuousKw: 40,
      stations: [makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 })],
    });
    const panel = panelNode({ maxContinuousKw: 50, children: [circuitA, circuitB] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    const total = result.reduce((sum, r) => sum + r.allocatedKw, 0);
    expect(total).toBeCloseTo(20, 6);
  });

  it('counts the unmanaged loads of a sub-panel against its parent', () => {
    const circuit = circuitNode({
      id: 'cc',
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const subPanel = panelNode({
      id: 'sub',
      maxContinuousKw: 100,
      unmanagedLoadKw: 30,
      children: [circuit],
    });
    // Root 80 kW: 30 kW of it is the sub-panel's unmanaged load -> 50 for the station.
    const root = panelNode({ id: 'root', maxContinuousKw: 80, children: [subPanel] });

    const result = computeHierarchicalAllocation([root], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(50, 6);
  });

  it('never allocates a negative limit when fixed loads exceed the panel', () => {
    const circuit = circuitNode({
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({
      maxContinuousKw: 50,
      safetyMarginKw: 10,
      unmanagedLoadKw: 60,
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBe(0);
  });

  it('never allocates a negative limit on an overloaded phase', () => {
    const circuit = circuitNode({
      maxContinuousKw: 100,
      phaseConnections: 'L1',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 30,
      unmanagedLoadKw: 120,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBe(0);
  });

  it('cuts a circuit on two overloaded phases once, not once per phase', () => {
    // L1L2 circuit allocated 40: a two-phase (line to line) load puts
    // 40 / sqrt(3) = 23.1 on each phase. Per-phase limit 10: one cut to
    // 10 x sqrt(3) = 17.3 brings both phases to 10. The stale per-phase total
    // cut it again.
    const circuit = circuitNode({
      maxContinuousKw: 40,
      phaseConnections: 'L1L2',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(10 * Math.sqrt(3), 6);
  });

  it('counts a two-phase circuit as P / sqrt(3) per phase, not P / 2', () => {
    // 30 kW on L1L2 is 17.3 per phase. A per-phase limit of 16 must cut it
    // (P / 2 = 15 would have let it through).
    const circuit = circuitNode({
      maxContinuousKw: 30,
      phaseConnections: 'L1L2',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const panel = panelNode({
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 16,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(16 * Math.sqrt(3), 6);
  });

  it('counts a single-phase sub-panel below a three-phase panel on every phase', () => {
    // The sub-panel's 30 kW could be on any phase: each phase limit (20) must
    // hold all of it, so the station is cut to 20, not left at 30 on L1 only.
    const subCircuit = circuitNode({
      id: 'subC',
      maxContinuousKw: 30,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const subPanel = panelNode({ id: 'sub', maxContinuousKw: 1000, children: [subCircuit] });
    const root = panelNode({
      id: 'root',
      maxContinuousKw: 5000,
      phases: 3,
      perPhaseCapacityKw: 20,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [subPanel],
    });

    const result = computeHierarchicalAllocation([root], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(20, 6);
  });

  it('counts the fixed load of a single-phase sub-panel on every phase', () => {
    // 15 kW unmanaged on the single-phase sub-panel leaves 20 - 15 = 5 on each
    // phase for the three-phase circuit's station: 5 x 3 = 15 kW.
    const circuit3 = circuitNode({
      id: 'c3',
      maxContinuousKw: 100,
      phaseConnections: 'L1L2L3',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 })],
    });
    const subPanel = panelNode({ id: 'sub', maxContinuousKw: 100, unmanagedLoadKw: 15 });
    const root = panelNode({
      id: 'root',
      maxContinuousKw: 5000,
      phases: 3,
      perPhaseCapacityKw: 20,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit3, subPanel],
    });

    const result = computeHierarchicalAllocation([root], 'equal_share');

    expect(result[0]?.allocatedKw).toBeCloseTo(15, 6);
  });

  it('gives no allocation to a station with a reservation (an unconfirmed limit)', () => {
    const circuit = circuitNode({
      maxContinuousKw: 40,
      stations: [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100 }),
      ],
    });
    const panel = panelNode({ maxContinuousKw: 100, children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share', new Map([['s2', 25]]));

    expect(result).toHaveLength(1);
    expect(result[0]?.stationDbId).toBe('s1');
    expect(result[0]?.allocatedKw).toBeCloseTo(15, 6);
  });

  it('keeps the reservation of an offline station out of its circuit and panel', () => {
    const circuit = circuitNode({
      maxContinuousKw: 40,
      stations: [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 100 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 100, isOnline: false }),
      ],
    });
    const panel = panelNode({ maxContinuousKw: 30, children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share', new Map([['s2', 15]]));

    // Circuit: 40 - 15 = 25. Panel: 30 - 15 = 15 for the online station.
    expect(result).toHaveLength(1);
    expect(result[0]?.allocatedKw).toBeCloseTo(15, 6);
  });

  it('summarizes the site capacity and what is left for the stations', () => {
    const circuit = circuitNode({ maxContinuousKw: 40, unmanagedLoadKw: 5 });
    const panel = panelNode({
      maxContinuousKw: 100,
      safetyMarginKw: 10,
      unmanagedLoadKw: 20,
      children: [circuit],
    });

    expect(summarizeSiteCapacity([panel], new Map())).toEqual({
      siteLimitKw: 90,
      availableKw: 65,
      supplyCreditKw: 0,
    });
  });

  it('returns no allocations when a circuit has no active stations', () => {
    const circuit = circuitNode({
      maxContinuousKw: 100,
      stations: [makeStation({ id: 's1', stationId: 'CS-001', hasActiveSession: false })],
    });
    const panel = panelNode({ children: [circuit] });

    const result = computeHierarchicalAllocation([panel], 'equal_share');

    expect(result).toEqual([]);
  });

  it('returns empty for an empty roots array', () => {
    const result = computeHierarchicalAllocation([], 'equal_share');

    expect(result).toEqual([]);
  });
});

describe('getSitePowerStatus', () => {
  it('returns zero draw and empty stations when the site has no stations', async () => {
    setResult('chargingStations', []);

    const result = await getSitePowerStatus('site-empty');

    expect(result).toEqual({ totalDrawKw: 0, stations: [] });
  });

  it('reads only operator stations, never conformance test stations', async () => {
    setResult('chargingStations', []);
    const { and } = await import('drizzle-orm');
    vi.mocked(and).mockClear();

    await getSitePowerStatus('site-empty');

    expect(
      vi.mocked(and).mock.calls.some((args) => (args as unknown[]).includes('OPERATOR_STATION')),
    ).toBe(true);
  });

  it('aggregates connector max power, recent draw, active sessions and departures', async () => {
    setResult('chargingStations', [
      {
        id: 'sta_1',
        stationId: 'CS-001',
        isOnline: true,
        loadPriority: 7,
        circuitId: 'cir_1',
      },
    ]);
    // Two EVSEs summed for max power: 50 + 25 = 75
    setResult('connectors', [
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '50' },
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: '25' },
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: null },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }]);
    // Most recent (desc order) overall reading wins: 7000 W -> 7 kW. Older row ignored.
    setResult('meterValues', [
      { stationId: 'sta_1', value: '7000', unit: 'W', phase: null },
      { stationId: 'sta_1', value: '3000', unit: 'W', phase: null },
      { stationId: 'sta_1', value: '2000', unit: 'W', phase: 'L1' },
    ]);
    const departure = new Date('2026-06-04T10:00:00Z');
    setResult('evChargingNeeds', [
      { stationId: 'sta_1', departureTime: new Date('2026-06-04T20:00:00Z') },
      { stationId: 'sta_1', departureTime: departure },
    ]);

    const result = await getSitePowerStatus('site-1');

    expect(result.totalDrawKw).toBe(7);
    expect(result.stations).toHaveLength(1);
    const station = result.stations[0];
    expect(station?.maxPowerKw).toBe(75);
    expect(station?.currentDrawKw).toBe(7);
    expect(station?.loadPriority).toBe(7);
    expect(station?.hasActiveSession).toBe(true);
    expect(station?.phasePowerKw).toEqual({ L1: 2, L2: 0, L3: 0 });
    // Earliest departure wins
    expect(station?.departureTime).toEqual(departure);
  });

  it('treats kW-unit readings as-is and missing readings as zero draw', async () => {
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: null },
      { id: 'sta_2', stationId: 'CS-002', isOnline: false, loadPriority: 5, circuitId: null },
    ]);
    setResult('connectors', []);
    setResult('chargingSessions', []);
    // sta_1 reports 11 kW (already kW). sta_2 has no reading.
    setResult('meterValues', [{ stationId: 'sta_1', value: '11', unit: 'kW', phase: null }]);
    setResult('evChargingNeeds', []);

    const result = await getSitePowerStatus('site-2');

    const s1 = result.stations.find((s) => s.stationId === 'CS-001');
    const s2 = result.stations.find((s) => s.stationId === 'CS-002');
    expect(s1?.currentDrawKw).toBe(11);
    expect(s1?.maxPowerKw).toBe(0);
    expect(s1?.hasActiveSession).toBe(false);
    expect(s2?.currentDrawKw).toBe(0);
    expect(s2?.phasePowerKw).toBeNull();
    expect(s2?.departureTime).toBeNull();
    expect(result.totalDrawKw).toBe(11);
  });

  it('converts unit-less readings from W to kW and ignores invalid phase labels', async () => {
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: null },
    ]);
    setResult('connectors', []);
    setResult('chargingSessions', []);
    setResult('meterValues', [
      { stationId: 'sta_1', value: '5000', unit: null, phase: null },
      { stationId: 'sta_1', value: '1000', unit: null, phase: 'L2' },
      { stationId: 'sta_1', value: '9999', unit: null, phase: 'L9' },
      // duplicate L2 reading is ignored (first-row-wins)
      { stationId: 'sta_1', value: '8888', unit: null, phase: 'L2' },
    ]);
    setResult('evChargingNeeds', [{ stationId: 'sta_1', departureTime: null }]);

    const result = await getSitePowerStatus('site-3');

    const s1 = result.stations[0];
    expect(s1?.currentDrawKw).toBe(5);
    expect(s1?.phasePowerKw).toEqual({ L1: 0, L2: 1, L3: 0 });
    expect(s1?.departureTime).toBeNull();
  });
});

describe('getSitePowerStatus per-EVSE draw', () => {
  it('sums the latest reading of each EVSE of a station', async () => {
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: null },
    ]);
    setResult('connectors', []);
    setResult('chargingSessions', []);
    // Two EVSEs charging: 7 kW + 11 kW. The older EVSE 1 reading is ignored.
    setResult('meterValues', [
      { stationId: 'sta_1', evseDbId: 'evse_1', value: '7000', unit: 'W', phase: null },
      { stationId: 'sta_1', evseDbId: 'evse_2', value: '11000', unit: 'W', phase: null },
      { stationId: 'sta_1', evseDbId: 'evse_1', value: '3000', unit: 'W', phase: null },
      { stationId: 'sta_1', evseDbId: null, value: '1000', unit: 'W', phase: null },
    ]);
    setResult('evChargingNeeds', []);

    const result = await getSitePowerStatus('site-evse');

    expect(result.stations[0]?.currentDrawKw).toBe(18);
  });
});

describe('buildSiteHierarchy', () => {
  it('returns empty array when the site has no panels', async () => {
    setResult('panels', []);

    const result = await buildSiteHierarchy('site-1', []);

    expect(result).toEqual([]);
  });

  it('builds a single-phase panel with a circuit and computes draw', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 200,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '40',
        safetyMarginKw: '2',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'Circuit A',
        breakerRatingAmps: 100,
        maxContinuousKw: '20',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', [
      { panelId: 'p1', circuitId: null, name: 'HVAC', estimatedDrawKw: '3' },
      { panelId: null, circuitId: 'c1', name: 'Lighting', estimatedDrawKw: '1' },
    ]);

    const station = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: 'c1',
      currentDrawKw: 5,
    });

    const result = await buildSiteHierarchy('site-1', [station]);

    expect(result).toHaveLength(1);
    const panel = result[0];
    expect(panel?.type).toBe('panel');
    expect(panel?.safetyMarginKw).toBe(2);
    expect(panel?.children).toHaveLength(1);
    const circuit = panel?.children[0];
    expect(circuit?.type).toBe('circuit');
    // circuit currentDraw = station 5 + circuit unmanaged 1 = 6
    expect(circuit?.currentDrawKw).toBe(6);
    expect(circuit?.unmanagedLoadKw).toBe(1);
    expect(circuit?.stations).toHaveLength(1);
    // panel draw = panel unmanaged 3 + circuit draw 6 = 9
    expect(panel?.currentDrawKw).toBe(9);
    expect(panel?.phaseLoad).toBeNull();
  });

  it('computes per-phase load on a three-phase panel and distributes circuit draw', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main3P',
        breakerRatingAmps: 100,
        voltageV: 400,
        phases: 3,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'L1 only',
        breakerRatingAmps: 50,
        maxContinuousKw: '30',
        phaseConnections: 'L1',
      },
      {
        id: 'c2',
        panelId: 'p1',
        name: 'All phases',
        breakerRatingAmps: 50,
        maxContinuousKw: '30',
        phaseConnections: 'L1L2L3',
      },
    ]);
    setResult('unmanagedLoads', []);

    const stationC1 = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: 'c1',
      currentDrawKw: 9,
    });
    const stationC2 = makeStation({
      id: 'sta_2',
      stationId: 'CS-002',
      circuitId: 'c2',
      currentDrawKw: 30,
    });

    const result = await buildSiteHierarchy('site-1', [stationC1, stationC2]);

    const panel = result[0];
    // perPhaseCapacityKw = 100 * 400 * 0.8 / 1000 = 32
    expect(panel?.perPhaseCapacityKw).toBeCloseTo(32, 6);
    // c1 (9 kW) all on L1. c2 (30 kW) split across L1/L2/L3 = 10 each.
    // L1 = 9 + 10 = 19, L2 = 10, L3 = 10
    expect(panel?.phaseLoad?.L1).toBeCloseTo(19, 6);
    expect(panel?.phaseLoad?.L2).toBeCloseTo(10, 6);
    expect(panel?.phaseLoad?.L3).toBeCloseTo(10, 6);
  });

  it('wires sub-panels under their parent and propagates phase load', async () => {
    setResult('panels', [
      {
        id: 'root',
        parentPanelId: null,
        name: 'Root',
        breakerRatingAmps: 200,
        voltageV: 400,
        phases: 3,
        maxContinuousKw: '200',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
      {
        id: 'sub',
        parentPanelId: 'root',
        name: 'Sub',
        breakerRatingAmps: 100,
        voltageV: 400,
        phases: 3,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'sub',
        name: 'Sub circuit',
        breakerRatingAmps: 50,
        maxContinuousKw: '30',
        phaseConnections: 'L1L2L3',
      },
    ]);
    setResult('unmanagedLoads', []);

    const station = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: 'c1',
      currentDrawKw: 30,
    });

    const result = await buildSiteHierarchy('site-1', [station]);

    // Only the root panel is a root node; sub is nested under it.
    expect(result).toHaveLength(1);
    const root = result[0];
    expect(root?.id).toBe('root');
    expect(root?.children).toHaveLength(1);
    expect(root?.children[0]?.id).toBe('sub');
    // root draw = sub draw = circuit 30
    expect(root?.currentDrawKw).toBe(30);
    // root phaseLoad propagated from sub: 30 split 3 ways = 10 each
    expect(root?.phaseLoad?.L1).toBeCloseTo(10, 6);
    expect(root?.phaseLoad?.L2).toBeCloseTo(10, 6);
    expect(root?.phaseLoad?.L3).toBeCloseTo(10, 6);
  });

  it('promotes a sub-panel to root when its parent is missing', async () => {
    setResult('panels', [
      {
        id: 'orphan',
        parentPanelId: 'ghost',
        name: 'Orphan',
        breakerRatingAmps: 100,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '50',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);

    const result = await buildSiteHierarchy('site-1', []);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('orphan');
  });

  it('falls back to default phases/voltage when a circuit has no parent panel', async () => {
    // A circuit referencing a panel id that is not in the panel set. parentPanel
    // is undefined so the node uses the phases=1 / voltage=240 fallbacks.
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 200,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '40',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'cOrphan',
        panelId: 'ghost-panel',
        name: 'Dangling circuit',
        breakerRatingAmps: 100,
        maxContinuousKw: '20',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', []);

    const result = await buildSiteHierarchy('site-1', []);

    // The orphan circuit is built but never wired under a panel (its panel is
    // missing), so the single real panel has no circuit children.
    const panel = result.find((n) => n.id === 'p1');
    expect(panel?.children).toHaveLength(0);
  });

  it('treats an unknown circuit phaseConnections as all three phases', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main3P',
        breakerRatingAmps: 100,
        voltageV: 400,
        phases: 3,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'Bogus phase',
        breakerRatingAmps: 50,
        maxContinuousKw: '30',
        phaseConnections: 'BOGUS',
      },
    ]);
    setResult('unmanagedLoads', []);

    const station = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: 'c1',
      currentDrawKw: 30,
    });

    const result = await buildSiteHierarchy('site-1', [station]);

    const panel = result[0];
    // Unknown phaseConnections falls back to L1L2L3, so 30 kW splits 10 per phase.
    expect(panel?.phaseLoad?.L1).toBeCloseTo(10, 6);
    expect(panel?.phaseLoad?.L2).toBeCloseTo(10, 6);
    expect(panel?.phaseLoad?.L3).toBeCloseTo(10, 6);
  });

  it('ignores stations that have no circuit assignment', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 200,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '40',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'Circuit A',
        breakerRatingAmps: 100,
        maxContinuousKw: '20',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', []);

    const unassigned = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: null,
      currentDrawKw: 5,
    });

    const result = await buildSiteHierarchy('site-1', [unassigned]);

    expect(result[0]?.children[0]?.stations).toHaveLength(0);
    expect(result[0]?.children[0]?.currentDrawKw).toBe(0);
  });
});

describe('buildLoadManagementProfile', () => {
  it('sends a ChargingStationMaxProfile on EVSE 0, never ChargingStationExternalConstraints', () => {
    const now = new Date('2026-10-13T12:00:30.500Z');
    const payload = buildLoadManagementProfile(22000, now) as {
      evseId: number;
      chargingProfile: Record<string, unknown> & {
        chargingSchedule: Array<Record<string, unknown>>;
      };
    };

    expect(payload.evseId).toBe(0);
    const profile = payload.chargingProfile;
    // OCPP 2.1 K01.FR.22: the CSMS SHALL NOT send ChargingStationExternalConstraints.
    expect(profile['chargingProfilePurpose']).toBe('ChargingStationMaxProfile');
    expect(profile['id']).toBe(LOAD_MANAGEMENT_PROFILE_ID);
    expect(profile['stackLevel']).toBe(1);
    expect(profile['chargingProfileKind']).toBe('Absolute');
    // K01.FR.40: an Absolute profile carries a startSchedule, here a minute back.
    expect(profile.chargingSchedule[0]?.['startSchedule']).toBe('2026-10-13T11:59:30.000Z');
    expect(profile.chargingSchedule[0]?.['chargingRateUnit']).toBe('W');
    expect(profile.chargingSchedule[0]?.['chargingSchedulePeriod']).toEqual([
      { startPeriod: 0, limit: 22000 },
    ]);
  });
});

describe('logAllocations', () => {
  it('writes the allocation log with the site capacity and what was left for the stations', async () => {
    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 22.5, currentDrawKw: 10 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 7.4, currentDrawKw: 3 },
    ];

    await logAllocations('site-1', allocations, { strategy: 'equal_share' }, 13, {
      siteLimitKw: 80,
      availableKw: 60,
    });

    expect(dbState.insertCalls).toHaveLength(1);
    const inserted = dbState.insertCalls[0];
    expect(inserted?.table).toBe('loadAllocationLog');
    const values = inserted?.values as Record<string, unknown>;
    expect(values['siteId']).toBe('site-1');
    expect(values['strategy']).toBe('equal_share');
    expect(values['siteLimitKw']).toBe('80');
    expect(values['availableKw']).toBe('60');
    expect(values['totalDrawKw']).toBe('13');
    expect(values['allocations']).toEqual([
      { stationId: 'CS-001', allocatedKw: 22.5, currentDrawKw: 10 },
      { stationId: 'CS-002', allocatedKw: 7.4, currentDrawKw: 3 },
    ]);
  });

  it('falls back to the allocated total without a capacity', async () => {
    await logAllocations('site-1', [], { strategy: 'equal_share' }, 4);

    const values = dbState.insertCalls[0]?.values as Record<string, unknown>;
    expect(values['siteLimitKw']).toBe('0');
    expect(values['totalDrawKw']).toBe('4');
    expect(values['allocations']).toEqual([]);
  });
});

describe('dispatchAllocations', () => {
  it('dispatches a charging profile per station and broadcasts the update', async () => {
    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 22.5, currentDrawKw: 10 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 7.4, currentDrawKw: 3 },
    ];
    const log = makeLogger();

    await expect(dispatchAllocations('site-1', allocations, log)).resolves.toBe(true);

    const ocppPublishes = pubsubState.publish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
    expect(ocppPublishes).toHaveLength(2);
    const payloads = ocppPublishes.map((c) => JSON.parse(c[1]));
    const p1 = payloads.find((p) => p.stationId === 'CS-001');
    const p2 = payloads.find((p) => p.stationId === 'CS-002');
    expect(p1.action).toBe('SetChargingProfile');
    expect(p1.payload.chargingProfile.chargingProfilePurpose).toBe('ChargingStationMaxProfile');
    // 22.5 kW -> 22500 W
    expect(p1.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].limit).toBe(
      22500,
    );
    expect(p2.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].limit).toBe(
      7400,
    );

    const broadcasts = pubsubState.publish.mock.calls.filter((c) => c[0] === 'csms_events');
    expect(broadcasts).toHaveLength(1);
    expect(JSON.parse(broadcasts[0]?.[1] as string)).toEqual({
      eventType: 'load.updated',
      siteId: 'site-1',
      stationId: null,
      sessionId: null,
    });
  });

  it('logs a failed publish, still broadcasts, and reports the failure', async () => {
    const log = makeLogger();
    pubsubState.publish.mockImplementation(async (channel: string) => {
      if (channel === 'ocpp_commands') {
        throw new Error('redis down');
      }
    });

    const result = await dispatchAllocations(
      'site-1',
      [{ stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 10, currentDrawKw: 0 }],
      log,
    );

    expect(result).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-001' }),
      'Failed to dispatch SetChargingProfile',
    );
    const broadcasts = pubsubState.publish.mock.calls.filter((c) => c[0] === 'csms_events');
    expect(broadcasts).toHaveLength(1);
  });

  it('swallows a failing csms_events broadcast (best-effort SSE)', async () => {
    const log = makeLogger();
    pubsubState.publish.mockImplementation(async (channel: string) => {
      if (channel === 'csms_events') {
        throw new Error('sse down');
      }
    });

    await expect(dispatchAllocations('site-1', [], log)).resolves.toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('clearLoadManagementProfiles', () => {
  it('clears the load management profile and its credit profile by id, once per station', async () => {
    const log = makeLogger();

    await expect(clearLoadManagementProfiles(['CS-001', 'CS-001', 'CS-002'], log)).resolves.toBe(
      true,
    );

    const clears = pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map(
        (c) => JSON.parse(c[1]) as { stationId: string; payload: { chargingProfileId: number } },
      );
    expect(clears.map((c) => `${c.stationId}:${String(c.payload.chargingProfileId)}`)).toEqual([
      `CS-001:${String(LOAD_MANAGEMENT_PROFILE_ID)}`,
      `CS-001:${String(LOAD_MANAGEMENT_PROFILE_ID + 1)}`,
      `CS-002:${String(LOAD_MANAGEMENT_PROFILE_ID)}`,
      `CS-002:${String(LOAD_MANAGEMENT_PROFILE_ID + 1)}`,
    ]);
    expect(clears[0]).toMatchObject({ stationId: 'CS-001', action: 'ClearChargingProfile' });
  });
});

describe('runLoadManagementCycle', () => {
  function panelRow(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
    return {
      parentPanelId: null,
      name: 'Panel',
      breakerRatingAmps: 200,
      voltageV: 240,
      phases: 1,
      maxContinuousKw: '100',
      safetyMarginKw: '0',
      oversubscriptionRatio: '1.0',
      ...overrides,
    };
  }

  function oneCircuitSite(stations: Array<Record<string, unknown>>): void {
    setResult('chargingStations', stations);
    setResult('connectors', [{ stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '100' }]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }]);
    setResult('meterValues', []);
    setResult('evChargingNeeds', []);
    setResult('panels', [panelRow({ id: 'p1', maxContinuousKw: '50' })]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'Circuit A',
        breakerRatingAmps: 100,
        maxContinuousKw: '40',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', []);
  }

  const station1 = {
    id: 'sta_1',
    stationId: 'CS-001',
    isOnline: true,
    loadPriority: 5,
    circuitId: 'c1',
  };
  const applied40 = [{ stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 40 }];

  interface PublishedCommand {
    stationId: string;
    action: string;
    payload: {
      chargingProfile: {
        chargingSchedule: Array<{ chargingSchedulePeriod: Array<{ limit: number }> }>;
      };
    };
  }

  function ocppPublishes(): PublishedCommand[] {
    return pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => JSON.parse(c[1]) as PublishedCommand);
  }

  it('applies allocations for an enabled site, records them, and logs the cycle', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-1',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    setResult('meterValues', [
      { stationId: 'sta_1', evseDbId: null, value: '4000', unit: 'W', phase: null },
    ]);
    const log = makeLogger();

    await runLoadManagementCycle(log, 'site-1');

    expect(dbState.insertCalls.some((c) => c.table === 'loadAllocationLog')).toBe(true);
    // Circuit available = 40, single station capped by maxPower 100 -> allocated 40 -> 40000 W
    const sent = ocppPublishes();
    expect(sent).toHaveLength(1);
    expect(
      sent[0]?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit,
    ).toBe(40000);
    // Recorded before sending, shared by every worker.
    const claim = dbState.updateCalls.find((c) => c.table === 'siteLoadManagement');
    expect(claim?.values['appliedAllocations']).toEqual(applied40);
    expect(claim?.values['appliedAt']).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1', strategy: 'equal_share', stationCount: 1 }),
      'Load management cycle applied',
    );
  });

  it('skips a site whose stored allocations match and were sent within the refresh interval', async () => {
    // Another worker process applied these: the decision reads the shared row,
    // not a per-process cache.
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-stable',
        strategy: 'equal_share',
        appliedAllocations: applied40,
        appliedAt: new Date(Date.now() - 30_000),
      },
    ]);
    oneCircuitSite([station1]);

    await runLoadManagementCycle(makeLogger(), 'site-stable');

    expect(dbState.insertCalls).toHaveLength(0);
    expect(dbState.updateCalls).toHaveLength(0);
    expect(pubsubState.publish).not.toHaveBeenCalled();
  });

  it('sends unchanged allocations again after the refresh interval, without a log row', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-stale',
        strategy: 'equal_share',
        appliedAllocations: applied40,
        appliedAt: new Date(Date.now() - LOAD_MANAGEMENT_REFRESH_MS - 1000),
      },
    ]);
    oneCircuitSite([station1]);

    await runLoadManagementCycle(makeLogger(), 'site-stale');

    expect(ocppPublishes()).toHaveLength(1);
    expect(dbState.insertCalls).toHaveLength(0);
  });

  it('sends again when the previous send failed (appliedAt null)', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-retry',
        strategy: 'equal_share',
        appliedAllocations: applied40,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);

    await runLoadManagementCycle(makeLogger(), 'site-retry');

    expect(ocppPublishes()).toHaveLength(1);
  });

  it('sends nothing when load management was turned off during the cycle', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-off',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    dbState.updateReturning.rows = [];

    await runLoadManagementCycle(makeLogger(), 'site-off');

    expect(pubsubState.publish).not.toHaveBeenCalled();
    expect(dbState.insertCalls).toHaveLength(0);
  });

  it('marks the send for retry when a publish fails', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-fail',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    pubsubState.publish.mockImplementation(async (channel: string) => {
      if (channel === 'ocpp_commands') throw new Error('redis down');
    });

    await runLoadManagementCycle(makeLogger(), 'site-fail');

    const last = dbState.updateCalls[dbState.updateCalls.length - 1];
    expect(last?.values['appliedAt']).toBeNull();
    expect(last?.values['appliedAllocations']).toEqual(applied40);
  });

  it('clears the limit of a station that left its circuit', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-moved',
        strategy: 'equal_share',
        appliedAllocations: [
          ...applied40,
          { stationId: 'CS-OLD', stationDbId: 'sta_old', allocatedKw: 10 },
        ],
        appliedAt: new Date(),
      },
    ]);
    oneCircuitSite([
      station1,
      { id: 'sta_old', stationId: 'CS-OLD', isOnline: true, loadPriority: 5, circuitId: null },
    ]);

    await runLoadManagementCycle(makeLogger(), 'site-moved');

    const clears = ocppPublishes().filter((c) => c.action === 'ClearChargingProfile');
    expect(clears).toHaveLength(2);
    expect(clears[0]).toMatchObject({
      stationId: 'CS-OLD',
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: LOAD_MANAGEMENT_PROFILE_ID },
    });
    expect(clears[1]).toMatchObject({
      stationId: 'CS-OLD',
      payload: { chargingProfileId: LOAD_MANAGEMENT_PROFILE_ID + 1 },
    });
  });

  it('keeps the last limit of an offline station with an active session out of the circuit', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-offline',
        strategy: 'equal_share',
        appliedAllocations: [
          { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 20 },
          { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 20 },
        ],
        appliedAt: new Date(),
      },
    ]);
    oneCircuitSite([
      station1,
      { id: 'sta_2', stationId: 'CS-002', isOnline: false, loadPriority: 5, circuitId: 'c1' },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }, { stationId: 'sta_2' }]);

    await runLoadManagementCycle(makeLogger(), 'site-offline');

    // CS-002 is offline and still charging at 20 kW: CS-001 gets 40 - 20 = 20, not 40.
    const sent = ocppPublishes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.stationId).toBe('CS-001');
    expect(
      sent[0]?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit,
    ).toBe(20000);
  });

  it('sends the limit in A per phase to a station that supports only A', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-amps',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    setResult('panels', [panelRow({ id: 'p1', maxContinuousKw: '500', phases: 3, voltageV: 230 })]);
    setResult('stationConfigurations', [{ stationId: 'sta_1', value: 'A' }]);

    await runLoadManagementCycle(makeLogger(), 'site-amps');

    const schedule = ocppPublishes()[0]?.payload.chargingProfile.chargingSchedule[0] as unknown as {
      chargingRateUnit: string;
      chargingSchedulePeriod: Array<{ limit: number }>;
    };
    // 40 kW on a three-phase 230 V circuit: 40000 / (230 x 3) = 57.97 A, rounded down.
    expect(schedule.chargingRateUnit).toBe('A');
    expect(schedule.chargingSchedulePeriod[0]?.limit).toBe(57.9);
  });

  it('sends its profile with an id above the station MaxExternalConstraintsId', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-maxext',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    setResult('stationConfigurations', [
      { stationId: 'sta_1', variable: 'MaxExternalConstraintsId', value: '2147400000' },
    ]);

    await runLoadManagementCycle(makeLogger(), 'site-maxext');

    const sent = ocppPublishes()[0] as unknown as { payload: { chargingProfile: { id: number } } };
    expect(sent.payload.chargingProfile.id).toBe(2147400001);
  });

  it('never queues a limit for an offline station (noQueue)', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-noqueue',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);

    await runLoadManagementCycle(makeLogger(), 'site-noqueue');

    const set = pubsubState.publish.mock.calls.find(
      (c) => c[0] === 'ocpp_commands' && c[1].includes('SetChargingProfile'),
    );
    expect(JSON.parse(set?.[1] ?? '{}')).toMatchObject({ noQueue: true });
  });

  it('clears the stations just sent when load management was turned off meanwhile', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-raced',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    oneCircuitSite([station1]);
    // The PUT turns it off right after the claim: the re-read finds it off.
    const realUpdate = dbState.db.update.getMockImplementation();
    if (realUpdate == null) throw new Error('db.update has no implementation');
    dbState.db.update.mockImplementationOnce((table: { __table?: string }) => {
      setResult('siteLoadManagement', [{ isEnabled: false }]);
      return realUpdate(table);
    });

    await runLoadManagementCycle(makeLogger(), 'site-raced');

    const actions = ocppPublishes().map((c) => `${c.action}:${c.stationId}`);
    expect(actions).toEqual([
      'SetChargingProfile:CS-001',
      'ClearChargingProfile:CS-001',
      'ClearChargingProfile:CS-001',
    ]);
  });

  it('treats a station with an unconfirmed limit as a fixed load and retries in the other unit', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-pending',
        strategy: 'equal_share',
        appliedAllocations: [
          { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 20 },
          {
            stationId: 'CS-002',
            stationDbId: 'sta_2',
            allocatedKw: 20,
            limitPending: true,
            rejectedUnits: ['W'],
          },
        ],
        appliedAt: null,
      },
    ]);
    oneCircuitSite([
      station1,
      { id: 'sta_2', stationId: 'CS-002', isOnline: true, loadPriority: 5, circuitId: 'c1' },
    ]);
    setResult('connectors', [
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '100' },
      { stationId: 'sta_2', evseDbId: 'evse_2', maxPowerKw: '11' },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }, { stationId: 'sta_2' }]);

    await runLoadManagementCycle(makeLogger(), 'site-pending');

    const sent = ocppPublishes() as unknown as Array<{
      stationId: string;
      payload: {
        chargingProfile: {
          chargingSchedule: Array<{
            chargingRateUnit: string;
            chargingSchedulePeriod: Array<{ limit: number }>;
          }>;
        };
      };
    }>;
    const byStation = new Map(sent.map((c) => [c.stationId, c.payload.chargingProfile]));
    // CS-002 keeps its 11 kW maximum: CS-001 gets 40 - 11 = 29 kW.
    expect(byStation.get('CS-001')?.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit).toBe(
      29000,
    );
    // CS-002 rejected W: it is sent its reservation in A (11000 / 240 = 45.8 A).
    const retry = byStation.get('CS-002')?.chargingSchedule[0];
    expect(retry?.chargingRateUnit).toBe('A');
    expect(retry?.chargingSchedulePeriod[0]?.limit).toBe(45.8);
    // The reply state is carried in the recorded allocations.
    const claim = dbState.updateCalls.find((c) => c.table === 'siteLoadManagement');
    expect(claim?.values['appliedAllocations']).toEqual([
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 29 },
      {
        stationId: 'CS-002',
        stationDbId: 'sta_2',
        allocatedKw: 11,
        reserved: true,
        limitPending: true,
        rejectedUnits: ['W'],
      },
    ]);
  });

  it('reserves the last accepted limit of an offline station when it is higher', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-accepted',
        strategy: 'equal_share',
        appliedAllocations: [
          { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 30 },
          { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 10 },
        ],
        appliedAt: null,
      },
    ]);
    oneCircuitSite([
      station1,
      { id: 'sta_2', stationId: 'CS-002', isOnline: false, loadPriority: 5, circuitId: 'c1' },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }, { stationId: 'sta_2' }]);
    // The cut to 10 kW never reached CS-002: it still holds the 15 kW it accepted.
    setResult('chargingProfiles', [
      {
        stationId: 'sta_2',
        profileData: buildLoadManagementProfile(15_000, new Date())['chargingProfile'],
      },
    ]);

    await runLoadManagementCycle(makeLogger(), 'site-accepted');

    const sent = ocppPublishes();
    expect(sent).toHaveLength(1);
    expect(
      sent[0]?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit,
    ).toBe(25000);
  });

  it('produces empty allocations when the site has no panels configured', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-nopanels',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: null },
    ]);
    setResult('connectors', []);
    setResult('chargingSessions', []);
    setResult('meterValues', []);
    setResult('evChargingNeeds', []);
    setResult('panels', []);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);

    await runLoadManagementCycle(makeLogger(), 'site-nopanels');

    expect(dbState.insertCalls.some((c) => c.table === 'loadAllocationLog')).toBe(true);
    expect(ocppPublishes()).toHaveLength(0);
  });

  it('catches per-site errors and continues the loop', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-broken',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    const defaultSelect = dbState.makeSelectFactory();
    let selectCount = 0;
    dbState.db.select.mockImplementation(() => {
      selectCount += 1;
      if (selectCount === 2) {
        throw new Error('db exploded');
      }
      return defaultSelect();
    });
    const log = makeLogger();

    await expect(runLoadManagementCycle(log, 'site-broken')).resolves.toEqual({ failedSites: 1 });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-broken' }),
      'Load management cycle failed',
    );
  });

  it('runs across all enabled sites when no target site is given', async () => {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-a',
        strategy: 'equal_share',
        appliedAllocations: null,
        appliedAt: null,
      },
      {
        isEnabled: true,
        siteId: 'site-b',
        strategy: 'priority_based',
        appliedAllocations: null,
        appliedAt: null,
      },
    ]);
    setResult('chargingStations', []);
    setResult('panels', []);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);

    await runLoadManagementCycle(makeLogger());

    const logInserts = dbState.insertCalls.filter((c) => c.table === 'loadAllocationLog');
    expect(logInserts).toHaveLength(2);
  });
});

describe('stationMaxPowerKw', () => {
  it('takes the highest connector of each EVSE and sums the EVSEs', () => {
    const result = stationMaxPowerKw([
      // EVSE 1: CCS 50 kW and CHAdeMO 25 kW cannot charge together -> 50
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '50' },
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '25' },
      // EVSE 2: 22 kW, one connector without a rating -> 22
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: '22' },
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: null },
    ]);

    expect(result.get('sta_1')).toBe(72);
  });

  it('reads a station with an EVSE of unknown power as unknown (0)', () => {
    const result = stationMaxPowerKw([
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '50' },
      { stationId: 'sta_1', evseDbId: 'evse_2', maxPowerKw: null },
    ]);

    expect(result.get('sta_1')).toBe(0);
  });
});

describe('load management profile id (K01.FR.80)', () => {
  it('stays above the station MaxExternalConstraintsId', () => {
    expect(loadManagementProfileId(null)).toBe(LOAD_MANAGEMENT_PROFILE_ID);
    expect(loadManagementProfileId('77')).toBe(LOAD_MANAGEMENT_PROFILE_ID);
    expect(loadManagementProfileId('2147400000')).toBe(2147400001);
    expect(loadManagementProfileId('not-a-number')).toBe(LOAD_MANAGEMENT_PROFILE_ID);
  });

  it('clears a station profile by its own id', async () => {
    setResult('stationConfigurations', [{ stationId: 'CS-001', value: '2147400000' }]);

    await clearLoadManagementProfiles(['CS-001'], makeLogger());

    const clear = pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => JSON.parse(c[1]) as { payload: { chargingProfileId: number } });
    expect(clear[0]?.payload.chargingProfileId).toBe(2147400001);
  });
});

describe('minimum charge rates', () => {
  it('stops the lowest priority sessions when the minimums do not fit (equal share)', () => {
    const result = computeEqualShareAllocation(
      [
        makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, minPowerKw: 8 }),
        makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 5, minPowerKw: 8 }),
        makeStation({ id: 's3', stationId: 'CS-003', loadPriority: 1, minPowerKw: 8 }),
      ],
      20,
    );
    const kw = Object.fromEntries(result.map((r) => [r.stationId, r.allocatedKw]));
    // 3 x 8 > 20: CS-003 (lowest priority) stops, the others share 20.
    expect(kw).toEqual({ 'CS-001': 10, 'CS-002': 10, 'CS-003': 0 });
  });

  it('gives every session its minimum before a higher priority takes the rest', () => {
    const result = computePriorityAllocation(
      [
        makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, minPowerKw: 6 }),
        makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 1, minPowerKw: 6 }),
      ],
      30,
    );
    const kw = Object.fromEntries(result.map((r) => [r.stationId, r.allocatedKw]));
    expect(kw).toEqual({ 'CS-001': 24, 'CS-002': 6 });
  });

  it('cuts a panel above the minimums, then stops the lowest priority', () => {
    const circuit = (id: string, station: StationPowerInfo): HierarchyNode => ({
      type: 'circuit',
      id,
      name: id,
      maxContinuousKw: 50,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [station],
      children: [],
      phases: 1,
      breakerRatingAmps: 100,
      voltageV: 240,
      oversubscriptionRatio: 1,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
    });
    const panel = (maxContinuousKw: number): HierarchyNode => ({
      ...circuit('p', makeStation({ id: 'x', stationId: 'X' })),
      type: 'panel',
      id: 'p1',
      maxContinuousKw,
      stations: [],
      children: [
        circuit(
          'cA',
          makeStation({ id: 's1', stationId: 'CS-001', loadPriority: 10, minPowerKw: 6 }),
        ),
        circuit(
          'cB',
          makeStation({ id: 's2', stationId: 'CS-002', loadPriority: 1, minPowerKw: 6 }),
        ),
      ],
    });

    // 15 kW: both keep 6 kW and share the 3 kW above it.
    const fits = computeHierarchicalAllocation([panel(15)], 'equal_share');
    expect(fits.map((r) => r.allocatedKw)).toEqual([7.5, 7.5]);

    // 10 kW: two minimums (12) do not fit, CS-002 stops and CS-001 gets all 10.
    const tight = Object.fromEntries(
      computeHierarchicalAllocation([panel(10)], 'equal_share').map((r) => [
        r.stationId,
        r.allocatedKw,
      ]),
    );
    expect(tight['CS-001']).toBeCloseTo(10, 9);
    expect(tight['CS-002']).toBe(0);
  });
});

describe('charging rate unit', () => {
  it('uses W unless the station supports only A', () => {
    expect(chargingRateUnitFor([])).toBe('W');
    expect(chargingRateUnitFor(['A,W'])).toBe('W');
    expect(chargingRateUnitFor(['Current,Power'])).toBe('W');
    expect(chargingRateUnitFor(['A'])).toBe('A');
    expect(chargingRateUnitFor(['Current'])).toBe('A');
  });

  it('converts a W limit to the phase current of the circuit, rounded down', () => {
    expect(limitInUnit(6900, { rateUnit: 'A', voltageV: 230, phases: 3 })).toBe(10);
    expect(limitInUnit(6900, { rateUnit: 'A', voltageV: 230, phases: 1 })).toBe(30);
    expect(limitInUnit(6900, { rateUnit: 'W', voltageV: 230, phases: 1 })).toBe(6900);
  });
});

describe('offlineReservations', () => {
  it('keeps the last limit, else the max power, of offline stations with a session', () => {
    const reserved = offlineReservations(
      [
        makeStation({ id: 's1', stationId: 'CS-001', isOnline: false, maxPowerKw: 22 }),
        makeStation({ id: 's2', stationId: 'CS-002', isOnline: false, maxPowerKw: 11 }),
        makeStation({ id: 's3', stationId: 'CS-003', isOnline: false, hasActiveSession: false }),
        makeStation({ id: 's4', stationId: 'CS-004', isOnline: true }),
      ],
      [{ stationId: 'CS-001', stationDbId: 's1', allocatedKw: 7 }],
    );

    expect([...reserved]).toEqual([
      ['s1', 7],
      ['s2', 11],
    ]);
  });

  it('keeps the higher of the last sent and the last accepted limit', () => {
    const reserved = offlineReservations(
      [
        makeStation({ id: 's1', stationId: 'CS-001', isOnline: false, maxPowerKw: 22 }),
        makeStation({ id: 's2', stationId: 'CS-002', isOnline: false, maxPowerKw: 22 }),
        makeStation({ id: 's3', stationId: 'CS-003', isOnline: false, maxPowerKw: 22 }),
      ],
      [
        { stationId: 'CS-001', stationDbId: 's1', allocatedKw: 7 },
        { stationId: 'CS-002', stationDbId: 's2', allocatedKw: 12 },
      ],
      new Map([
        ['s1', 11],
        ['s2', 9],
        ['s3', 4],
      ]),
    );

    // s1: the cut to 7 never reached it, it holds 11. s2: sent 12. s3: only accepted 4.
    expect([...reserved]).toEqual([
      ['s1', 11],
      ['s2', 12],
      ['s3', 4],
    ]);
  });
});

describe('charging rate unit on multi-phase circuits', () => {
  it('uses A on a circuit of two or three conductor phases when the station supports A', () => {
    expect(chargingRateUnitFor(['A,W'], 3)).toBe('A');
    expect(chargingRateUnitFor(['Current,Power'], 2)).toBe('A');
    expect(chargingRateUnitFor(['A,W'], 1)).toBe('W');
    // W only, or nothing reported: W.
    expect(chargingRateUnitFor(['W'], 3)).toBe('W');
    expect(chargingRateUnitFor([], 3)).toBe('W');
  });

  it('lists the units a station reports', () => {
    expect(supportedRateUnits(['Current,Power'])).toEqual(['A', 'W']);
    expect(supportedRateUnits(['W'])).toEqual(['W']);
    expect(supportedRateUnits([])).toEqual([]);
  });

  it('sets A on stations of a three-phase circuit that support A', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main3P',
        breakerRatingAmps: 100,
        voltageV: 230,
        phases: 3,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'Three phase',
        breakerRatingAmps: 32,
        maxContinuousKw: '17.6',
        phaseConnections: null,
      },
      {
        id: 'c2',
        panelId: 'p1',
        name: 'L1 only',
        breakerRatingAmps: 32,
        maxContinuousKw: '5.8',
        phaseConnections: 'L1',
      },
    ]);
    setResult('unmanagedLoads', []);
    const both = makeStation({
      id: 'sta_1',
      stationId: 'CS-001',
      circuitId: 'c1',
      supportedRateUnits: ['A', 'W'],
    });
    const single = makeStation({
      id: 'sta_2',
      stationId: 'CS-002',
      circuitId: 'c2',
      supportedRateUnits: ['A', 'W'],
    });
    const wOnly = makeStation({
      id: 'sta_3',
      stationId: 'CS-003',
      circuitId: 'c1',
      supportedRateUnits: ['W'],
    });

    await buildSiteHierarchy('site-1', [both, single, wOnly]);

    expect(both.rateUnit).toBe('A');
    expect(single.rateUnit).toBe('W');
    expect(wOnly.rateUnit).toBe('W');
  });
});

describe('unconfirmed load management limits', () => {
  it('reserves the maximum power or the measured draw of a station with a pending limit', () => {
    const reserved = unconfirmedReservations(
      [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 22, currentDrawKw: 5 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 0, currentDrawKw: 9 }),
        makeStation({ id: 's3', stationId: 'CS-003', maxPowerKw: 11, hasActiveSession: false }),
        makeStation({ id: 's4', stationId: 'CS-004', maxPowerKw: 50 }),
      ],
      [
        { stationId: 'CS-001', stationDbId: 's1', allocatedKw: 7, limitPending: true },
        { stationId: 'CS-002', stationDbId: 's2', allocatedKw: 7, limitPending: true },
        { stationId: 'CS-003', stationDbId: 's3', allocatedKw: 7, limitPending: true },
        { stationId: 'CS-004', stationDbId: 's4', allocatedKw: 7, rejectedUnits: ['W'] },
      ],
    );

    expect([...reserved]).toEqual([
      ['s1', 22],
      ['s2', 9],
      ['s3', 11],
    ]);
  });

  it('picks a unit the station has not rejected, else its preferred one', () => {
    const station = { rateUnit: 'W' as const, supportedRateUnits: [] };
    expect(sendRateUnit(station, [])).toBe('W');
    expect(sendRateUnit(station, ['W'])).toBe('A');
    expect(sendRateUnit(station, ['W', 'A'])).toBe('W');
    // A station that reports W only is never sent A.
    expect(sendRateUnit({ rateUnit: 'W', supportedRateUnits: ['W'] }, ['W'])).toBe('W');
    expect(sendRateUnit({ rateUnit: 'A', supportedRateUnits: ['A', 'W'] }, ['A'])).toBe('W');
  });

  it('reads the reply state of applied allocations', () => {
    expect(
      parseAppliedAllocations([
        {
          stationId: 'CS-001',
          stationDbId: 's1',
          allocatedKw: 7,
          reserved: true,
          limitPending: true,
          rejectedUnits: ['W', 'kW'],
        },
      ]),
    ).toEqual([
      {
        stationId: 'CS-001',
        stationDbId: 's1',
        allocatedKw: 7,
        reserved: true,
        limitPending: true,
        rejectedUnits: ['W'],
      },
    ]);
  });

  it('recognizes the load management profile and reads its limit', () => {
    const profile = buildLoadManagementProfile(11_000, new Date('2026-01-01T00:00:00Z'))[
      'chargingProfile'
    ];
    expect(isLoadManagementProfile(profile)).toBe(true);
    expect(profileRateUnit(profile)).toBe('W');
    expect(profileLimitKw(profile, undefined)).toBe(11);
    expect(
      isLoadManagementProfile({
        id: LOAD_MANAGEMENT_PROFILE_ID,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
      }),
    ).toBe(false);
    expect(
      isLoadManagementProfile({
        id: 100,
        stackLevel: 1,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
      }),
    ).toBe(false);
    const amps = {
      id: LOAD_MANAGEMENT_PROFILE_ID,
      stackLevel: 1,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      chargingSchedule: [{ chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 10 }] }],
    };
    // 10 A x 230 V x 3 phases = 6.9 kW.
    expect(profileLimitKw(amps, { rateUnit: 'A', voltageV: 230, phases: 3 })).toBeCloseTo(6.9, 6);
    expect(profileLimitKw(amps, undefined)).toBeNull();
  });

  it('reads the last accepted limit of each station from its stored profile', async () => {
    setResult('chargingProfiles', [
      {
        stationId: 's1',
        profileData: {
          id: LOAD_MANAGEMENT_PROFILE_ID,
          stackLevel: 1,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingSchedule: [{ chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 9000 }] }],
        },
      },
      {
        // Another profile of the station: ignored.
        stationId: 's1',
        profileData: {
          id: 7,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingSchedule: [{ chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 50000 }] }],
        },
      },
    ]);

    const accepted = await lastAcceptedLimitsKw(
      [makeStation({ id: 's1', stationId: 'CS-001', isOnline: false })],
      new Map(),
    );

    expect([...accepted]).toEqual([['s1', 9]]);
  });
});

describe('circuit voltage, sub-panel phases and send order', () => {
  function node(
    overrides: Partial<HierarchyNode> & Pick<HierarchyNode, 'type' | 'id'>,
  ): HierarchyNode {
    return {
      name: overrides.id,
      maxContinuousKw: 100,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [],
      children: [],
      phases: 1,
      breakerRatingAmps: 100,
      voltageV: 240,
      oversubscriptionRatio: 1.0,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
      ...overrides,
    };
  }

  function total(results: AllocationResult[]): number {
    return results.reduce((sum, r) => sum + r.allocatedKw, 0);
  }

  it('uses the circuit voltage of a 120 V branch for its limits in A', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 100,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '19.2',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: '120 V branch',
        breakerRatingAmps: 20,
        maxContinuousKw: '1.92',
        phaseConnections: null,
        voltageV: 120,
      },
    ]);
    setResult('unmanagedLoads', []);
    const station = makeStation({ id: 'sta_1', stationId: 'CS-001', circuitId: 'c1' });

    const roots = await buildSiteHierarchy('site-1', [station]);
    const circuit = roots[0]?.children[0];
    expect(circuit?.voltageV).toBe(120);
    expect(circuit?.ownVoltageV).toBe(120);

    const rate = stationRates(roots).get('sta_1');
    expect(rate?.voltageV).toBe(120);
    // 1440 W at 120 V is 12 A (at 240 V it would be 6 A).
    expect(limitInUnit(1440, rate && { ...rate, rateUnit: 'A' })).toBe(12);
  });

  it('ignores a circuit voltage on a three-phase panel', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 100,
        voltageV: 230,
        phases: 3,
        maxContinuousKw: '55.2',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'C1',
        breakerRatingAmps: 32,
        maxContinuousKw: '17.664',
        phaseConnections: null,
        voltageV: 120,
      },
    ]);
    setResult('unmanagedLoads', []);

    const roots = await buildSiteHierarchy('site-1', []);
    expect(roots[0]?.children[0]?.voltageV).toBe(230);
  });

  it('counts a 120 V circuit on one leg of a 240 V split-phase panel', () => {
    // 100 A x 240 V x 0.8 = 19.2 kW. A 120 V circuit draws its current from
    // one leg: 9.6 kW at 120 V is the full 80 A of that leg.
    const branch = node({
      type: 'circuit',
      id: 'c1',
      voltageV: 120,
      stations: [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 50 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 50 }),
      ],
    });
    const panel = node({ type: 'panel', id: 'p1', maxContinuousKw: 19.2, children: [branch] });

    const results = computeHierarchicalAllocation([panel], 'equal_share');
    expect(total(results)).toBeCloseTo(9.6, 6);
  });

  it('keeps the panel check unchanged for circuits at the panel voltage', () => {
    const circuit = node({
      type: 'circuit',
      id: 'c1',
      stations: [
        makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 50 }),
        makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 50 }),
      ],
    });
    const panel = node({ type: 'panel', id: 'p1', maxContinuousKw: 19.2, children: [circuit] });

    const results = computeHierarchicalAllocation([panel], 'equal_share');
    expect(total(results)).toBeCloseTo(19.2, 6);
  });

  function threePhaseSite(subPanelPhases: string | null): HierarchyNode {
    const l2Circuit = node({
      type: 'circuit',
      id: 'c-l2',
      phases: 3,
      voltageV: 230,
      phaseConnections: 'L2',
      stations: [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 10 })],
    });
    const subCircuit = node({
      type: 'circuit',
      id: 'c-sub',
      voltageV: 230,
      stations: [makeStation({ id: 's2', stationId: 'CS-002', maxPowerKw: 10 })],
    });
    const subPanel = node({
      type: 'panel',
      id: 'p-sub',
      voltageV: 230,
      maxContinuousKw: 100,
      phaseConnections: subPanelPhases,
      children: [subCircuit],
    });
    return node({
      type: 'panel',
      id: 'p-main',
      phases: 3,
      voltageV: 230,
      maxContinuousKw: 30,
      perPhaseCapacityKw: 10,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [l2Circuit, subPanel],
    });
  }

  it('counts a single-phase sub-panel without phases on every parent phase', () => {
    const results = computeHierarchicalAllocation([threePhaseSite(null)], 'equal_share');
    // L2 carries the L2 circuit and the whole sub-panel: both cut to 5 kW.
    expect(results.find((r) => r.stationDbId === 's1')?.allocatedKw).toBeCloseTo(5, 6);
    expect(results.find((r) => r.stationDbId === 's2')?.allocatedKw).toBeCloseTo(5, 6);
  });

  it('counts a sub-panel fed from L1 on L1 only', () => {
    const results = computeHierarchicalAllocation([threePhaseSite('L1')], 'equal_share');
    expect(results.find((r) => r.stationDbId === 's1')?.allocatedKw).toBeCloseTo(10, 6);
    expect(results.find((r) => r.stationDbId === 's2')?.allocatedKw).toBeCloseTo(10, 6);
  });

  it('cuts a sub-panel fed from L2 together with the L2 circuit', () => {
    const results = computeHierarchicalAllocation([threePhaseSite('L2')], 'equal_share');
    expect(total(results)).toBeCloseTo(10, 6);
  });

  it('orders limit cuts before raises', () => {
    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 20, currentDrawKw: 0 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 5, currentDrawKw: 0 },
      { stationId: 'CS-003', stationDbId: 'sta_3', allocatedKw: 7, currentDrawKw: 0 },
      { stationId: 'CS-004', stationDbId: 'sta_4', allocatedKw: 8, currentDrawKw: 0 },
    ];
    const previousKw = new Map([
      ['sta_1', 10],
      ['sta_2', 20],
      ['sta_4', 8],
    ]);

    const { cuts, raises } = orderLimitChanges(allocations, previousKw);
    // sta_3 holds no known limit (unlimited) and sta_4 keeps its own: both
    // go with the cuts.
    expect(cuts.map((a) => a.stationDbId)).toEqual(['sta_2', 'sta_3', 'sta_4']);
    expect(raises.map((a) => a.stationDbId)).toEqual(['sta_1']);
  });

  it('publishes every cut before any raise', async () => {
    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 20, currentDrawKw: 0 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 5, currentDrawKw: 0 },
    ];
    const previousKw = new Map([
      ['sta_1', 10],
      ['sta_2', 20],
    ]);

    await expect(
      dispatchAllocations('site-1', allocations, makeLogger(), new Date(), new Map(), previousKw),
    ).resolves.toBe(true);

    const order = pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => (JSON.parse(c[1]) as { stationId: string }).stationId);
    expect(order).toEqual(['CS-002', 'CS-001']);
  });

  it('holds the raises back when a cut fails to publish', async () => {
    pubsubState.publish.mockImplementation(async (channel: string, message: string) => {
      if (channel === 'ocpp_commands' && message.includes('CS-002')) {
        throw new Error('redis down');
      }
    });
    const log = makeLogger();

    const result = await dispatchAllocations(
      'site-1',
      [
        { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 20, currentDrawKw: 0 },
        { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 5, currentDrawKw: 0 },
      ],
      log,
      new Date(),
      new Map(),
      new Map([
        ['sta_1', 10],
        ['sta_2', 20],
      ]),
    );

    expect(result).toBe(false);
    const sent = pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => (JSON.parse(c[1]) as { stationId: string }).stationId);
    expect(sent).toEqual(['CS-002']);
    expect(log.warn).toHaveBeenCalledWith(
      { siteId: 'site-1', raiseCount: 1 },
      'Load management limit raises held back after a failed cut',
    );
  });
});

describe('transformers and battery and solar supply', () => {
  function node(overrides: Partial<HierarchyNode>): HierarchyNode {
    return {
      type: 'panel',
      id: 'p',
      name: 'Node',
      maxContinuousKw: 100,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [],
      children: [],
      phases: 1,
      breakerRatingAmps: 100,
      voltageV: 240,
      oversubscriptionRatio: 1,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
      ...overrides,
    };
  }
  const circuitWith = (id: string, maxKw: number, stationKw: number): HierarchyNode =>
    node({
      type: 'circuit',
      id: `c-${id}`,
      maxContinuousKw: maxKw,
      stations: [makeStation({ id, stationId: id, maxPowerKw: stationKw })],
    });
  const board = (id: string, maxKw: number, children: HierarchyNode[]): HierarchyNode =>
    node({ id, maxContinuousKw: maxKw, children });
  const transformerNode = (overrides: Partial<HierarchyNode>): HierarchyNode =>
    node({ type: 'transformer', transformerKind: 'service', breakerRatingAmps: 0, ...overrides });
  const total = (results: AllocationResult[]): number =>
    results.reduce((sum, r) => sum + r.allocatedKw, 0);

  it('scales two switchboards to the transformer above them', () => {
    const tx = transformerNode({
      id: 'tfm_1',
      maxContinuousKw: 300,
      children: [
        board('b1', 200, [circuitWith('a', 200, 180)]),
        board('b2', 200, [circuitWith('b', 200, 180)]),
      ],
    });
    const out = computeHierarchicalAllocation([tx], 'equal_share');
    expect(total(out)).toBeCloseTo(300, 6);
    for (const r of out) expect(r.allocatedKw).toBeCloseTo(150, 6);
  });

  it('keeps a lower node within its own limit when the node above has a credit', () => {
    // Solar of 50 kW load-side on b1: b1 itself gets no credit (D8), so a
    // single station below it stays at 100; two boards share 150 under it.
    const single = transformerNode({
      maxContinuousKw: 100,
      supplyCreditKw: 50,
      children: [board('b1', 100, [circuitWith('a', 200, 200)])],
    });
    expect(total(computeHierarchicalAllocation([single], 'equal_share'))).toBeCloseTo(100, 6);

    const two = transformerNode({
      maxContinuousKw: 100,
      supplyCreditKw: 50,
      children: [
        board('b1', 100, [circuitWith('a', 200, 200)]),
        board('b2', 100, [circuitWith('b', 200, 200)]),
      ],
    });
    expect(total(computeHierarchicalAllocation([two], 'equal_share'))).toBeCloseTo(150, 6);
  });

  it('never raises a node above what its children can carry', () => {
    const tx = transformerNode({
      maxContinuousKw: 100,
      supplyCreditKw: 500,
      children: [board('b1', 120, [circuitWith('a', 200, 200)])],
    });
    expect(nodeCapacityKw(tx)).toBe(120);
    // Without a credit the capacity is unchanged, even above the children.
    expect(
      nodeCapacityKw(transformerNode({ maxContinuousKw: 400, children: [board('b', 50, [])] })),
    ).toBe(400);
  });

  it('counts a battery load at its node and every node above it', () => {
    const b1 = board('b1', 100, [circuitWith('a', 200, 200)]);
    b1.supplyLoadKw = 30;
    const tx = transformerNode({
      maxContinuousKw: 120,
      children: [b1, board('b2', 100, [circuitWith('b', 200, 200)])],
    });
    const out = computeHierarchicalAllocation([tx], 'equal_share');
    // b1: 100 - 30 = 70 for its station; the transformer: 120 - 30 = 90 for both.
    expect(total(out)).toBeCloseTo(90, 6);
    expect(out.find((r) => r.stationDbId === 'a')?.allocatedKw).toBeLessThanOrEqual(70 + 1e-9);
  });

  it('maps a step-down secondary phase onto two primary phases at 1/sqrt(3)', () => {
    const primary = stepDownPrimaryPhases({ L1: 30, L2: 0, L3: 0 });
    expect(primary.L1).toBeCloseTo(30 / Math.sqrt(3), 9);
    expect(primary.L2).toBeCloseTo(30 / Math.sqrt(3), 9);
    expect(primary.L3).toBe(0);
    const balanced = stepDownPrimaryPhases({ L1: 10, L2: 10, L3: 10 });
    expect(balanced.L1).toBeCloseTo(20 / Math.sqrt(3), 9);
  });

  it('cuts a balanced load below a step-down transformer by the primary phase mapping (D16)', () => {
    const circuit = node({
      type: 'circuit',
      id: 'c3',
      maxContinuousKw: 1000,
      phases: 3,
      phaseConnections: 'L1L2L3',
      stations: [makeStation({ id: 's3', stationId: 's3', maxPowerKw: 54 })],
    });
    const sub = node({
      id: 'sub',
      maxContinuousKw: 1000,
      phases: 3,
      voltageV: 120,
      perPhaseCapacityKw: 333,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [circuit],
    });
    const stepDown = node({
      type: 'transformer',
      transformerKind: 'step_down',
      id: 'tfm_sd',
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 333,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [sub],
    });
    const main = node({
      id: 'main',
      maxContinuousKw: 60,
      phases: 3,
      voltageV: 277,
      perPhaseCapacityKw: 20,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      children: [stepDown],
    });
    // Secondary 18 kW a phase counts 36 / sqrt(3) = 20.78 kW on each primary
    // phase, so the station is cut to 54 x 20 / 20.78.
    const out = computeHierarchicalAllocation([main], 'equal_share');
    expect(out[0]?.allocatedKw).toBeCloseTo((54 * 20) / (36 / Math.sqrt(3)), 6);

    // The same sub-panel directly below the main panel keeps 1:1 (18 <= 20).
    const direct = node({
      ...main,
      children: [node({ ...sub, children: [node({ ...circuit })] })],
    });
    expect(computeHierarchicalAllocation([direct], 'equal_share')[0]?.allocatedKw).toBeCloseTo(
      54,
      6,
    );
  });

  it('adds the per-phase credit of a three-phase asset to the phase limits', () => {
    const circuit = node({
      type: 'circuit',
      id: 'c1',
      maxContinuousKw: 1000,
      phases: 3,
      phaseConnections: 'L1',
      stations: [makeStation({ id: 's1', stationId: 's1', maxPowerKw: 30 })],
    });
    const main = node({
      maxContinuousKw: 1000,
      phases: 3,
      perPhaseCapacityKw: 20,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      supplyCreditKw: 15,
      supplyPhaseCreditKw: { L1: 5, L2: 5, L3: 5 },
      children: [node({ maxContinuousKw: 1000, phases: 3, children: [circuit] })],
    });
    expect(computeHierarchicalAllocation([main], 'equal_share')[0]?.allocatedKw).toBeCloseTo(25, 6);
  });

  it('summarizes the transformer capacity plus the credit it used', () => {
    const b1 = board('b1', 100, [circuitWith('a', 200, 200)]);
    b1.energyAssets = [
      {
        id: 'ena_1',
        name: 'Solar',
        type: 'solar',
        phases: 3,
        telemetry: 'api',
        connection: 'panel',
        state: 'fresh',
        creditKw: 40,
        loadKw: 0,
        creditApplied: true,
        readingReceivedAt: new Date(),
        socPercent: null,
        freshUntil: null,
      },
    ];
    const tx = transformerNode({
      maxContinuousKw: 100,
      safetyMarginKw: 10,
      supplyCreditKw: 40,
      children: [b1, board('b2', 100, [circuitWith('b', 200, 200)])],
    });
    expect(summarizeSiteCapacity([tx], new Map())).toEqual({
      siteLimitKw: 130,
      availableKw: 130,
      supplyCreditKw: 40,
    });
  });

  describe('buildSiteHierarchy', () => {
    const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
    const panelRow = (
      overrides: Record<string, unknown> & { id: string },
    ): Record<string, unknown> => ({
      parentPanelId: null,
      name: overrides.id,
      breakerRatingAmps: 400,
      voltageV: 277,
      phases: 3,
      maxContinuousKw: '200',
      safetyMarginKw: '0',
      oversubscriptionRatio: '1.0',
      phaseConnections: null,
      transformerId: null,
      ...overrides,
    });
    const transformerRow = (
      overrides: Record<string, unknown> & { id: string },
    ): Record<string, unknown> => ({
      kind: 'service',
      name: overrides.id,
      phases: 3,
      secondaryVoltageV: 277,
      safetyMarginKw: '0',
      fedFromPanelId: null,
      maxContinuousKw: '285',
      ...overrides,
    });
    const asset = (
      overrides: Record<string, unknown> & { id: string },
    ): Record<string, unknown> => ({
      type: 'solar',
      name: overrides.id,
      peakKwp: 100,
      inverterKw: '60',
      maxDischargeKw: null,
      maxChargeKw: null,
      phases: 3,
      connectionTransformerId: null,
      connectionPanelId: null,
      gridCharging: 'never',
      reservePercent: 10,
      telemetry: 'api',
      readingTtlSeconds: 60,
      ...overrides,
    });
    const reading = (assetId: string, ageS: number, powerKw: string): Record<string, unknown> => ({
      assetId,
      reportedAt: new Date(NOW - ageS * 1000),
      receivedAt: new Date(NOW - ageS * 1000),
      powerKw,
      availableKw: null,
      socPercent: null,
      source: 'api',
    });

    function tree(): void {
      setResult('panels', [
        panelRow({ id: 'main', transformerId: 'tfm_svc' }),
        panelRow({ id: 'sub', parentPanelId: 'main', voltageV: 120, transformerId: 'tfm_sd' }),
        panelRow({ id: 'other' }),
      ]);
      setResult('circuits', []);
      setResult('unmanagedLoads', []);
      setResult('transformers', [
        transformerRow({ id: 'tfm_svc' }),
        transformerRow({
          id: 'tfm_sd',
          kind: 'step_down',
          fedFromPanelId: 'main',
          secondaryVoltageV: 120,
          maxContinuousKw: '71.25',
        }),
        transformerRow({ id: 'tfm_unlinked' }),
      ]);
    }

    it('puts a service transformer above its panels and a step-down one between panel and sub-panel', async () => {
      tree();
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      expect(roots.map((r) => [r.type, r.id])).toEqual([
        ['transformer', 'tfm_svc'],
        ['panel', 'other'],
      ]);
      const svc = roots[0];
      expect(svc?.maxContinuousKw).toBe(285);
      expect(svc?.perPhaseCapacityKw).toBe(95);
      const main = svc?.children[0];
      expect(main?.id).toBe('main');
      const stepDown = main?.children.find((c) => c.type === 'transformer');
      expect(stepDown?.id).toBe('tfm_sd');
      expect(stepDown?.transformerKind).toBe('step_down');
      expect(stepDown?.children.map((c) => c.id)).toEqual(['sub']);
    });

    it('ignores unrated transformers and a step-down unit not fed from the parent', async () => {
      setResult('panels', [
        panelRow({ id: 'main', transformerId: 'tfm_unrated' }),
        panelRow({ id: 'sub', parentPanelId: 'main', transformerId: 'tfm_wrong' }),
      ]);
      setResult('circuits', []);
      setResult('unmanagedLoads', []);
      setResult('transformers', [
        transformerRow({ id: 'tfm_unrated', maxContinuousKw: null }),
        transformerRow({ id: 'tfm_wrong', kind: 'step_down', fedFromPanelId: 'elsewhere' }),
      ]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      expect(roots.map((r) => r.id)).toEqual(['main']);
      expect(roots[0]?.children.map((c) => [c.type, c.id])).toEqual([['panel', 'sub']]);
    });

    it('credits load-side solar on every strict ancestor, not on its own panel (D8)', async () => {
      tree();
      setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionPanelId: 'sub' })]);
      setResult('energyAssetReadings', [reading('ena_pv', 5, '40')]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      const svc = roots[0];
      const main = svc?.children[0];
      const stepDown = main?.children.find((c) => c.type === 'transformer');
      const sub = stepDown?.children[0];
      expect(sub?.supplyCreditKw ?? 0).toBe(0);
      expect(stepDown?.supplyCreditKw).toBe(40);
      expect(main?.supplyCreditKw).toBe(40);
      expect(svc?.supplyCreditKw).toBe(40);
      expect(svc?.supplyPhaseCreditKw?.L1).toBeCloseTo(40 / 3, 9);
      expect(sub?.energyAssets?.[0]).toMatchObject({
        state: 'fresh',
        creditKw: 40,
        creditApplied: true,
      });
      expect(roots[1]?.supplyCreditKw ?? 0).toBe(0);
    });

    it('ages a reading from when it was measured, not when it arrived (case 333)', async () => {
      tree();
      setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionPanelId: 'sub' })]);
      // Received 5 s ago, measured 70 s ago: past its 60 s lifetime.
      setResult('energyAssetReadings', [
        { ...reading('ena_pv', 5, '40'), reportedAt: new Date(NOW - 70_000) },
      ]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
      const stepDown = roots[0]?.children[0]?.children.find((c) => c.type === 'transformer');
      expect(stepDown?.children[0]?.energyAssets?.[0]).toMatchObject({ state: 'stale' });
    });

    describe('a three-phase asset on a single-phase sub-panel raises no phase above it', () => {
      // A 3-phase 277 V main (88.64 kW per phase) with a single-phase L1
      // sub-panel and a 500 kW single-phase circuit on L3 of the main; 60 kW
      // of three-phase solar sits on the sub-panel.
      function phaseTree(subChildren: Array<Record<string, unknown>> = []): void {
        setResult('panels', [
          panelRow({ id: 'main', maxContinuousKw: '500' }),
          panelRow({ id: 'sub', parentPanelId: 'main', phases: 1, phaseConnections: 'L1' }),
          ...subChildren,
        ]);
        setResult('circuits', [
          {
            id: 'c3',
            panelId: 'main',
            name: 'L3 circuit',
            breakerRatingAmps: 800,
            maxContinuousKw: '500',
            phaseConnections: 'L3',
            voltageV: null,
          },
        ]);
        setResult('unmanagedLoads', []);
        setResult('transformers', []);
      }
      const l3Station = makeStation({
        id: 'sta_3',
        stationId: 'CS-003',
        circuitId: 'c3',
        maxPowerKw: 300,
      });

      it('gives the asset no credit at a single-phase connection point (allocation and plan)', async () => {
        phaseTree();
        setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionPanelId: 'sub' })]);
        setResult('energyAssetReadings', [reading('ena_pv', 5, '60')]);
        const roots = await buildSiteHierarchy('site-1', [l3Station], { nowMs: NOW });
        const main = roots[0];
        expect(main?.id).toBe('main');
        expect(main?.supplyCreditKw ?? 0).toBe(0);
        expect(main?.supplyPhaseCreditKw ?? null).toBeNull();
        const sub = main?.children.find((c) => c.id === 'sub');
        expect(sub?.energyAssets?.[0]).toMatchObject({ creditKw: 60, creditApplied: false });

        const perPhase = (400 * 277 * 0.8) / 1000;
        const allocation = computeHierarchicalAllocation(roots, 'equal_share');
        expect(allocation.find((a) => a.stationDbId === 'sta_3')?.allocatedKw).toBeCloseTo(
          perPhase,
          6,
        );
        const plan = buildPlanNodes(roots, new Map());
        const l3 = phaseNodeId('main', 'L3');
        expect(plan.liveHeadroomKw.get(l3)).toBeCloseTo(plan.headroomKw.get(l3) ?? -1, 9);
      });

      it('gives no per-phase credit above a single-phase node on the path', async () => {
        phaseTree([panelRow({ id: 'subsub', parentPanelId: 'sub' })]);
        setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionPanelId: 'subsub' })]);
        setResult('energyAssetReadings', [reading('ena_pv', 5, '60')]);
        const roots = await buildSiteHierarchy('site-1', [l3Station], { nowMs: NOW });
        const main = roots[0];
        const sub = main?.children.find((c) => c.id === 'sub');
        expect(sub?.supplyCreditKw).toBe(60);
        expect(main?.supplyCreditKw).toBe(60);
        expect(main?.supplyPhaseCreditKw ?? null).toBeNull();
        const perPhase = (400 * 277 * 0.8) / 1000;
        const allocation = computeHierarchicalAllocation(roots, 'equal_share');
        expect(allocation.find((a) => a.stationDbId === 'sta_3')?.allocatedKw).toBeCloseTo(
          perPhase,
          6,
        );
        const plan = buildPlanNodes(roots, new Map());
        const l3 = phaseNodeId('main', 'L3');
        expect(plan.liveHeadroomKw.get(l3)).toBeCloseTo(plan.headroomKw.get(l3) ?? -1, 9);
      });

      it('still credits every phase of a three-phase path', async () => {
        phaseTree();
        setResult('siteEnergyAssets', [
          asset({ id: 'ena_pv', connectionPanelId: 'sub', phases: 1 }),
        ]);
        setResult('energyAssetReadings', [reading('ena_pv', 5, '60')]);
        // A single-phase asset on the single-phase sub-panel: total credit only.
        const single = await buildSiteHierarchy('site-1', [l3Station], { nowMs: NOW });
        expect(single[0]?.supplyCreditKw).toBe(60);
        expect(single[0]?.supplyPhaseCreditKw ?? null).toBeNull();

        phaseTree([panelRow({ id: 'three', parentPanelId: 'main' })]);
        setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionPanelId: 'three' })]);
        setResult('energyAssetReadings', [reading('ena_pv', 5, '60')]);
        const roots = await buildSiteHierarchy('site-1', [l3Station], { nowMs: NOW });
        expect(roots[0]?.supplyPhaseCreditKw).toEqual({ L1: 20, L2: 20, L3: 20 });
      });
    });

    it('credits a supply-side asset on its transformer only', async () => {
      tree();
      setResult('siteEnergyAssets', [asset({ id: 'ena_pv', connectionTransformerId: 'tfm_sd' })]);
      setResult('energyAssetReadings', [reading('ena_pv', 5, '30')]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      const main = roots[0]?.children[0];
      const stepDown = main?.children.find((c) => c.type === 'transformer');
      expect(stepDown?.supplyCreditKw).toBe(30);
      expect(main?.supplyCreditKw ?? 0).toBe(0);
      expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    });

    it('counts a supply-side asset on a transformer outside the tree nowhere', async () => {
      tree();
      setResult('siteEnergyAssets', [
        asset({
          id: 'ena_bat',
          type: 'battery',
          peakKwp: null,
          maxChargeKw: '50',
          gridCharging: 'possible',
          connectionTransformerId: 'tfm_unlinked',
        }),
      ]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      const all: HierarchyNode[] = [];
      const walk = (list: HierarchyNode[]): void => {
        for (const n of list) {
          all.push(n);
          walk(n.children);
        }
      };
      walk(roots);
      expect(all.some((n) => (n.supplyLoadKw ?? 0) > 0 || n.energyAssets != null)).toBe(false);
    });

    it('gives no credit for a stale reading and counts a battery as load (D9)', async () => {
      tree();
      setResult('siteEnergyAssets', [
        asset({ id: 'ena_pv', connectionPanelId: 'sub' }),
        asset({
          id: 'ena_bat',
          type: 'battery',
          peakKwp: null,
          inverterKw: '60',
          maxDischargeKw: '60',
          maxChargeKw: '50',
          gridCharging: 'possible',
          phases: 1,
          connectionPanelId: 'main',
        }),
      ]);
      setResult('energyAssetReadings', [
        reading('ena_pv', 61, '40'),
        reading('ena_bat', 120, '60'),
      ]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      const svc = roots[0];
      const main = svc?.children[0];
      expect(svc?.supplyCreditKw ?? 0).toBe(0);
      expect(main?.supplyLoadKw).toBe(50);
      expect(main?.supplySinglePhaseLoadKw).toBe(50);
      expect(main?.currentDrawKw).toBe(50);
      expect(svc?.currentDrawKw).toBe(50);
      expect(main?.energyAssets?.[0]).toMatchObject({ state: 'stale', creditKw: 0, loadKw: 50 });
    });

    it('counts an unrated grid-charging battery as a load of its whole connection point, never 0 (D9)', async () => {
      tree();
      const log = makeLogger();
      setResult('siteEnergyAssets', [
        asset({
          id: 'ena_bat',
          type: 'battery',
          peakKwp: null,
          inverterKw: null,
          maxChargeKw: null,
          gridCharging: 'possible',
          connectionPanelId: 'main',
        }),
      ]);
      setResult('energyAssetReadings', []);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW, log });
      const main = roots[0]?.children[0];
      expect(main?.supplyLoadKw).toBe(200);
      expect(roots[0]?.currentDrawKw).toBe(200);
      expect(main?.energyAssets?.[0]).toMatchObject({ state: 'none', loadKw: 200 });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ energyAssetId: 'ena_bat' }),
        'Battery without a charge or inverter rating, it counts as a load of its whole connection point',
      );
    });

    it('ignores the readings of an asset without api telemetry', async () => {
      tree();
      setResult('siteEnergyAssets', [
        asset({ id: 'ena_pv', connectionPanelId: 'sub', telemetry: 'none' }),
        asset({ id: 'ena_sim', connectionPanelId: 'sub', telemetry: 'simulated' }),
      ]);
      setResult('energyAssetReadings', [reading('ena_pv', 1, '40'), reading('ena_sim', 1, '40')]);
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW });
      expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    });

    it('fails closed when the readings cannot be read', async () => {
      tree();
      setResult('siteEnergyAssets', [
        asset({ id: 'ena_pv', connectionPanelId: 'sub' }),
        asset({
          id: 'ena_bat',
          type: 'battery',
          peakKwp: null,
          maxChargeKw: '25',
          gridCharging: 'possible',
          connectionTransformerId: 'tfm_svc',
        }),
      ]);
      dbState.results.set('energyAssetReadings', new Error('read failed') as unknown as unknown[]);
      const log = makeLogger();
      const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOW, log });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ siteId: 'site-1' }),
        'Energy asset readings not read, batteries and solar give no supply this cycle',
      );
      expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
      expect(roots[0]?.supplyLoadKw).toBe(25);
    });

    it('spreads a three-phase battery load over the phases and a single-phase one on every phase', () => {
      const three = node({ phases: 3, supplyLoadKw: 30, children: [] });
      const into = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(three, new Map(), into);
      expect(into).toEqual({ L1: 10, L2: 10, L3: 10 });
      const single = node({ phases: 3, supplyLoadKw: 30, supplySinglePhaseLoadKw: 30 });
      const intoSingle = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(single, new Map(), intoSingle);
      expect(intoSingle).toEqual({ L1: 30, L2: 30, L3: 30 });
    });
  });
});

describe('logAllocations supply credit', () => {
  it('stores the supply credit of the allocation', async () => {
    await logAllocations('site-1', [], { strategy: 'equal_share' }, 0, {
      siteLimitKw: 140,
      availableKw: 140,
      supplyCreditKw: 40,
    });
    const row = dbState.insertCalls.find((c) => c.table === 'loadAllocationLog')?.values as
      | Record<string, unknown>
      | undefined;
    expect(row?.['supplyCreditKw']).toBe('40');
  });
});

describe('simulated battery and solar readings', () => {
  // 2026-06-21 12:00 UTC: local solar noon at Greenwich, the sun at about 62 degrees.
  const NOON = Date.UTC(2026, 5, 21, 12, 0, 0);
  function tree(): void {
    setResult('panels', [
      {
        id: 'main',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 400,
        voltageV: 277,
        phases: 3,
        maxContinuousKw: '200',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: 'tfm_svc',
      },
    ]);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);
    setResult('transformers', [
      {
        id: 'tfm_svc',
        kind: 'service',
        name: 'Service',
        phases: 3,
        secondaryVoltageV: 277,
        safetyMarginKw: '0',
        fedFromPanelId: null,
        maxContinuousKw: '285',
      },
    ]);
    setResult('siteEnergyAssets', [
      {
        id: 'ena_pv',
        type: 'solar',
        name: 'Solar',
        capacityKwh: null,
        peakKwp: 100,
        inverterKw: '90',
        maxDischargeKw: null,
        maxChargeKw: null,
        phases: 3,
        connectionTransformerId: null,
        connectionPanelId: 'main',
        gridCharging: 'never',
        reservePercent: 10,
        telemetry: 'simulated',
        readingTtlSeconds: 60,
      },
    ]);
  }

  it('computes a clear-sky solar reading where the process allows it', async () => {
    tree();
    setResult('sites', [{ latitude: '51.4769', longitude: '0' }]);
    const roots = await buildSiteHierarchy('site-1', [], {
      nowMs: NOON,
      allowSimulatedEnergyAssets: true,
    });
    // Haurwitz clear sky at about 62 degrees, PVWatts losses and inverter efficiency.
    const cosZ = Math.sin((62 * Math.PI) / 180);
    const ghi = 1098 * cosZ * Math.exp(-0.057 / cosZ);
    const expected = (100 * ghi * (1 - 0.1408) * 0.96) / 1000;
    expect(roots[0]?.supplyCreditKw).toBeCloseTo(expected, 0);
    expect(roots[0]?.children[0]?.energyAssets?.[0]).toMatchObject({ state: 'fresh' });
  });

  it('credits a simulated battery on peak in the site time zone', async () => {
    tree();
    setResult('siteEnergyAssets', [
      {
        id: 'ena_bat',
        type: 'battery',
        name: 'Battery',
        capacityKwh: 200,
        peakKwp: null,
        inverterKw: '60',
        maxDischargeKw: '50',
        maxChargeKw: '50',
        phases: 3,
        connectionTransformerId: 'tfm_svc',
        connectionPanelId: null,
        gridCharging: 'possible',
        reservePercent: 10,
        telemetry: 'simulated',
        readingTtlSeconds: 60,
      },
    ]);
    setResult('sites', [{ latitude: '51.4769', longitude: '0', timezone: 'UTC' }]);
    const peak = await buildSiteHierarchy('site-1', [], {
      nowMs: Date.UTC(2026, 5, 21, 17, 0, 0),
      allowSimulatedEnergyAssets: true,
    });
    // Its usable 160 kWh spread over the five peak hours.
    expect(peak[0]?.supplyCreditKw).toBeCloseTo((160 * Math.sqrt(0.85)) / 5, 6);
    // Overnight it charges from the grid: a load, no credit.
    const night = await buildSiteHierarchy('site-1', [], {
      nowMs: Date.UTC(2026, 5, 21, 2, 0, 0),
      allowSimulatedEnergyAssets: true,
    });
    expect(night[0]?.supplyCreditKw ?? 0).toBe(0);
    expect(night[0]?.supplyLoadKw).toBe(50);
  });

  it('dispatches a depot battery overnight and charges it at midday', async () => {
    tree();
    setResult('siteEnergyAssets', [
      {
        id: 'ena_bat',
        type: 'battery',
        name: 'Battery',
        capacityKwh: 200,
        peakKwp: null,
        inverterKw: '60',
        maxDischargeKw: '50',
        maxChargeKw: '50',
        phases: 3,
        connectionTransformerId: 'tfm_svc',
        connectionPanelId: null,
        gridCharging: 'possible',
        reservePercent: 10,
        telemetry: 'simulated',
        readingTtlSeconds: 60,
      },
    ]);
    setResult('sites', [
      {
        latitude: '51.4769',
        longitude: '0',
        timezone: 'UTC',
        layoutSettings: { siteType: 'depot' },
      },
    ]);
    // 02:00, while the buses charge: it discharges, its usable energy over nine hours.
    const night = await buildSiteHierarchy('site-1', [], {
      nowMs: Date.UTC(2026, 5, 21, 2, 0, 0),
      allowSimulatedEnergyAssets: true,
    });
    expect(night[0]?.supplyCreditKw).toBeCloseTo((160 * Math.sqrt(0.85)) / 9, 6);
    expect(night[0]?.supplyLoadKw ?? 0).toBe(0);
    // Midday: it charges, a load and no credit.
    const midday = await buildSiteHierarchy('site-1', [], {
      nowMs: Date.UTC(2026, 5, 21, 12, 0, 0),
      allowSimulatedEnergyAssets: true,
    });
    expect(midday[0]?.supplyCreditKw ?? 0).toBe(0);
    expect(midday[0]?.supplyLoadKw).toBe(50);
  });

  it('gives no reading where the process does not allow simulated readings', async () => {
    tree();
    setResult('sites', [{ latitude: '51.4769', longitude: '0' }]);
    const roots = await buildSiteHierarchy('site-1', [], { nowMs: NOON });
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    expect(roots[0]?.children[0]?.energyAssets?.[0]).toMatchObject({ state: 'none' });
  });

  it('gives no reading for a site without a position', async () => {
    tree();
    setResult('sites', [{ latitude: null, longitude: 'east' }]);
    const roots = await buildSiteHierarchy('site-1', [], {
      nowMs: NOON,
      allowSimulatedEnergyAssets: true,
    });
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
  });

  it('gives no simulated reading when the site position cannot be read', async () => {
    tree();
    setResult('sites', new Error('db down') as unknown as unknown[]);
    const log = makeLogger();
    const roots = await buildSiteHierarchy('site-1', [], {
      nowMs: NOON,
      allowSimulatedEnergyAssets: true,
      log,
    });
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
      'Site position not read, simulated batteries and solar give no supply this cycle',
    );
  });

  it('gives no solar credit at night', async () => {
    tree();
    setResult('sites', [{ latitude: '51.4769', longitude: '0' }]);
    const roots = await buildSiteHierarchy('site-1', [], {
      nowMs: Date.UTC(2026, 5, 21, 0, 0, 0),
      allowSimulatedEnergyAssets: true,
    });
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
  });

  it('passes the gate from the cycle to the hierarchy', async () => {
    tree();
    setResult('sites', [{ latitude: '51.4769', longitude: '0' }]);
    setResult('siteLoadManagement', [
      { siteId: 'site-1', strategy: 'equal_share', appliedAllocations: null, appliedAt: null },
    ]);
    setResult('chargingStations', []);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    try {
      await runLoadManagementCycle(makeLogger(), 'site-1', { allowSimulatedEnergyAssets: true });
    } finally {
      vi.useRealTimers();
    }
    const row = dbState.insertCalls.find((c) => c.table === 'loadAllocationLog')?.values as
      | Record<string, unknown>
      | undefined;
    expect(Number(row?.['supplyCreditKw'])).toBeGreaterThan(60);
  });
});

describe('energy assets that cannot be read', () => {
  // A 60 kW transformer over a 100 kW panel with two 40 kW circuits: the
  // grid-only capacity is 60 kW. The previous cycle sent 45 + 20 = 65 kW
  // with a solar credit.
  function site(): void {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-1',
        strategy: 'equal_share',
        appliedAllocations: [
          { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 45 },
          { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 20 },
        ],
        appliedAt: new Date(),
      },
    ]);
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: 'c1' },
      { id: 'sta_2', stationId: 'CS-002', isOnline: true, loadPriority: 5, circuitId: 'c2' },
    ]);
    setResult('connectors', [
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '100' },
      { stationId: 'sta_2', evseDbId: 'evse_2', maxPowerKw: '100' },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }, { stationId: 'sta_2' }]);
    setResult('meterValues', []);
    setResult('evChargingNeeds', []);
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 400,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: 'tfm_1',
      },
    ]);
    setResult('transformers', [
      {
        id: 'tfm_1',
        kind: 'service',
        name: 'Service',
        phases: 1,
        secondaryVoltageV: 240,
        safetyMarginKw: '0',
        fedFromPanelId: null,
        maxContinuousKw: '60',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'A',
        breakerRatingAmps: 100,
        maxContinuousKw: '40',
        phaseConnections: null,
      },
      {
        id: 'c2',
        panelId: 'p1',
        name: 'B',
        breakerRatingAmps: 100,
        maxContinuousKw: '40',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', []);
  }

  // A battery at the service transformer that may charge from the grid, its
  // fresh reading discharging 20 kW (a 20 kW credit while it is read).
  function battery(): void {
    setResult('siteEnergyAssets', [
      {
        id: 'ena_bat',
        type: 'battery',
        name: 'Battery',
        capacityKwh: 100,
        peakKwp: null,
        inverterKw: '30',
        maxDischargeKw: '20',
        maxChargeKw: '20',
        phases: 1,
        connectionTransformerId: 'tfm_1',
        connectionPanelId: null,
        gridCharging: 'possible',
        reservePercent: 10,
        telemetry: 'api',
        readingTtlSeconds: 60,
      },
    ]);
    setResult('energyAssetReadings', [
      {
        assetId: 'ena_bat',
        reportedAt: new Date(),
        receivedAt: new Date(),
        powerKw: '20',
        availableKw: '20',
        socPercent: '80',
        source: 'api',
      },
    ]);
  }

  function sentLimits(): Array<[string, number | undefined]> {
    return pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => {
        const command = JSON.parse(c[1]) as {
          stationId: string;
          payload: {
            chargingProfile: {
              chargingSchedule: Array<{ chargingSchedulePeriod: Array<{ limit: number }> }>;
            };
          };
        };
        return [
          command.stationId,
          command.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0]?.limit,
        ];
      });
  }

  it('with no earlier read, sends grid-only limits capped at the held limits and no credit', async () => {
    site();
    dbState.results.set('siteEnergyAssets', new Error('read failed') as unknown as unknown[]);
    const log = makeLogger();

    await runLoadManagementCycle(log, 'site-1');

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
      'Energy assets not read and not known, no limit is raised this cycle',
    );
    // Grid-only 30 + 30 kW, each capped at the limit held: CS-001 is cut from
    // 45 to 30, CS-002 keeps 20 (no raise without a known battery load).
    expect(new Map(sentLimits())).toEqual(
      new Map([
        ['CS-001', 30000],
        ['CS-002', 20000],
      ]),
    );
    const row = dbState.insertCalls.find((c) => c.table === 'loadAllocationLog')?.values as
      | Record<string, unknown>
      | undefined;
    expect(Number(row?.['supplyCreditKw'])).toBe(0);
  });

  it('with no earlier read, builds the tree without any battery or solar supply', async () => {
    site();
    dbState.results.set('siteEnergyAssets', new Error('read failed') as unknown as unknown[]);
    const roots = await buildSiteHierarchy('site-1', [], { log: makeLogger() });
    expect(roots[0]?.type).toBe('transformer');
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    expect(roots[0]?.supplyLoadKw ?? 0).toBe(0);
  });

  it('gives no credit on a failed read after a read that credited the battery', async () => {
    site();
    battery();
    const read = await buildSiteHierarchy('site-1', [], { log: makeLogger() });
    expect(read[0]?.supplyCreditKw).toBe(20);

    dbState.results.set('siteEnergyAssets', new Error('read failed') as unknown as unknown[]);
    const log = makeLogger();
    const roots = await buildSiteHierarchy('site-1', [], { log });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
      'Energy assets not read, the allocation uses the grid limits and the last known battery loads this cycle',
    );
    expect(roots[0]?.supplyCreditKw ?? 0).toBe(0);
    // The remembered battery counts at its rated charge power, no reading.
    expect(roots[0]?.supplyLoadKw).toBe(20);
    expect(roots[0]?.energyAssets?.[0]).toMatchObject({
      id: 'ena_bat',
      state: 'none',
      creditKw: 0,
    });
  });

  it('subtracts the remembered battery grid load from the grid-only capacity', async () => {
    site();
    battery();
    await buildSiteHierarchy('site-1', [], { log: makeLogger() });

    dbState.results.set('siteEnergyAssets', new Error('read failed') as unknown as unknown[]);
    await runLoadManagementCycle(makeLogger(), 'site-1');

    // 60 kW grid-only minus the 20 kW battery load: 20 + 20 = 40 kW.
    const limits = sentLimits();
    expect(new Map(limits)).toEqual(
      new Map([
        ['CS-001', 20000],
        ['CS-002', 20000],
      ]),
    );
    expect(limits.reduce((sum, [, limit]) => sum + (limit ?? 0), 0)).toBe(40000);
    const row = dbState.insertCalls.find((c) => c.table === 'loadAllocationLog')?.values as
      | Record<string, unknown>
      | undefined;
    expect(Number(row?.['supplyCreditKw'])).toBe(0);
  });
});

describe('withoutRaises', () => {
  it('caps a raise at the held limit and keeps cuts and stations without a limit', () => {
    const result = withoutRaises(
      [
        { stationId: 'A', stationDbId: 'a', allocatedKw: 30, currentDrawKw: 0 },
        { stationId: 'B', stationDbId: 'b', allocatedKw: 10, currentDrawKw: 0 },
        { stationId: 'C', stationDbId: 'c', allocatedKw: 50, currentDrawKw: 0 },
      ],
      [
        { stationId: 'A', stationDbId: 'a', allocatedKw: 20 },
        { stationId: 'B', stationDbId: 'b', allocatedKw: 40 },
      ],
    );
    expect(result.map((r) => r.allocatedKw)).toEqual([20, 10, 50]);
  });
});

describe('station local generation (OCPP 2.1 K27)', () => {
  const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  const rate = { voltageV: 230, phases: 3 };
  const notified = (schedule: Record<string, unknown> | null, agoS = 60): unknown[] => [
    {
      chargingProfilePurpose: 'LocalGeneration',
      notifiedChargingLimit: true,
      notifiedAt: new Date(NOW - agoS * 1000).toISOString(),
      chargingLimit: { chargingLimitSource: 'EMS', isLocalGeneration: true },
      chargingSchedule: schedule == null ? [] : [schedule],
    },
  ];

  it('reads the active period of a notified schedule from the notification time', () => {
    const schedule = {
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 2000 },
        { startPeriod: 3600, limit: 1000 },
      ],
    };
    expect(localGenerationKw(notified(schedule, 60), null, NOW, rate)).toBe(2);
    expect(localGenerationKw(notified(schedule, 3700), null, NOW, rate)).toBe(1);
  });

  it('ends a schedule after its duration and before its start', () => {
    const ended = {
      chargingRateUnit: 'W',
      duration: 30,
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 2000 }],
    };
    expect(localGenerationKw(notified(ended, 60), null, NOW, rate)).toBe(0);
    const later = {
      chargingRateUnit: 'W',
      startSchedule: new Date(NOW + 60_000).toISOString(),
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 2000 }],
    };
    expect(localGenerationKw(notified(later), null, NOW, rate)).toBe(0);
  });

  it('converts a limit in A with the circuit and sums per-phase W limits', () => {
    const amps = { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }] };
    expect(localGenerationKw(notified(amps), null, NOW, rate)).toBeCloseTo(6.9, 9);
    const perPhase = {
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 1000, limit_L2: 1000, limit_L3: 500 }],
    };
    expect(localGenerationKw(notified(perPhase), null, NOW, rate)).toBe(2.5);
  });

  it('reads a LocalGeneration profile of a station report and ignores other purposes', () => {
    const report = [
      {
        id: 7,
        chargingProfilePurpose: 'LocalGeneration',
        chargingProfileKind: 'Dynamic',
        chargingSchedule: [
          { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }] },
        ],
      },
      {
        id: 8,
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
        chargingSchedule: [
          { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 9000 }] },
        ],
      },
    ];
    expect(localGenerationKw(report, NOW - 1000, NOW, rate)).toBe(3);
    expect(localGenerationKw([report[1]], NOW, NOW, rate)).toBe(0);
  });

  it('reports an unreadable local generation as unknown', () => {
    expect(localGenerationKw(notified(null), null, NOW, rate)).toBeNull();
  });

  it('reserves local generation on the circuit and every node above it', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 100,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '30',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: null,
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'A',
        breakerRatingAmps: 100,
        maxContinuousKw: '30',
        phaseConnections: null,
        voltageV: null,
      },
      {
        id: 'c2',
        panelId: 'p1',
        name: 'B',
        breakerRatingAmps: 100,
        maxContinuousKw: '30',
        phaseConnections: null,
        voltageV: null,
      },
    ]);
    setResult('unmanagedLoads', []);
    setResult('chargingProfiles', [
      {
        stationId: 'gen',
        evseId: 1,
        reportedAt: new Date(NOW - 60_000),
        profileData: notified(
          { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }] },
          60,
        ),
      },
    ]);
    const gen = makeStation({ id: 'gen', stationId: 'GEN', circuitId: 'c1', maxPowerKw: 22 });
    const other = makeStation({ id: 'other', stationId: 'OTHER', circuitId: 'c2', maxPowerKw: 22 });
    const roots = await buildSiteHierarchy('site-1', [gen, other], { nowMs: NOW });
    const c1 = roots[0]?.children.find((c) => c.id === 'c1');
    expect(c1?.localGenerationKw).toBe(6);
    expect(gen.localGenerationKw).toBe(6);
    expect(fixedLoadKw(roots[0] as HierarchyNode, new Map())).toBe(6);
    // Panel 30 - 6 reserved: the two stations share 24.
    const out = computeHierarchicalAllocation(roots, 'equal_share');
    expect(out.reduce((s, r) => s + r.allocatedKw, 0)).toBeCloseTo(24, 6);
  });

  it('counts an unreadable local generation at the station maximum (fail closed)', async () => {
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 100,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '80',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: null,
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'A',
        breakerRatingAmps: 100,
        maxContinuousKw: '80',
        phaseConnections: null,
        voltageV: null,
      },
    ]);
    setResult('unmanagedLoads', []);
    setResult('chargingProfiles', [
      { stationId: 'gen', evseId: null, reportedAt: new Date(NOW), profileData: notified(null) },
    ]);
    const gen = makeStation({ id: 'gen', stationId: 'GEN', circuitId: 'c1', maxPowerKw: 22 });
    const roots = await buildSiteHierarchy('site-1', [gen], { nowMs: NOW });
    expect(roots[0]?.children[0]?.localGenerationKw).toBe(22);
  });
});

describe('credit profiles that end with their readings (security case 334)', () => {
  // A 60 kW transformer over a 100 kW switchboard with two 40 kW circuits.
  // A battery at the transformer that may charge from the grid (20 kW
  // rating) reads 20 kW of discharge: with the reading each station gets 40
  // kW; once it is stale the battery is a 20 kW load and each gets 20 kW.
  const TTL_S = 60;

  function site(applied: unknown[] | null, appliedAt: Date | null = new Date()): void {
    setResult('siteLoadManagement', [
      {
        isEnabled: true,
        siteId: 'site-1',
        strategy: 'equal_share',
        appliedAllocations: applied,
        appliedAt,
      },
    ]);
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: 'c1' },
      { id: 'sta_2', stationId: 'CS-002', isOnline: true, loadPriority: 5, circuitId: 'c2' },
    ]);
    setResult('connectors', [
      { stationId: 'sta_1', evseDbId: 'evse_1', maxPowerKw: '100' },
      { stationId: 'sta_2', evseDbId: 'evse_2', maxPowerKw: '100' },
    ]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }, { stationId: 'sta_2' }]);
    setResult('meterValues', []);
    setResult('evChargingNeeds', []);
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 400,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: 'tfm_1',
      },
    ]);
    setResult('transformers', [
      {
        id: 'tfm_1',
        kind: 'service',
        name: 'Service',
        phases: 1,
        secondaryVoltageV: 240,
        safetyMarginKw: '0',
        fedFromPanelId: null,
        maxContinuousKw: '60',
      },
    ]);
    setResult('circuits', [
      {
        id: 'c1',
        panelId: 'p1',
        name: 'A',
        breakerRatingAmps: 100,
        maxContinuousKw: '40',
        phaseConnections: null,
      },
      {
        id: 'c2',
        panelId: 'p1',
        name: 'B',
        breakerRatingAmps: 100,
        maxContinuousKw: '40',
        phaseConnections: null,
      },
    ]);
    setResult('unmanagedLoads', []);
    setResult('siteEnergyAssets', [
      {
        id: 'ena_bat',
        type: 'battery',
        name: 'Battery',
        capacityKwh: 100,
        peakKwp: null,
        inverterKw: '30',
        maxDischargeKw: '20',
        maxChargeKw: '20',
        phases: 1,
        connectionTransformerId: 'tfm_1',
        connectionPanelId: null,
        gridCharging: 'possible',
        reservePercent: 10,
        telemetry: 'api',
        readingTtlSeconds: TTL_S,
      },
    ]);
  }

  function reading(measuredAt: Date | null): void {
    setResult(
      'energyAssetReadings',
      measuredAt == null
        ? []
        : [
            {
              assetId: 'ena_bat',
              reportedAt: measuredAt,
              receivedAt: measuredAt,
              powerKw: '20',
              availableKw: '20',
              socPercent: '80',
              source: 'api',
            },
          ],
    );
  }

  interface Profile {
    stationId: string;
    id: number;
    stackLevel: number;
    validTo?: string;
    limit: number;
  }

  function sentProfiles(): Profile[] {
    return pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => JSON.parse(c[1]) as Record<string, unknown>)
      .filter((c) => c['action'] === 'SetChargingProfile')
      .map((c) => {
        const payload = c['payload'] as Record<string, unknown>;
        const profile = payload['chargingProfile'] as Record<string, unknown>;
        const schedule = (profile['chargingSchedule'] as Array<Record<string, unknown>>)[0];
        const period = (schedule?.['chargingSchedulePeriod'] as Array<{ limit: number }>)[0];
        return {
          stationId: c['stationId'] as string,
          id: profile['id'] as number,
          stackLevel: profile['stackLevel'] as number,
          ...(typeof profile['validTo'] === 'string' ? { validTo: profile['validTo'] } : {}),
          limit: period?.limit ?? -1,
        };
      });
  }

  function storedApplied(): Array<Record<string, unknown>> {
    const call = [...dbState.updateCalls]
      .reverse()
      .find((c) => c.table === 'siteLoadManagement' && c.values['appliedAllocations'] != null);
    return (call?.values['appliedAllocations'] ?? []) as Array<Record<string, unknown>>;
  }

  function held(allocatedKw: number, creditUntil: string): Array<Record<string, unknown>> {
    return ['1', '2'].map((n) => ({
      stationId: `CS-00${n}`,
      stationDbId: `sta_${n}`,
      allocatedKw,
      baseKw: 20,
      creditUntil,
    }));
  }

  it('builds the credit profile one stack level up, with its own id and an end', () => {
    const validTo = new Date('2026-11-04T12:00:30.000Z');
    const credit = buildLoadManagementProfile(
      40_000,
      new Date('2026-11-04T12:00:00Z'),
      undefined,
      validTo,
    )['chargingProfile'] as Record<string, unknown>;
    expect(credit).toMatchObject({
      id: LOAD_MANAGEMENT_PROFILE_ID + 1,
      stackLevel: LOAD_MANAGEMENT_CREDIT_STACK_LEVEL,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      validTo: '2026-11-04T12:00:30.000Z',
    });
    const base = buildLoadManagementProfile(20_000, new Date())['chargingProfile'] as Record<
      string,
      unknown
    >;
    expect(base['stackLevel']).toBe(1);
    expect(base['validTo']).toBeUndefined();
    expect(isLoadManagementProfile(base)).toBe(true);
    // A reply to the credit profile is not the reply to the station limit:
    // a station that refuses it keeps the lower limit and is no fixed load.
    expect(isLoadManagementProfile(credit)).toBe(false);
  });

  it('keeps the credit id within the int32 range above a high MaxExternalConstraintsId', () => {
    expect(loadManagementProfileId('2147483647') + 1).toBeLessThanOrEqual(2_147_483_647);
  });

  it('sends the limit without readings at stack level 1 and the credited limit until the reading ends', async () => {
    const measuredAt = new Date(Date.now() - 5_000);
    site([
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 30 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 30 },
    ]);
    reading(measuredAt);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    const validTo = new Date(measuredAt.getTime() + TTL_S * 1000).toISOString();
    const profiles = sentProfiles();
    expect(profiles).toEqual(
      expect.arrayContaining([
        { stationId: 'CS-001', id: LOAD_MANAGEMENT_PROFILE_ID, stackLevel: 1, limit: 20_000 },
        { stationId: 'CS-002', id: LOAD_MANAGEMENT_PROFILE_ID, stackLevel: 1, limit: 20_000 },
        {
          stationId: 'CS-001',
          id: LOAD_MANAGEMENT_PROFILE_ID + 1,
          stackLevel: 2,
          validTo,
          limit: 40_000,
        },
        {
          stationId: 'CS-002',
          id: LOAD_MANAGEMENT_PROFILE_ID + 1,
          stackLevel: 2,
          validTo,
          limit: 40_000,
        },
      ]),
    );
    expect(profiles).toHaveLength(4);
    // The stack level 1 cuts go out before the credit raises.
    const firstRaise = profiles.findIndex((p) => p.stackLevel === 2);
    expect(profiles.slice(firstRaise).every((p) => p.stackLevel === 2)).toBe(true);
    // Without the credit the stations hold 40 kW: the 60 kW transformer less
    // the 20 kW the battery may draw from the grid once its reading is stale.
    const base = profiles.filter((p) => p.stackLevel === 1).reduce((sum, p) => sum + p.limit, 0);
    expect(base).toBe(40_000);
    expect(storedApplied()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stationDbId: 'sta_1',
          allocatedKw: 40,
          baseKw: 20,
          creditUntil: validTo,
        }),
      ]),
    );
  });

  it('gives a station that takes no stack level 2 the limit without readings only', async () => {
    site(null, null);
    reading(new Date());
    setResult('stationConfigurations', [
      { stationId: 'sta_2', variable: 'ChargeProfileMaxStackLevel', value: '1' },
    ]);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    const profiles = sentProfiles();
    expect(profiles.filter((p) => p.stationId === 'CS-002')).toEqual([
      { stationId: 'CS-002', id: LOAD_MANAGEMENT_PROFILE_ID, stackLevel: 1, limit: 20_000 },
    ]);
    expect(profiles.filter((p) => p.stationId === 'CS-001' && p.stackLevel === 2)).toHaveLength(1);
  });

  it('sends only the credit profiles again when a newer reading carries the credit past an end that is close', async () => {
    const heldUntil = new Date(Date.now() + LOAD_MANAGEMENT_CREDIT_RESEND_MS - 5_000).toISOString();
    site(held(40, heldUntil));
    const measuredAt = new Date();
    reading(measuredAt);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    const validTo = new Date(measuredAt.getTime() + TTL_S * 1000).toISOString();
    expect(sentProfiles()).toEqual([
      {
        stationId: 'CS-001',
        id: LOAD_MANAGEMENT_PROFILE_ID + 1,
        stackLevel: 2,
        validTo,
        limit: 40_000,
      },
      {
        stationId: 'CS-002',
        id: LOAD_MANAGEMENT_PROFILE_ID + 1,
        stackLevel: 2,
        validTo,
        limit: 40_000,
      },
    ]);
    expect(dbState.insertCalls.some((c) => c.table === 'loadAllocationLog')).toBe(false);
    expect(storedApplied().every((e) => e['creditUntil'] === validTo)).toBe(true);
  });

  it('resends only the station whose end is close and keeps the end of the other', async () => {
    const closeEnd = new Date(Date.now() + LOAD_MANAGEMENT_CREDIT_RESEND_MS - 5_000).toISOString();
    const farEnd = new Date(Date.now() + 10 * LOAD_MANAGEMENT_CREDIT_RESEND_MS).toISOString();
    const [first, second] = held(40, closeEnd);
    site([first, { ...second, creditUntil: farEnd }]);
    const measuredAt = new Date();
    reading(measuredAt);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    const validTo = new Date(measuredAt.getTime() + TTL_S * 1000).toISOString();
    expect(sentProfiles()).toEqual([
      {
        stationId: 'CS-001',
        id: LOAD_MANAGEMENT_PROFILE_ID + 1,
        stackLevel: 2,
        validTo,
        limit: 40_000,
      },
    ]);
    const stored = new Map(storedApplied().map((e) => [e['stationDbId'], e['creditUntil']]));
    expect(stored.get('sta_1')).toBe(validTo);
    expect(stored.get('sta_2')).toBe(farEnd);
  });

  it('clears the applied time when the credit resend cannot be published', async () => {
    const heldUntil = new Date(Date.now() + LOAD_MANAGEMENT_CREDIT_RESEND_MS - 5_000).toISOString();
    site(held(40, heldUntil));
    reading(new Date());
    pubsubState.publish.mockRejectedValue(new Error('redis down'));

    await runLoadManagementCycle(makeLogger(), 'site-1');

    expect(
      dbState.updateCalls.some(
        (c) =>
          c.table === 'siteLoadManagement' &&
          'appliedAt' in c.values &&
          c.values['appliedAt'] === null,
      ),
    ).toBe(true);
  });

  it('sends nothing while the reading has not moved on, so the credit ends at the station', async () => {
    const measuredAt = new Date(Date.now() - (TTL_S - 10) * 1000);
    site(held(40, new Date(measuredAt.getTime() + TTL_S * 1000).toISOString()));
    reading(measuredAt);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    expect(sentProfiles()).toEqual([]);
  });

  it('replaces a credit profile that still holds with the lower limit once the reading is gone', async () => {
    const heldUntil = new Date(Date.now() + 20_000).toISOString();
    site(held(40, heldUntil));
    reading(null);

    await runLoadManagementCycle(makeLogger(), 'site-1');

    const profiles = sentProfiles();
    expect(profiles).toEqual(
      expect.arrayContaining([
        {
          stationId: 'CS-001',
          id: LOAD_MANAGEMENT_PROFILE_ID + 1,
          stackLevel: 2,
          validTo: heldUntil,
          limit: 20_000,
        },
        { stationId: 'CS-001', id: LOAD_MANAGEMENT_PROFILE_ID, stackLevel: 1, limit: 20_000 },
      ]),
    );
    expect(profiles).toHaveLength(4);
  });

  it('computes the limits without readings from the stale battery load and no credit', () => {
    const circuit = (id: string): HierarchyNode => ({
      type: 'circuit',
      id,
      name: id,
      maxContinuousKw: 40,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [makeStation({ id: `sta_${id}`, stationId: `CS-${id}`, maxPowerKw: 100 })],
      children: [],
      phases: 1,
      breakerRatingAmps: 100,
      voltageV: 240,
      oversubscriptionRatio: 1,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
    });
    const freshUntil = new Date(Date.now() + 30_000);
    const root: HierarchyNode = {
      ...circuit('root'),
      type: 'transformer',
      maxContinuousKw: 60,
      stations: [],
      supplyCreditKw: 20,
      supplyLoadKw: 0,
      fallbackSupplyLoadKw: 20,
      fallbackSupplySinglePhaseLoadKw: 20,
      energyAssets: [
        {
          id: 'ena_bat',
          name: 'Battery',
          type: 'battery',
          phases: 1,
          telemetry: 'api',
          connection: 'transformer',
          state: 'fresh',
          creditKw: 20,
          loadKw: 0,
          creditApplied: true,
          readingReceivedAt: new Date(),
          socPercent: 80,
          freshUntil,
        },
      ],
      children: [circuit('a'), circuit('b')],
    };
    const stripped = withoutAssetReadings([root])[0];
    expect(stripped?.supplyCreditKw).toBeUndefined();
    expect(stripped?.supplyLoadKw).toBe(20);
    // The tree it came from is unchanged.
    expect(root.supplyCreditKw).toBe(20);

    const allocations = computeHierarchicalAllocation([root], 'equal_share');
    const split = splitCreditLimits([root], 'equal_share', new Map(), allocations, [
      makeStation({ id: 'sta_a', stationId: 'CS-a' }),
      makeStation({ id: 'sta_b', stationId: 'CS-b', maxStackLevel: 1 }),
    ]);
    expect(split.baseKw).toEqual(new Map([['sta_a', 20]]));
    expect(split.allocations.find((a) => a.stationDbId === 'sta_b')?.allocatedKw).toBe(20);
    expect(split.validToMs).toBe(freshUntil.getTime());
  });

  it('orders every profile against the limit it replaces', () => {
    const allocation = {
      stationId: 'CS-1',
      stationDbId: 'sta_1',
      allocatedKw: 40,
      currentDrawKw: 0,
    };
    const commands = limitCommands(
      [allocation],
      new Map([['sta_1', 30]]),
      new Map([['sta_1', { baseKw: 20, previousBaseKw: 25, validTo: new Date() }]]),
    );
    const { cuts, raises } = orderLimitCommands(commands);
    expect(cuts.map((c) => c.kw)).toEqual([20]);
    expect(raises.map((c) => [c.kw, c.validTo != null])).toEqual([[40, true]]);
    expect(
      limitCommands(
        [allocation],
        new Map(),
        new Map([['sta_1', { baseKw: 20, validTo: new Date() }]]),
        true,
      ),
    ).toHaveLength(1);
  });
});

describe('remembered energy assets of sites the cycle no longer reads', () => {
  it('forgets a deleted site and drops sites not read for the maximum age', async () => {
    setResult('siteEnergyAssets', []);
    setResult('transformers', []);
    setResult('panels', [
      {
        id: 'p1',
        parentPanelId: null,
        name: 'Main',
        breakerRatingAmps: 200,
        voltageV: 240,
        phases: 1,
        maxContinuousKw: '100',
        safetyMarginKw: '0',
        oversubscriptionRatio: '1.0',
        phaseConnections: null,
        transformerId: null,
      },
    ]);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);
    await buildSiteHierarchy('site-a', [], { log: makeLogger() });
    await buildSiteHierarchy('site-b', [], { log: makeLogger() });
    expect(rememberedEnergyAssetSiteIds().sort()).toEqual(['site-a', 'site-b']);

    forgetRememberedEnergyAssets('site-a');
    expect(rememberedEnergyAssetSiteIds()).toEqual(['site-b']);

    pruneRememberedEnergyAssets(Date.now() + REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS - 1_000);
    expect(rememberedEnergyAssetSiteIds()).toEqual(['site-b']);
    pruneRememberedEnergyAssets(Date.now() + REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS + 1_000);
    expect(rememberedEnergyAssetSiteIds()).toEqual([]);
  });
});
