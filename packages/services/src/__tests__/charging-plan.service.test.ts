// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceLogger } from '@evtivity/lib';

const dbMock = vi.hoisted(() => ({
  bindDepartureSessions: vi.fn(),
  getElectricityRatePeriodsForSite: vi.fn(),
  getSitePlan: vi.fn(),
  getSitePlanSettings: vi.fn(),
  isFleetChargingEnabled: vi.fn(),
  listPlanDepartures: vi.fn(),
  listPlanSessions: vi.fn(),
  markSitePlanStale: vi.fn(),
  patchSitePlanEntries: vi.fn(),
  writeSitePlan: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  ...dbMock,
  db: {},
  isOperatorStation: vi.fn(),
}));

import {
  PLAN_SITE_NODE,
  bindDepartures,
  buildPlanInput,
  buildPlanNodes,
  circuitNodeId,
  departureAwareAllocation,
  departureAwarePlan,
  panelNodeId,
  phaseNodeId,
  transformerNodeId,
  transformerPhaseNodeId,
  planNeedsRun,
  holdNodeId,
  plannedStationCut,
  plannedStations,
  readinessWrites,
  snapToMinimum,
  storedSlotIndex,
  type StoredPlanEntry,
} from '../charging-plan.service.js';
import {
  circuitPhaseShare,
  legWeight,
  subPanelPhaseShare,
  type HierarchyNode,
  type StationPowerInfo,
} from '../load-management.service.js';
import type { PlanDepartureRow, PlanSessionRow, StoredSitePlan } from '@evtivity/database';
import type { PlanNodeUse } from '@evtivity/lib/charging-plan';

// 2026-11-02 01:00 UTC, a Monday, on a quarter hour.
const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const HOUR = 3_600_000;

