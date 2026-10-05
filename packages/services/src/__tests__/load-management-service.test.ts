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
  | 'evChargingNeeds';

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
  ]) {
    tables[name] = { __table: name };
  }

  // results: TableName -> rows[] returned by a select rooted at that table.
  const results = new Map<string, unknown[]>();
  // insertCalls: TableName -> array of inserted value objects.
  const insertCalls: Array<{ table: string; values: unknown }> = [];

  function reset(): void {
    results.clear();
    insertCalls.length = 0;
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
  };

  return { tables, results, insertCalls, reset, db, makeSelectFactory };
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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
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
  applyAllocations,
  runLoadManagementCycle,
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

  it('returns empty when no available power', () => {
    const stations = [makeStation({ id: 's1', stationId: 'CS-001', maxPowerKw: 50 })];

    const result = computeEqualShareAllocation(stations, 0);

    expect(result).toEqual([]);
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
    // Priority 1: no remaining power, not allocated
    expect(s1?.allocatedKw).toBe(30);
    expect(s2?.allocatedKw).toBe(70);
    expect(s3).toBeUndefined();
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
    expect(s2).toBeUndefined();
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
    // Two connectors summed for max power: 50 + 25 = 75
    setResult('connectors', [
      { stationId: 'sta_1', maxPowerKw: '50' },
      { stationId: 'sta_1', maxPowerKw: '25' },
      { stationId: 'sta_1', maxPowerKw: null },
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

describe('applyAllocations', () => {
  it('writes the allocation log and dispatches a charging profile per station', async () => {
    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 22.5, currentDrawKw: 10 },
      { stationId: 'CS-002', stationDbId: 'sta_2', allocatedKw: 7.4, currentDrawKw: 3 },
    ];
    const log = makeLogger();

    await applyAllocations('site-1', allocations, { strategy: 'equal_share' }, 13, log);

    // One allocation log insert with computed totals.
    expect(dbState.insertCalls).toHaveLength(1);
    const inserted = dbState.insertCalls[0];
    expect(inserted?.table).toBe('loadAllocationLog');
    const values = inserted?.values as Record<string, unknown>;
    expect(values['siteId']).toBe('site-1');
    expect(values['strategy']).toBe('equal_share');
    // totalAllocatedKw = 22.5 + 7.4 = 29.9
    expect(values['siteLimitKw']).toBe('29.9');
    expect(values['availableKw']).toBe('29.9');
    expect(values['totalDrawKw']).toBe('13');
    expect(values['allocations']).toEqual([
      { stationId: 'CS-001', allocatedKw: 22.5, currentDrawKw: 10 },
      { stationId: 'CS-002', allocatedKw: 7.4, currentDrawKw: 3 },
    ]);

    // One SetChargingProfile publish per station plus one csms_events broadcast.
    const ocppPublishes = pubsubState.publish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
    expect(ocppPublishes).toHaveLength(2);

    const payloads = ocppPublishes.map((c) => JSON.parse(c[1]));
    const p1 = payloads.find((p) => p.stationId === 'CS-001');
    const p2 = payloads.find((p) => p.stationId === 'CS-002');

    expect(p1.action).toBe('SetChargingProfile');
    expect(p1.payload.evseId).toBe(0);
    expect(p1.payload.chargingProfile.chargingProfilePurpose).toBe(
      'ChargingStationExternalConstraints',
    );
    expect(p1.payload.chargingProfile.chargingProfileKind).toBe('Absolute');
    const period1 = p1.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0];
    expect(p1.payload.chargingProfile.chargingSchedule[0].chargingRateUnit).toBe('W');
    expect(period1.startPeriod).toBe(0);
    // 22.5 kW -> 22500 W
    expect(period1.limit).toBe(22500);
    // 7.4 kW * 1000 = 7400, rounded
    expect(p2.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].limit).toBe(
      7400,
    );

    // Broadcast load update on csms_events.
    const broadcasts = pubsubState.publish.mock.calls.filter((c) => c[0] === 'csms_events');
    expect(broadcasts).toHaveLength(1);
    const event = JSON.parse(broadcasts[0]?.[1] as string);
    expect(event).toEqual({
      eventType: 'load.updated',
      siteId: 'site-1',
      stationId: null,
      sessionId: null,
    });
  });

  it('logs and continues when a SetChargingProfile publish fails (fail-open)', async () => {
    const log = makeLogger();
    // Fail only the ocpp_commands publish; csms_events should still go through.
    pubsubState.publish.mockImplementation(async (channel: string) => {
      if (channel === 'ocpp_commands') {
        throw new Error('redis down');
      }
    });

    const allocations: AllocationResult[] = [
      { stationId: 'CS-001', stationDbId: 'sta_1', allocatedKw: 10, currentDrawKw: 0 },
    ];

    await applyAllocations('site-1', allocations, { strategy: 'priority_based' }, 0, log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-001' }),
      'Failed to dispatch SetChargingProfile',
    );
    // The broadcast still fired despite the dispatch failure.
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

    await expect(
      applyAllocations('site-1', [], { strategy: 'equal_share' }, 0, log),
    ).resolves.toBeUndefined();

    // No error logged for the broadcast failure (it is swallowed silently).
    expect(log.error).not.toHaveBeenCalled();
  });

  it('writes a zero-total log and no dispatches for empty allocations', async () => {
    const log = makeLogger();

    await applyAllocations('site-1', [], { strategy: 'equal_share' }, 4, log);

    expect(dbState.insertCalls).toHaveLength(1);
    const values = dbState.insertCalls[0]?.values as Record<string, unknown>;
    expect(values['siteLimitKw']).toBe('0');
    expect(values['totalDrawKw']).toBe('4');
    expect(values['allocations']).toEqual([]);
    const ocppPublishes = pubsubState.publish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
    expect(ocppPublishes).toHaveLength(0);
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

  it('applies allocations for an enabled site and logs the cycle', async () => {
    setResult('siteLoadManagement', [{ siteId: 'site-1', strategy: 'equal_share' }]);
    // getSitePowerStatus
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: 'c1' },
    ]);
    setResult('connectors', [{ stationId: 'sta_1', maxPowerKw: '100' }]);
    setResult('chargingSessions', [{ stationId: 'sta_1' }]);
    setResult('meterValues', [{ stationId: 'sta_1', value: '4000', unit: 'W', phase: null }]);
    setResult('evChargingNeeds', []);
    // buildSiteHierarchy
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

    const log = makeLogger();

    await runLoadManagementCycle(log, 'site-1');

    // Allocation log written and a charging profile dispatched.
    expect(dbState.insertCalls.some((c) => c.table === 'loadAllocationLog')).toBe(true);
    const ocppPublishes = pubsubState.publish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
    expect(ocppPublishes).toHaveLength(1);
    const payload = JSON.parse(ocppPublishes[0]?.[1] as string);
    // Circuit available = 40, single station capped by maxPower 100 -> allocated 40 -> 40000 W
    expect(
      payload.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod[0].limit,
    ).toBe(40000);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1', strategy: 'equal_share', stationCount: 1 }),
      'Load management cycle applied',
    );
  });

  it('skips re-applying when allocations are unchanged from the previous cycle', async () => {
    setResult('siteLoadManagement', [{ siteId: 'site-stable', strategy: 'equal_share' }]);
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: 'c1' },
    ]);
    setResult('connectors', [{ stationId: 'sta_1', maxPowerKw: '100' }]);
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

    const log = makeLogger();

    // First cycle applies.
    await runLoadManagementCycle(log, 'site-stable');
    const firstInsertCount = dbState.insertCalls.length;
    expect(firstInsertCount).toBeGreaterThan(0);

    pubsubState.publish.mockClear();
    dbState.insertCalls.length = 0;

    // Second cycle with identical inputs -> allocation hash matches -> no apply.
    await runLoadManagementCycle(log, 'site-stable');

    expect(dbState.insertCalls).toHaveLength(0);
    expect(pubsubState.publish).not.toHaveBeenCalled();
  });

  it('produces empty allocations when the site has no panels configured', async () => {
    setResult('siteLoadManagement', [{ siteId: 'site-nopanels', strategy: 'equal_share' }]);
    setResult('chargingStations', [
      { id: 'sta_1', stationId: 'CS-001', isOnline: true, loadPriority: 5, circuitId: null },
    ]);
    setResult('connectors', []);
    setResult('chargingSessions', []);
    setResult('meterValues', []);
    setResult('evChargingNeeds', []);
    // No panels -> hierarchy empty -> allocations []
    setResult('panels', []);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);

    const log = makeLogger();

    await runLoadManagementCycle(log, 'site-nopanels');

    // applyAllocations is still called with [] (first cycle, hash changed from undefined).
    expect(dbState.insertCalls.some((c) => c.table === 'loadAllocationLog')).toBe(true);
    const ocppPublishes = pubsubState.publish.mock.calls.filter((c) => c[0] === 'ocpp_commands');
    expect(ocppPublishes).toHaveLength(0);
  });

  it('catches per-site errors and continues the loop', async () => {
    setResult('siteLoadManagement', [{ siteId: 'site-broken', strategy: 'equal_share' }]);
    // The first select (enabledSites) must succeed; force the next select inside
    // getSitePowerStatus to throw so the per-site try/catch is exercised. The
    // default select factory makes a chain rooted at the routed table, so the
    // enabledSites query still resolves from the siteLoadManagement result.
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

    dbState.db.select.mockImplementation(() => dbState.makeSelectFactory()());
  });

  it('runs across all enabled sites when no target site is given', async () => {
    setResult('siteLoadManagement', [
      { siteId: 'site-a', strategy: 'equal_share' },
      { siteId: 'site-b', strategy: 'priority_based' },
    ]);
    // Both sites resolve to no stations -> empty status, empty hierarchy.
    setResult('chargingStations', []);
    setResult('panels', []);
    setResult('circuits', []);
    setResult('unmanagedLoads', []);

    const log = makeLogger();

    await runLoadManagementCycle(log);

    // Two allocation-log inserts (one per site, both first-cycle with empty allocations).
    const logInserts = dbState.insertCalls.filter((c) => c.table === 'loadAllocationLog');
    expect(logInserts).toHaveLength(2);
  });
});
