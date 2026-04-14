// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('postgres', () => ({
  default: vi.fn(() => vi.fn()),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  siteLoadManagement: {},
  panels: {},
  circuits: {},
  unmanagedLoads: {},
  chargingStations: {},
  chargingSessions: {},
  meterValues: {},
  connectors: {},
  evses: {},
  loadAllocationLog: {},
  evChargingNeeds: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
}));

import {
  computeEqualShareAllocation,
  computePriorityAllocation,
} from '../services/load-management.service.js';

interface StationPowerInfo {
  id: string;
  stationId: string;
  circuitId: string | null;
  currentDrawKw: number;
  maxPowerKw: number;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
  departureTime: Date | null;
  phasePowerKw: { L1: number; L2: number; L3: number };
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
    // Equal share = 50 each. CS-001 capped at 20, surplus (30) redistributed to CS-002
    expect(s1?.allocatedKw).toBe(20);
    expect(s2?.allocatedKw).toBe(30);
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
});
