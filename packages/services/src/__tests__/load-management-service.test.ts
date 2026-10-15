// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceLogger } from '@evtivity/lib';

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
  | 'chargingProfiles';

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
    chain['then'] = (
      onFulfilled: (v: unknown[]) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onFulfilled, onRejected);
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
  isOperatorStation: vi.fn(() => 'OPERATOR_STATION'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
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
  type HierarchyNode,
  type StationPowerInfo,
  type AllocationResult,
} from '../load-management.service.js';

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
  it('clears the load management profile by its id, once per station', async () => {
    const log = makeLogger();

    await expect(clearLoadManagementProfiles(['CS-001', 'CS-001', 'CS-002'], log)).resolves.toBe(
      true,
    );

    const clears = pubsubState.publish.mock.calls
      .filter((c) => c[0] === 'ocpp_commands')
      .map((c) => JSON.parse(c[1]));
    expect(clears).toHaveLength(2);
    expect(clears[0]).toMatchObject({
      stationId: 'CS-001',
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: LOAD_MANAGEMENT_PROFILE_ID },
    });
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
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({
      stationId: 'CS-OLD',
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: LOAD_MANAGEMENT_PROFILE_ID },
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
    expect(actions).toEqual(['SetChargingProfile:CS-001', 'ClearChargingProfile:CS-001']);
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

    await expect(runLoadManagementCycle(log, 'site-broken')).resolves.toBeUndefined();

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