function station(overrides: Partial<StationPowerInfo> & { id: string }): StationPowerInfo {
  return {
    stationId: overrides.id.toUpperCase(),
    circuitId: null,
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

function circuit(
  id: string,
  stations: StationPowerInfo[],
  overrides: Partial<HierarchyNode> = {},
): HierarchyNode {
  return {
    type: 'circuit',
    id,
    name: id,
    maxContinuousKw: 100,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations,
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

function panel(
  id: string,
  children: HierarchyNode[],
  overrides: Partial<HierarchyNode> = {},
): HierarchyNode {
  return {
    type: 'panel',
    id,
    name: id,
    maxContinuousKw: 200,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations: [],
    children,
    phases: 1,
    breakerRatingAmps: 200,
    voltageV: 240,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    ...overrides,
  };
}

function weightOn(path: PlanNodeUse[] | undefined, nodeId: string): number {
  return (path ?? []).filter((u) => u.nodeId === nodeId).reduce((sum, u) => sum + u.weight, 0);
}

function departure(overrides: Partial<PlanDepartureRow> & { id: string }): PlanDepartureRow {
  return {
    vehicleId: 'veh_1',
    departureAt: new Date(NOW + 6 * HOUR),
    targetKind: 'energy',
    targetEnergyKwh: 40,
    targetSocPercent: null,
    priority: 5,
    sessionId: null,
    batteryCapacityKwh: null,
    maxChargePowerKw: null,
    ...overrides,
  };
}

function session(overrides: Partial<PlanSessionRow> & { id: string }): PlanSessionRow {
  return {
    stationDbId: 'sta_a',
    evseDbId: 'evs_a1',
    vehicleId: 'veh_1',
    transactionId: 'tx-1',
    energyDeliveredWh: 0,
    lastSocPercent: null,
    lastSocAt: null,
    evseMaxKw: 22,
    acCharging: false,
    evseNumber: 1,
    ...overrides,
  };
}

function makeLogger(): ServiceLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  dbMock.isFleetChargingEnabled.mockResolvedValue(true);
  dbMock.getElectricityRatePeriodsForSite.mockResolvedValue([]);
  dbMock.getSitePlanSettings.mockResolvedValue({ timezone: 'UTC', bufferMinutes: 30 });
  dbMock.getSitePlan.mockResolvedValue(null);
  dbMock.listPlanDepartures.mockResolvedValue([]);
  dbMock.listPlanSessions.mockResolvedValue([]);
  dbMock.bindDepartureSessions.mockResolvedValue([]);
  dbMock.writeSitePlan.mockResolvedValue({ changed: [] });
  dbMock.markSitePlanStale.mockResolvedValue(true);
  dbMock.patchSitePlanEntries.mockResolvedValue(1);
});

describe('buildPlanNodes', () => {
  it('weights a lower-voltage circuit at the leg weight on every panel above it', () => {
    const s = station({ id: 'sta_a' });
    const branch = circuit('cir_120', [s], { voltageV: 120 });
    const sub = panel('pnl_sub', [branch]);
    const root = panel('pnl_root', [sub]);
    const { paths } = buildPlanNodes([root], new Map());
    const path = paths.get('sta_a');
    expect(weightOn(path, circuitNodeId('cir_120'))).toBe(1);
    expect(weightOn(path, panelNodeId('pnl_sub'))).toBe(legWeight(sub, branch));
    expect(weightOn(path, panelNodeId('pnl_sub'))).toBe(2);
    expect(weightOn(path, panelNodeId('pnl_root'))).toBe(2);
    expect(weightOn(path, PLAN_SITE_NODE)).toBe(1);
  });

  it('counts each circuit of a three-phase panel on its phases at the cycle share', () => {
    const s1 = station({ id: 'sta_1' });
    const s2 = station({ id: 'sta_2' });
    const s3 = station({ id: 'sta_3' });
    const root = panel(
      'pnl_3p',
      [
        circuit('cir_l1', [s1], { phases: 3, phaseConnections: 'L1' }),
        circuit('cir_l1l2', [s2], { phases: 3, phaseConnections: 'L1L2' }),
        circuit('cir_all', [s3], { phases: 3, phaseConnections: null }),
      ],
      { phases: 3, voltageV: 230, perPhaseCapacityKw: 60, phaseLoad: { L1: 0, L2: 0, L3: 0 } },
    );
    const { paths } = buildPlanNodes([root], new Map());
    for (const [stationId, connections] of [
      ['sta_1', 'L1'],
      ['sta_2', 'L1L2'],
      ['sta_3', null],
    ] as const) {
      const { phases, share } = circuitPhaseShare(connections, 3);
      for (const phase of ['L1', 'L2', 'L3'] as const) {
        expect(weightOn(paths.get(stationId), phaseNodeId('pnl_3p', phase))).toBeCloseTo(
          phases.includes(phase) ? share : 0,
          12,
        );
      }
    }
    expect(weightOn(paths.get('sta_2'), phaseNodeId('pnl_3p', 'L1'))).toBeCloseTo(
      1 / Math.sqrt(3),
      12,
    );
    expect(weightOn(paths.get('sta_3'), phaseNodeId('pnl_3p', 'L2'))).toBeCloseTo(1 / 3, 12);
  });

  it('counts a single-phase sub-panel on the phases that feed it', () => {
    const s = station({ id: 'sta_a' });
    const sub = panel('pnl_sub', [circuit('cir_a', [s], { voltageV: 240 })], {
      voltageV: 240,
      phaseConnections: 'L1L2',
    });
    const root = panel('pnl_3p', [sub], {
      phases: 3,
      voltageV: 120,
      perPhaseCapacityKw: 40,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
    });
    const { paths } = buildPlanNodes([root], new Map());
    const { phases, share } = subPanelPhaseShare(root, sub);
    expect(phases).toEqual(['L1', 'L2']);
    expect(weightOn(paths.get('sta_a'), phaseNodeId('pnl_3p', 'L1'))).toBeCloseTo(share, 12);
    expect(weightOn(paths.get('sta_a'), phaseNodeId('pnl_3p', 'L3'))).toBe(0);
  });

  it('leaves the capacity after the safety margin, unmanaged loads and reservations', () => {
    const online = station({ id: 'sta_a' });
    const offline = station({ id: 'sta_b', isOnline: false });
    const root = panel(
      'pnl_root',
      [circuit('cir_a', [online, offline], { maxContinuousKw: 80, unmanagedLoadKw: 5 })],
      { maxContinuousKw: 150, safetyMarginKw: 10, unmanagedLoadKw: 20 },
    );
    const { headroomKw } = buildPlanNodes([root], new Map([['sta_b', 15]]));
    expect(headroomKw.get(circuitNodeId('cir_a'))).toBe(80 - 5 - 15);
    expect(headroomKw.get(panelNodeId('pnl_root'))).toBe(150 - 10 - 20 - 5 - 15);
    expect(headroomKw.get(PLAN_SITE_NODE)).toBe(100);
  });

  it('plans within a service transformer, with the live credit in slot 0 only (D10)', () => {
    const s = station({ id: 'sta_a' });
    const boardA = panel('pnl_a', [circuit('cir_a', [s], { maxContinuousKw: 200 })], {
      maxContinuousKw: 200,
    });
    const boardB = panel('pnl_b', [circuit('cir_b', [], { maxContinuousKw: 200 })], {
      maxContinuousKw: 200,
      supplyLoadKw: 10,
    });
    const tx = panel('tfm_svc', [boardA, boardB], {
      type: 'transformer',
      transformerKind: 'service',
      maxContinuousKw: 100,
      supplyCreditKw: 30,
    });
    const { headroomKw, liveHeadroomKw, paths } = buildPlanNodes([tx], new Map());
    expect(weightOn(paths.get('sta_a'), transformerNodeId('tfm_svc'))).toBe(1);
    expect(weightOn(paths.get('sta_a'), panelNodeId('pnl_a'))).toBe(1);
    // Grid only: 100 less the battery load of 10; slot 0: plus the 30 credit.
    expect(headroomKw.get(transformerNodeId('tfm_svc'))).toBe(90);
    expect(liveHeadroomKw.get(transformerNodeId('tfm_svc'))).toBe(120);
    expect(headroomKw.get(PLAN_SITE_NODE)).toBe(90);
    expect(liveHeadroomKw.get(PLAN_SITE_NODE)).toBe(120);
  });

  it('maps a step-down secondary phase onto two primary phases (D16)', () => {
    const s = station({ id: 'sta_a' });
    const sub = panel('pnl_sub', [circuit('cir_a', [s], { phases: 3, phaseConnections: 'L1' })], {
      phases: 3,
      voltageV: 120,
      perPhaseCapacityKw: 30,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
    });
    const stepDown = panel('tfm_sd', [sub], {
      type: 'transformer',
      transformerKind: 'step_down',
      phases: 3,
      maxContinuousKw: 90,
      perPhaseCapacityKw: 30,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
    });
    const main = panel('pnl_main', [stepDown], {
      phases: 3,
      voltageV: 277,
      perPhaseCapacityKw: 100,
      phaseLoad: { L1: 0, L2: 0, L3: 0 },
      supplyPhaseCreditKw: { L1: 5, L2: 5, L3: 5 },
    });
    const { paths, headroomKw, liveHeadroomKw } = buildPlanNodes([main], new Map());
    const path = paths.get('sta_a');
    expect(weightOn(path, transformerPhaseNodeId('tfm_sd', 'L1'))).toBe(1);
    expect(weightOn(path, transformerPhaseNodeId('tfm_sd', 'L2'))).toBe(0);
    expect(weightOn(path, phaseNodeId('pnl_main', 'L1'))).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(weightOn(path, phaseNodeId('pnl_main', 'L2'))).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(weightOn(path, phaseNodeId('pnl_main', 'L3'))).toBe(0);
    expect(headroomKw.get(phaseNodeId('pnl_main', 'L1'))).toBe(100);
    expect(liveHeadroomKw.get(phaseNodeId('pnl_main', 'L1'))).toBe(105);
  });
});

describe('bindDepartures', () => {
  it('binds a session to the earliest departure of its vehicle within the horizon', () => {
    const departures = [
      departure({ id: 'vdp_past', departureAt: new Date(NOW - HOUR) }),
      departure({ id: 'vdp_first', departureAt: new Date(NOW + 2 * HOUR) }),
      departure({ id: 'vdp_second', departureAt: new Date(NOW + 26 * HOUR) }),
    ];
    const result = bindDepartures(departures, [session({ id: 'ses_1' })], NOW);
    expect(result.writes).toEqual([{ departureId: 'vdp_first', sessionId: 'ses_1' }]);
    expect(result.sessions.get('vdp_first')?.id).toBe('ses_1');
  });

  it('keeps an existing binding and writes nothing for it', () => {
    const departures = [
      departure({ id: 'vdp_first', departureAt: new Date(NOW + 2 * HOUR) }),
      departure({ id: 'vdp_bound', departureAt: new Date(NOW + 4 * HOUR), sessionId: 'ses_1' }),
    ];
    const result = bindDepartures(departures, [session({ id: 'ses_1' })], NOW);
    expect(result.writes).toEqual([]);
    expect(result.sessions.get('vdp_bound')?.id).toBe('ses_1');
    expect(result.sessions.has('vdp_first')).toBe(false);
  });

  it('unbinds a departure whose session now charges another vehicle and binds that one', () => {
    const departures = [
      departure({ id: 'vdp_old', departureAt: new Date(NOW + 2 * HOUR), sessionId: 'ses_1' }),
      departure({ id: 'vdp_new', vehicleId: 'veh_2', departureAt: new Date(NOW + 3 * HOUR) }),
    ];
    const result = bindDepartures(departures, [session({ id: 'ses_1', vehicleId: 'veh_2' })], NOW);
    expect(result.writes).toEqual([
      { departureId: 'vdp_old', sessionId: null },
      { departureId: 'vdp_new', sessionId: 'ses_1' },
    ]);
    expect(result.sessions.has('vdp_old')).toBe(false);
    expect(result.sessions.get('vdp_new')?.id).toBe('ses_1');
  });

  it('binds nothing beyond the horizon, for another vehicle or a session without a vehicle', () => {
    const departures = [
      departure({ id: 'vdp_far', departureAt: new Date(NOW + 49 * HOUR) }),
      departure({ id: 'vdp_other', vehicleId: 'veh_2' }),
    ];
    const result = bindDepartures(
      departures,
      [session({ id: 'ses_1' }), session({ id: 'ses_2', vehicleId: null })],
      NOW,
    );
    expect(result.writes).toEqual([]);
    expect(result.sessions.size).toBe(0);
  });
});

describe('plan staleness', () => {
  const fresh: StoredSitePlan = {
    computedAt: new Date(NOW + 60_000),
    staleAt: null,
    trigger: 'slot_boundary',
    slotStarts: [new Date(NOW + 60_000).toISOString()],
    plan: [],
  };

  it('replans a missing, empty or stale plan, and one from before the current slot', () => {
    const later = NOW + 5 * 60_000;
    expect(planNeedsRun(null, later)).toBe(true);
    expect(planNeedsRun({ ...fresh, plan: null }, later)).toBe(true);
    expect(planNeedsRun({ ...fresh, staleAt: new Date(later) }, later)).toBe(true);
    expect(planNeedsRun(fresh, later)).toBe(false);
    expect(planNeedsRun(fresh, NOW + 15 * 60_000)).toBe(true);
  });

  it('reads the plan time from its first slot, the worker clock, not the database time', () => {
    const later = NOW + 5 * 60_000;
    // The database clock ran behind the worker: computed_at falls before the slot.
    const skewed = { ...fresh, computedAt: new Date(NOW - 30_000) };
    expect(planNeedsRun(skewed, later)).toBe(false);
    // A plan without slots falls back to its computed time.
    expect(planNeedsRun({ ...skewed, slotStarts: [] }, later)).toBe(true);
  });

  it('finds the stored slot of now and nothing past the plan', () => {
    const starts = [
      new Date(NOW).toISOString(),
      new Date(NOW + 15 * 60_000).toISOString(),
      new Date(NOW + 30 * 60_000).toISOString(),
    ];
    expect(storedSlotIndex(starts, NOW - 1)).toBe(-1);
    expect(storedSlotIndex(starts, NOW + 20 * 60_000)).toBe(1);
    expect(storedSlotIndex(starts, NOW + 44 * 60_000)).toBe(2);
    expect(storedSlotIndex(starts, NOW + 45 * 60_000)).toBe(-1);
    expect(storedSlotIndex('bad', NOW)).toBe(-1);
  });
});

describe('plannedStations', () => {
  const entries: StoredPlanEntry[] = [
    {
      departureId: 'vdp_1',
      vehicleId: 'veh_1',
      sessionId: 'ses_1',
      stationDbId: 'sta_a',
      evseDbId: 'evs_a1',
      minKw: 4,
      powerKw: [7, 11],
    },
    {
      departureId: 'vdp_2',
      vehicleId: 'veh_2',
      sessionId: 'ses_ended',
      stationDbId: 'sta_b',
      evseDbId: null,
      minKw: 0,
      powerKw: [9, 9],
    },
  ];

  it('sums the slot power per station for sessions still active and flags shared stations', () => {
    const result = plannedStations(entries, 1, [
      session({ id: 'ses_1' }),
      session({ id: 'ses_x', stationDbId: 'sta_a', evseDbId: 'evs_a2', vehicleId: null }),
    ]);
    expect([...result.plannedKw]).toEqual([['sta_a', 11]]);
    expect([...result.sharing]).toEqual(['sta_a']);
    expect([...result.minKw]).toEqual([['sta_a', 4]]);
  });

  it('turns a slot power between 0 and the minimum into 0 or the minimum', () => {
    expect(snapToMinimum(3, 4.14)).toBe(4.14);
    expect(snapToMinimum(1, 4.14)).toBe(0);
    expect(snapToMinimum(5, 4.14)).toBe(5);
    expect(snapToMinimum(0, 4.14)).toBe(0);
    expect(snapToMinimum(2, 0)).toBe(2);
    const result = plannedStations([{ ...entries[0]!, powerKw: [1] }], 0, [
      session({ id: 'ses_1' }),
    ]);
    expect(result.plannedKw.get('sta_a')).toBe(0);
    expect(result.minKw.has('sta_a')).toBe(false);
  });

  it('plans nothing outside the stored slots', () => {
    const result = plannedStations(entries, -1, [session({ id: 'ses_1' })]);
    expect(result.plannedKw.get('sta_a')).toBe(0);
  });

  it('detects a planned station cut below its plan', () => {
    const planned = new Map([['sta_a', 11]]);
    const alloc = (kw: number) => [
      { stationId: 'STA_A', stationDbId: 'sta_a', allocatedKw: kw, currentDrawKw: 0 },
    ];
    expect(plannedStationCut(alloc(11), planned)).toBe(false);
    expect(plannedStationCut(alloc(8), planned)).toBe(true);
  });
});

describe('buildPlanInput', () => {
  const s = station({ id: 'sta_a', circuitId: 'cir_a', minPowerKw: 4 });
  const idle = station({ id: 'sta_b', circuitId: 'cir_a', currentDrawKw: 6 });
  const hierarchy = [
    panel('pnl_root', [circuit('cir_a', [s, idle], { maxContinuousKw: 40 })], {
      maxContinuousKw: 60,
    }),
  ];

  function build(
    departures: PlanDepartureRow[],
    sessions: PlanSessionRow[],
    ratePeriods: Parameters<typeof buildPlanInput>[0]['ratePeriods'] = [],
  ) {
    return buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods,
      hierarchy,
      stations: [s, idle],
      reservedKw: new Map(),
      previous: [{ stationId: 'STA_B', stationDbId: 'sta_b', allocatedKw: 10 }],
      departures,
      sessions,
      binding: bindDepartures(departures, sessions, NOW),
    });
  }

  it('plans a plugged-in vehicle on its station path and a waiting one on the site alone', () => {
    const departures = [
      departure({ id: 'vdp_plugged', maxChargePowerKw: 30 }),
      departure({ id: 'vdp_waiting', vehicleId: 'veh_2', maxChargePowerKw: 30 }),
    ];
    const sessions = [
      session({ id: 'ses_1', energyDeliveredWh: 5000 }),
      session({ id: 'ses_2', stationDbId: 'sta_b', evseDbId: 'evs_b1', vehicleId: null }),
    ];
    const { input } = build(departures, sessions);
    const [plugged, waiting] = input.vehicles;
    expect(plugged?.availableFromMs).toBe(NOW);
    expect(plugged?.neededKwh).toBe(35);
    expect(plugged?.maxKw).toBe(22);
    expect(plugged?.minKw).toBe(4);
    expect(weightOn(plugged?.path, circuitNodeId('cir_a'))).toBe(1);
    expect(waiting?.availableFromMs).toBe(NOW + 6 * HOUR);
    expect(waiting?.path).toEqual([{ nodeId: PLAN_SITE_NODE, weight: 1 }]);
    expect(waiting?.maxKw).toBe(30);
    // The unplanned session holds its share of the circuit (40 kW over two sessions),
    // above its last allocation (10) and draw (6), in the first two slots only.
    expect(input.nodeCapacityKw[circuitNodeId('cir_a')]?.slice(0, 3)).toEqual([20, 20, 40]);
  });

  it('gives slot 0 the live supply credit and the later slots the grid only (D10)', () => {
    const tx = panel(
      'tfm_svc',
      [panel('pnl_a', [circuit('cir_a', [s], { maxContinuousKw: 200 })], { maxContinuousKw: 200 })],
      { type: 'transformer', transformerKind: 'service', maxContinuousKw: 100, supplyCreditKw: 25 },
    );
    const departures = [departure({ id: 'vdp_plugged', maxChargePowerKw: 30 })];
    const sessions = [session({ id: 'ses_1' })];
    const { input } = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [tx],
      stations: [s],
      reservedKw: new Map(),
      previous: null,
      departures,
      sessions,
      binding: bindDepartures(departures, sessions, NOW),
    });
    expect(input.nodeCapacityKw[transformerNodeId('tfm_svc')]?.slice(0, 3)).toEqual([
      125, 100, 100,
    ]);
    expect(input.nodeCapacityKw[PLAN_SITE_NODE]?.slice(0, 2)).toEqual([125, 100]);
  });

  it('holds the share of a session that just started and has no allocation yet', () => {
    const fresh = station({ id: 'sta_b', circuitId: 'cir_a', currentDrawKw: 0 });
    const departures = [departure({ id: 'vdp_plugged' })];
    const sessions = [
      session({ id: 'ses_1' }),
      session({ id: 'ses_new', stationDbId: 'sta_b', evseDbId: 'evs_b1', vehicleId: null }),
    ];
    const { input } = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [panel('pnl_root', [circuit('cir_a', [s, fresh], { maxContinuousKw: 40 })])],
      stations: [s, fresh],
      reservedKw: new Map(),
      previous: null,
      departures,
      sessions,
      binding: bindDepartures(departures, sessions, NOW),
    });
    expect(input.nodeCapacityKw[circuitNodeId('cir_a')]?.[0]).toBe(20);
  });

  it('holds the share of the unplanned session of a station that also charges a planned one', () => {
    const departures = [departure({ id: 'vdp_plugged' })];
    const sessions = [
      session({ id: 'ses_1' }),
      session({ id: 'ses_2', evseDbId: 'evs_a2', vehicleId: null }),
    ];
    const { input } = build(departures, sessions);
    // Two sessions on the circuit, both on sta_a: the unplanned one holds 20 kW.
    expect(input.nodeCapacityKw[circuitNodeId('cir_a')]?.[0]).toBe(20);
  });

  it('raises the minimum of an AC session to 6 A on its circuit, capped at its max', () => {
    const departures = [departure({ id: 'vdp_plugged', maxChargePowerKw: 11 })];
    const ac = [session({ id: 'ses_1', acCharging: true })];
    const { input } = build(departures, ac);
    // 6 A x 240 V = 1.44 kW on a single-phase circuit, below the station minimum of 4 kW.
    expect(input.vehicles[0]?.minKw).toBe(4);
    const threePhase = station({ id: 'sta_a', circuitId: 'cir_3' });
    const built = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [
        panel('pnl_3p', [circuit('cir_3', [threePhase], { phases: 3, voltageV: 230 })], {
          phases: 3,
          voltageV: 230,
          perPhaseCapacityKw: 100,
          phaseLoad: { L1: 0, L2: 0, L3: 0 },
        }),
      ],
      stations: [threePhase],
      reservedKw: new Map(),
      previous: null,
      departures,
      sessions: ac,
      binding: bindDepartures(departures, ac, NOW),
    });
    expect(built.input.vehicles[0]?.minKw).toBeCloseTo((6 * 230 * 3) / 1000, 9);
    const capped = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [
        panel('pnl_3p', [circuit('cir_3', [threePhase], { phases: 3, voltageV: 230 })], {
          phases: 3,
          voltageV: 230,
          perPhaseCapacityKw: 100,
          phaseLoad: { L1: 0, L2: 0, L3: 0 },
        }),
      ],
      stations: [threePhase],
      reservedKw: new Map(),
      previous: null,
      departures: [departure({ id: 'vdp_plugged', maxChargePowerKw: 3 })],
      sessions: ac,
      binding: bindDepartures([departure({ id: 'vdp_plugged' })], ac, NOW),
    });
    expect(capped.input.vehicles[0]?.minKw).toBe(3);
  });

  it('shares the station minimum between the planned sessions of one station', () => {
    const departures = [
      departure({ id: 'vdp_a', maxChargePowerKw: 30 }),
      departure({ id: 'vdp_b', vehicleId: 'veh_2', maxChargePowerKw: 30 }),
    ];
    const sessions = [
      session({ id: 'ses_1' }),
      session({ id: 'ses_2', evseDbId: 'evs_a2', vehicleId: 'veh_2' }),
    ];
    const { input } = build(departures, sessions);
    expect(input.vehicles.map((v) => v.minKw)).toEqual([2, 2]);
  });

  it('prices each slot with the site rate at its start', () => {
    const { input } = build(
      [departure({ id: 'vdp_1', departureAt: new Date(NOW + 2 * HOUR) })],
      [],
      [
        {
          id: 1,
          siteId: 'sit_1',
          name: 'Standard',
          ratePerKwh: '0.12',
          restrictions: null,
          priority: 0,
          isDefault: true,
        },
        {
          id: 2,
          siteId: 'sit_1',
          name: 'Night',
          ratePerKwh: '0.05',
          restrictions: { timeRange: { startTime: '02:00', endTime: '06:00' } },
          priority: 10,
          isDefault: false,
        },
      ],
    );
    expect(input.pricePerKwh.slice(0, 4)).toEqual([0.12, 0.12, 0.12, 0.12]);
    expect(input.pricePerKwh.slice(4, 8)).toEqual([0.05, 0.05, 0.05, 0.05]);
  });

  it('leaves out a SoC target whose vehicle has no battery capacity', () => {
    const { input, departures } = build(
      [
        departure({
          id: 'vdp_soc',
          targetKind: 'soc',
          targetEnergyKwh: null,
          targetSocPercent: 80,
        }),
      ],
      [],
    );
    expect(input.vehicles).toEqual([]);
    expect(departures).toEqual([]);
  });
});

describe('departureAwarePlan', () => {
  const s = station({ id: 'sta_a', circuitId: 'cir_a' });
  const hierarchy = [
    panel('pnl_root', [circuit('cir_a', [s], { maxContinuousKw: 40 })], { maxContinuousKw: 60 }),
  ];
  const ctx = (replan = true) => ({
    siteId: 'sit_1',
    hierarchy,
    stations: [s],
    reservedKw: new Map<string, number>(),
    previous: null,
    replan,
    log: makeLogger(),
    nowMs: NOW,
  });

  it('binds the session, plans, and writes the readiness of plugged and waiting departures', async () => {
    dbMock.listPlanDepartures.mockResolvedValue([
      departure({ id: 'vdp_plugged', targetEnergyKwh: 20, maxChargePowerKw: 11 }),
      departure({ id: 'vdp_waiting', vehicleId: 'veh_2', maxChargePowerKw: 11 }),
    ]);
    dbMock.listPlanSessions.mockResolvedValue([session({ id: 'ses_1' })]);
    const result = await departureAwarePlan(ctx());
    expect(dbMock.bindDepartureSessions).toHaveBeenCalledWith('sit_1', [
      { departureId: 'vdp_plugged', sessionId: 'ses_1' },
    ]);
    expect(dbMock.writeSitePlan).toHaveBeenCalledTimes(1);
    const [siteId, plan, readiness] = dbMock.writeSitePlan.mock.calls[0] as [
      string,
      { trigger: string; plan: StoredPlanEntry[]; staleAtRead: Date | null },
      Array<{ departureId: string; readiness: string | null }>,
    ];
    expect(siteId).toBe('sit_1');
    expect(plan.trigger).toBe('initial');
    expect(plan.staleAtRead).toBeNull();
    expect(plan.plan.map((e) => e.departureId)).toEqual(['vdp_plugged']);
    expect(readiness.find((r) => r.departureId === 'vdp_plugged')?.readiness).toBe('on_track');
    expect(readiness.find((r) => r.departureId === 'vdp_waiting')?.readiness).toBe(
      'waiting_for_vehicle',
    );
    expect(result.plannedKw.get('sta_a')).toBeGreaterThan(0);
  });

  it('warns when the planner takes longer than its runtime budget', async () => {
    dbMock.listPlanDepartures.mockResolvedValue([
      departure({ id: 'vdp_plugged', targetEnergyKwh: 20, maxChargePowerKw: 11 }),
    ]);
    dbMock.listPlanSessions.mockResolvedValue([session({ id: 'ses_1' })]);
    // The planner run reads the clock twice: a 300 ms run, over the 250 ms budget.
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 300;
      return clock;
    });
    const log = makeLogger();
    try {
      await departureAwarePlan({ ...ctx(), log });
    } finally {
      spy.mockRestore();
    }
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1', runtimeMs: 300, vehicles: 1 }),
      'Depot charging plan took longer than its budget',
    );
    expect(dbMock.writeSitePlan).toHaveBeenCalledTimes(1);
  });

  it('follows the stored plan and writes nothing while it is fresh', async () => {
    dbMock.listPlanDepartures.mockResolvedValue([
      departure({ id: 'vdp_plugged', sessionId: 'ses_1' }),
    ]);
    dbMock.listPlanSessions.mockResolvedValue([session({ id: 'ses_1' })]);
    dbMock.getSitePlan.mockResolvedValue({
      computedAt: new Date(NOW),
      staleAt: null,
      trigger: 'slot_boundary',
      slotStarts: [new Date(NOW).toISOString()],
      plan: [
        {
          departureId: 'vdp_plugged',
          vehicleId: 'veh_1',
          sessionId: 'ses_1',
          stationDbId: 'sta_a',
          evseDbId: 'evs_a1',
          minKw: 0,
          powerKw: [9.5],
        },
      ],
    } satisfies StoredSitePlan);
    const result = await departureAwarePlan(ctx());
    expect(dbMock.writeSitePlan).not.toHaveBeenCalled();
    expect(dbMock.bindDepartureSessions).not.toHaveBeenCalled();
    expect(result.plannedKw.get('sta_a')).toBe(9.5);
  });

  describe('measured draw', () => {
    const storedEntry = (measure?: Record<string, unknown>) => ({
      departureId: 'vdp_plugged',
      vehicleId: 'veh_1',
      sessionId: 'ses_1',
      stationDbId: 'sta_a',
      evseDbId: 'evs_a1',
      minKw: 0,
      powerKw: [9.5],
      profile: {
        id: 1,
        hash: 'h',
        slotStartMs: NOW,
        state: 'accepted',
        sentAt: new Date(NOW - 120_000).toISOString(),
        repliedAt: new Date(NOW - 60_000).toISOString(),
      },
      ...(measure != null ? { measure } : {}),
    });
    const measuring = (drawKw: number) => ({
      ...ctx(),
      stations: [{ ...s, evseDrawKw: { evs_a1: drawKw }, drawMeasured: true }],
    });

    beforeEach(() => {
      dbMock.listPlanDepartures.mockResolvedValue([
        departure({ id: 'vdp_plugged', sessionId: 'ses_1' }),
      ]);
      dbMock.listPlanSessions.mockResolvedValue([session({ id: 'ses_1' })]);
    });

    const storedPlan = (measure?: Record<string, unknown>): StoredSitePlan => ({
      computedAt: new Date(NOW),
      staleAt: null,
      trigger: 'slot_boundary',
      slotStarts: [new Date(NOW).toISOString()],
      plan: [storedEntry(measure)],
    });

    it('stores the measurement of a fresh plan without planning again', async () => {
      dbMock.getSitePlan.mockResolvedValue(storedPlan());
      await departureAwarePlan(measuring(4));
      expect(dbMock.writeSitePlan).not.toHaveBeenCalled();
      expect(dbMock.patchSitePlanEntries).toHaveBeenCalledWith('sit_1', [
        { sessionId: 'ses_1', patch: { measure: expect.objectContaining({ lowSinceMs: NOW }) } },
      ]);
    });

    it('plans again at once with a taper cap after a minute under 80 % of the limit', async () => {
      dbMock.getSitePlan.mockResolvedValue(storedPlan({ limitKw: 9.5, lowSinceMs: NOW - 60_000 }));
      await departureAwarePlan(measuring(4));
      const plan = dbMock.writeSitePlan.mock.calls[0]?.[1] as {
        trigger: string;
        plan: Array<{ powerKw: number[]; measure?: { taperCapKw?: number } }>;
      };
      expect(plan.trigger).toBe('taper');
      expect(plan.plan[0]?.measure?.taperCapKw).toBeCloseTo(4.4);
      expect(Math.max(...(plan.plan[0]?.powerKw ?? []))).toBeLessThanOrEqual(4.4);
    });

    it('holds a charger that does not follow its limit as fixed load and marks it at risk', async () => {
      dbMock.getSitePlan.mockResolvedValue(storedPlan({ limitKw: 9.5, highSinceMs: NOW - 60_000 }));
      const context = measuring(14);
      await departureAwarePlan(context);
      const [, plan, readiness] = dbMock.writeSitePlan.mock.calls[0] as [
        string,
        { trigger: string; plan: Array<{ measure?: { notFollowingKw?: number } }> },
        Array<{ departureId: string; readinessReason: string | null }>,
      ];
      expect(plan.trigger).toBe('charger_not_following');
      expect(plan.plan[0]?.measure?.notFollowingKw).toBe(14);
      expect(readiness.find((r) => r.departureId === 'vdp_plugged')?.readinessReason).toBe(
        'charger_not_following',
      );
      expect(context.log.warn).toHaveBeenCalled();
    });

    it('measures nothing on a read of the stored plan', async () => {
      dbMock.getSitePlan.mockResolvedValue(storedPlan());
      await departureAwarePlan({ ...measuring(4), replan: false });
      expect(dbMock.patchSitePlanEntries).not.toHaveBeenCalled();
    });
  });

  it('passes the stale mark it read back to the writer with the trigger that set it', async () => {
    const staleAt = new Date(NOW - 1000);
    dbMock.getSitePlan.mockResolvedValue({
      computedAt: new Date(NOW - 60_000),
      staleAt,
      trigger: 'panel_changed',
      slotStarts: [],
      plan: [],
    } satisfies StoredSitePlan);
    await departureAwarePlan(ctx());
    const plan = dbMock.writeSitePlan.mock.calls[0]?.[1] as { staleAtRead: Date; trigger: string };
    expect(plan.staleAtRead).toBe(staleAt);
    expect(plan.trigger).toBe('panel_changed');
  });

  it('only reads the stored plan outside the cycle', async () => {
    dbMock.listPlanDepartures.mockResolvedValue([departure({ id: 'vdp_plugged' })]);
    dbMock.listPlanSessions.mockResolvedValue([session({ id: 'ses_1' })]);
    await departureAwarePlan(ctx(false));
    expect(dbMock.bindDepartureSessions).not.toHaveBeenCalled();
    expect(dbMock.writeSitePlan).not.toHaveBeenCalled();
  });
});

describe('readinessWrites', () => {
  it('marks a plugged-in departure on an offline station at risk', () => {
    const offline = station({ id: 'sta_a', circuitId: 'cir_a', isOnline: false });
    const departures = [departure({ id: 'vdp_1', targetEnergyKwh: 10 })];
    const sessions = [session({ id: 'ses_1' })];
    const build = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [panel('pnl_root', [circuit('cir_a', [offline])])],
      stations: [offline],
      reservedKw: new Map([['sta_a', 22]]),
      previous: null,
      departures,
      sessions,
      binding: bindDepartures(departures, sessions, NOW),
    });
    const result = {
      entries: [
        {
          departureId: 'vdp_1',
          powerKw: [],
          plannedKwh: 10,
          shortfallKwh: 0,
          predictedReadyMs: NOW + HOUR,
          state: 'on_track' as const,
          departed: false,
          beyondHorizon: false,
          aloneKwh: 100,
          pluggedIn: true,
          pluggedNowKwh: 100,
          readiness: 'on_track' as const,
          readinessReason: null,
          extraPlannedKwh: 0,
          predictedMaxReadyMs: null,
        },
      ],
      nodeLoadKw: {},
      costPerKwhWeighted: 0,
    };
    const [write] = readinessWrites(build, result);
    expect(write?.readiness).toBe('at_risk');
    expect(write?.readinessReason).toBe('station_offline');
    // The reservation stays fixed load; the session waits out the hold slots at 0.
    expect(build.input.nodeCapacityKw[circuitNodeId('cir_a')]?.[0]).toBe(78);
    expect(build.input.nodeCapacityKw[holdNodeId('sta_a')]?.slice(0, 3)).toEqual([0, 0, 1_000_000]);
    expect(build.input.vehicles[0]?.path).toContainEqual({
      nodeId: holdNodeId('sta_a'),
      weight: 1,
    });
  });

  it('names a reserved online station whose limit is not confirmed as not following', () => {
    const pending = station({ id: 'sta_a', circuitId: 'cir_a' });
    const departures = [departure({ id: 'vdp_1', targetEnergyKwh: 10 })];
    const sessions = [session({ id: 'ses_1' })];
    const build = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [panel('pnl_root', [circuit('cir_a', [pending])])],
      stations: [pending],
      reservedKw: new Map([['sta_a', 22]]),
      previous: [{ stationId: 'STA_A', stationDbId: 'sta_a', allocatedKw: 22, limitPending: true }],
      departures,
      sessions,
      binding: bindDepartures(departures, sessions, NOW),
    });
    expect(build.departures[0]?.stationIssue).toBe('charger_not_following');
  });
});

describe('departureAwareAllocation', () => {
  const planned = station({ id: 'sta_a', circuitId: 'cir_a', maxPowerKw: 50 });
  const other = station({ id: 'sta_b', circuitId: 'cir_a', maxPowerKw: 50 });
  const ctx = {
    siteId: 'sit_1',
    stations: [planned, other],
    reservedKw: new Map<string, number>(),
    previous: null,
    replan: true,
    log: makeLogger(),
    nowMs: NOW,
  };
  const storedPlan = (kw: number): StoredSitePlan => ({
    computedAt: new Date(NOW),
    staleAt: null,
    trigger: 'slot_boundary',
    slotStarts: [new Date(NOW).toISOString()],
    plan: [
      {
        departureId: 'vdp_1',
        vehicleId: 'veh_1',
        sessionId: 'ses_1',
        stationDbId: 'sta_a',
        evseDbId: 'evs_a1',
        minKw: 0,
        powerKw: [kw],
      },
    ],
  });

  beforeEach(() => {
    dbMock.listPlanDepartures.mockResolvedValue([departure({ id: 'vdp_1', sessionId: 'ses_1' })]);
    dbMock.listPlanSessions.mockResolvedValue([
      session({ id: 'ses_1' }),
      session({ id: 'ses_2', stationDbId: 'sta_b', evseDbId: 'evs_b1', vehicleId: null }),
    ]);
  });

  it('is off while fleet charging is off', async () => {
    dbMock.isFleetChargingEnabled.mockResolvedValue(false);
    const result = await departureAwareAllocation({
      ...ctx,
      hierarchy: [panel('pnl_root', [circuit('cir_a', [planned, other])])],
    });
    expect(result).toBeNull();
    expect(dbMock.listPlanDepartures).not.toHaveBeenCalled();
  });

  it('holds a station that refused its plan profile at the sum of its planned sessions', async () => {
    const stored = storedPlan(12);
    (stored.plan as Array<Record<string, unknown>>)[0]!['profile'] = {
      id: 1,
      hash: 'h',
      slotStartMs: NOW,
      state: 'rejected',
      sentAt: new Date(NOW).toISOString(),
      rejectedAt: new Date(NOW).toISOString(),
    };
    dbMock.getSitePlan.mockResolvedValue(stored);
    const result = await departureAwareAllocation({
      ...ctx,
      hierarchy: [
        panel('pnl_root', [circuit('cir_a', [planned, other], { maxContinuousKw: 40 })], {
          maxContinuousKw: 100,
        }),
      ],
    });
    // The station limit is the ceiling: the planned 12 kW, whatever the station did with its profile.
    expect(new Map((result ?? []).map((a) => [a.stationDbId, a.allocatedKw])).get('sta_a')).toBe(
      12,
    );
  });

  it('gives the planned station its slot power and the others the rest', async () => {
    dbMock.getSitePlan.mockResolvedValue(storedPlan(12));
    const result = await departureAwareAllocation({
      ...ctx,
      hierarchy: [
        panel('pnl_root', [circuit('cir_a', [planned, other], { maxContinuousKw: 40 })], {
          maxContinuousKw: 100,
        }),
      ],
    });
    const byId = new Map((result ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
    expect(byId.get('sta_a')).toBe(12);
    expect(byId.get('sta_b')).toBe(28);
    expect(dbMock.markSitePlanStale).not.toHaveBeenCalled();
  });

  it('never replans every cycle for a planned session on a reserved station', async () => {
    dbMock.getSitePlan.mockResolvedValue(null);
    const offline = station({ id: 'sta_a', circuitId: 'cir_a', maxPowerKw: 50, isOnline: false });
    const hierarchy = [
      panel('pnl_root', [circuit('cir_a', [offline, other], { maxContinuousKw: 100 })], {
        maxContinuousKw: 40,
      }),
    ];
    dbMock.listPlanDepartures.mockResolvedValue([
      departure({ id: 'vdp_1', sessionId: 'ses_1', targetEnergyKwh: 30, maxChargePowerKw: 50 }),
      departure({ id: 'vdp_2', vehicleId: 'veh_2', targetEnergyKwh: 30, maxChargePowerKw: 50 }),
    ]);
    dbMock.listPlanSessions.mockResolvedValue([
      session({ id: 'ses_1' }),
      session({ id: 'ses_2', stationDbId: 'sta_b', evseDbId: 'evs_b1', vehicleId: 'veh_2' }),
    ]);
    const result = await departureAwareAllocation({
      ...ctx,
      stations: [offline, other],
      reservedKw: new Map([['sta_a', 20]]),
      hierarchy,
    });
    const byId = new Map((result ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
    expect(byId.has('sta_a')).toBe(false);
    // The planned online station got what the reservation leaves, not more.
    expect(byId.get('sta_b')).toBeLessThanOrEqual(20 + 1e-9);
    expect(dbMock.markSitePlanStale).not.toHaveBeenCalled();
    const readiness = dbMock.writeSitePlan.mock.calls[0]?.[2] as Array<{
      departureId: string;
      readinessReason: string | null;
    }>;
    expect(readiness.find((r) => r.departureId === 'vdp_1')?.readinessReason).toBe(
      'station_offline',
    );
  });

  it('never asks a station for more than its maximum', async () => {
    dbMock.getSitePlan.mockResolvedValue(storedPlan(80));
    const small = station({ id: 'sta_a', circuitId: 'cir_a', maxPowerKw: 22 });
    const result = await departureAwareAllocation({
      ...ctx,
      stations: [small, other],
      hierarchy: [
        panel('pnl_root', [circuit('cir_a', [small, other], { maxContinuousKw: 200 })], {
          maxContinuousKw: 200,
        }),
      ],
    });
    const byId = new Map((result ?? []).map((a) => [a.stationDbId, a.allocatedKw]));
    expect(byId.get('sta_a')).toBe(22);
    expect(dbMock.markSitePlanStale).not.toHaveBeenCalled();
  });

  it('marks the plan stale when the panel limit cuts the planned station', async () => {
    dbMock.getSitePlan.mockResolvedValue(storedPlan(30));
    const result = await departureAwareAllocation({
      ...ctx,
      hierarchy: [
        panel('pnl_root', [circuit('cir_a', [planned, other], { maxContinuousKw: 100 })], {
          maxContinuousKw: 40,
        }),
      ],
    });
    const total = (result ?? []).reduce((sum, a) => sum + a.allocatedKw, 0);
    expect(total).toBeCloseTo(40, 9);
    expect(dbMock.markSitePlanStale).toHaveBeenCalledWith(
      'sit_1',
      'capacity_reduced',
      expect.anything(),
    );
  });
});
