// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The planner input of a site in the cases the main tests leave out: held
// depot requests, SoC targets with a maximum or an expected arrival SoC, a
// requested charging point before plug-in, an expected arrival, a taper cap,
// a reserved station, and the readiness and stored entries built from a plan.

import { describe, expect, it, vi } from 'vitest';
import type { PlanDepartureRow, PlanSessionRow } from '@evtivity/database';
import type { HierarchyNode, StationPowerInfo } from '../load-management.service.js';

vi.mock('@evtivity/database', () => ({ db: {}, isOperatorStation: vi.fn() }));

const { bindDepartures, buildPlanInput, holdNodeId, readinessWrites, storedPlanEntries } =
  await import('../charging-plan.service.js');

const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function station(overrides: Partial<StationPowerInfo> & { id: string }): StationPowerInfo {
  return {
    stationId: overrides.id.toUpperCase(),
    circuitId: 'cir_1',
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

function circuit(stations: StationPowerInfo[]): HierarchyNode {
  return {
    type: 'circuit',
    id: 'cir_1',
    name: 'c',
    maxContinuousKw: 200,
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
  };
}

function panelOf(child: HierarchyNode): HierarchyNode {
  return {
    ...child,
    type: 'panel',
    id: 'pnl_1',
    name: 'p',
    maxContinuousKw: 300,
    stations: [],
    children: [child],
  };
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
    evseMaxKw: 40,
    acCharging: false,
    evseNumber: 1,
    ...overrides,
  };
}

const staA = station({ id: 'sta_a' });
const staB = station({ id: 'sta_b', maxPowerKw: 30, hasActiveSession: false });

function build(
  departures: PlanDepartureRow[],
  sessions: PlanSessionRow[],
  extra: Partial<Parameters<typeof buildPlanInput>[0]> = {},
) {
  return buildPlanInput({
    nowMs: NOW,
    bufferMinutes: 30,
    timezone: 'UTC',
    ratePeriods: [],
    hierarchy: [panelOf(circuit([staA, staB]))],
    stations: [staA, staB],
    reservedKw: new Map(),
    previous: null,
    departures,
    sessions,
    binding: bindDepartures(departures, sessions, NOW),
    ...extra,
  });
}

describe('buildPlanInput held requests', () => {
  it('leaves out a held request without a session and holds one with a session at zero', () => {
    const held = departure({
      id: 'dep_h',
      sessionId: 'ses_1',
      held: true,
      preconditioningPowerKw: 5,
      preconditioning: {
        climate: 'heat',
        startAt: null,
        finishAt: null,
        hvacStartAt: null,
        hvacKw: null,
        systemStartAt: null,
        systemKw: null,
      },
    });
    const gone = departure({ id: 'dep_g', sessionId: null, held: true });
    const out = build([held, gone], [session({ id: 'ses_1' })]);
    expect(out.departures.map((d) => d.departure.id)).toEqual(['dep_h']);
    expect(out.input.vehicles[0]).toMatchObject({
      departureId: 'dep_h',
      priority: 10,
      neededKwh: 0,
      maxKw: 0,
      minKw: 0,
    });
    expect(out.input.vehicles[0]).not.toHaveProperty('auxKw');
  });
});

describe('buildPlanInput targets', () => {
  it('adds the energy up to the SoC maximum as extra', () => {
    const d = departure({
      id: 'dep_s',
      sessionId: 'ses_1',
      targetKind: 'soc',
      targetSocPercent: 60,
      targetSocMaxPercent: 90,
      batteryCapacityKwh: 100,
    });
    const s = session({ id: 'ses_1', lastSocPercent: 50, lastSocAt: new Date(NOW - MIN) });
    const v = build([d], [s]).input.vehicles[0]!;
    expect(v.neededKwh).toBeGreaterThan(0);
    expect(v.extraKwh).toBeGreaterThan(0);
  });

  it('reads the expected arrival SoC without a fresh reading, against the delivered energy', () => {
    const d = departure({
      id: 'dep_s',
      sessionId: 'ses_1',
      targetKind: 'soc',
      targetSocPercent: 80,
      expectedArrivalSocPercent: 30,
      batteryCapacityKwh: 200,
    });
    const s = session({ id: 'ses_1', energyDeliveredWh: 20_000 });
    const out = build([d], [s]);
    // 50 % of 200 kWh is 100 kWh, less the 20 kWh already delivered.
    expect(out.input.vehicles[0]?.neededKwh).toBe(80);
    expect(out.departures[0]?.unknownSoc).toBe(false);
  });

  it('marks an unknown SoC and leaves out a SoC target without a battery capacity', () => {
    const unknown = departure({
      id: 'dep_u',
      sessionId: 'ses_1',
      targetKind: 'soc',
      targetSocPercent: 80,
      batteryCapacityKwh: 100,
    });
    const noCap = departure({
      id: 'dep_n',
      vehicleId: 'veh_2',
      targetKind: 'soc',
      targetSocPercent: 80,
    });
    const out = build([unknown, noCap], [session({ id: 'ses_1' })]);
    expect(out.departures.map((d) => [d.departure.id, d.unknownSoc])).toEqual([['dep_u', true]]);
  });
});

describe('buildPlanInput paths and windows', () => {
  it('reserves the requested charging point path before the vehicle plugs in', () => {
    const d = departure({
      id: 'dep_r',
      requestedStationDbId: 'sta_b',
      maxChargePowerKw: 100,
      expectedArrivalAt: new Date(NOW + HOUR),
    });
    const v = build([d], []).input.vehicles[0]!;
    expect(v.maxKw).toBe(30);
    expect(v.availableFromMs).toBe(NOW + HOUR);
    expect(v.path.map((u) => u.nodeId)).toContain('circuit:cir_1');
  });

  it('starts a waiting vehicle at its departure without an arrival, on the site node', () => {
    const d = departure({
      id: 'dep_w',
      maxChargePowerKw: 20,
      expectedArrivalAt: new Date(NOW + 8 * HOUR),
    });
    const v = build([d], []).input.vehicles[0]!;
    expect(v.availableFromMs).toBe(NOW + 6 * HOUR);
    expect(v.maxKw).toBe(20);
    expect(v.path).toEqual([{ nodeId: 'site', weight: 1 }]);
  });

  it('plans an ad hoc request to the ad hoc horizon', () => {
    const d = departure({ id: 'dep_a', departureAt: null, adHoc: true, sessionId: 'ses_1' });
    const v = build([d], [session({ id: 'ses_1' })]).input.vehicles[0]!;
    expect(v.adHoc).toBe(true);
    expect(v.departureMs).toBe(NOW + 24 * HOUR);
  });

  it('caps a plugged vehicle at its taper cap', () => {
    const d = departure({ id: 'dep_t', sessionId: 'ses_1' });
    const s = session({ id: 'ses_1' });
    const out = build([d], [s], {
      measures: new Map([['ses_1', { limitKw: 40, taperCapKw: 12 }]]),
    });
    expect(out.input.vehicles[0]?.maxKw).toBe(12);
  });

  it('holds a reserved station at its last limit and names its issue', () => {
    const d1 = departure({ id: 'dep_1', sessionId: 'ses_1' });
    const offline = station({ id: 'sta_b', isOnline: false });
    const d2 = departure({ id: 'dep_2', vehicleId: 'veh_2', sessionId: 'ses_2' });
    const sessions = [
      session({ id: 'ses_1' }),
      session({ id: 'ses_2', stationDbId: 'sta_b', vehicleId: 'veh_2' }),
    ];
    const out = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [panelOf(circuit([staA, offline]))],
      stations: [staA, offline],
      reservedKw: new Map([
        ['sta_a', 20],
        ['sta_b', 10],
      ]),
      previous: null,
      departures: [d1, d2],
      sessions,
      binding: bindDepartures([d1, d2], sessions, NOW),
    });
    expect(out.departures.map((d) => d.stationIssue)).toEqual([
      'charger_not_following',
      'station_offline',
    ]);
    expect(out.input.nodeCapacityKw[holdNodeId('sta_a')]?.[0]).toBe(0);
    expect(out.input.vehicles[0]?.path.map((u) => u.nodeId)).toContain(holdNodeId('sta_a'));
  });
});

describe('readiness writes and stored entries', () => {
  function result(departureIds: string[]) {
    return {
      entries: departureIds.map((departureId) => ({
        departureId,
        readiness: 'on_track',
        readinessReason: null,
        plannedKwh: 10,
        shortfallKwh: 0,
        predictedReadyMs: NOW + HOUR,
        predictedMaxReadyMs: NOW + 2 * HOUR,
        powerKw: [10.12345, 0],
      })),
    } as never;
  }

  it('applies the station issue, an offline station and an unknown SoC to the readiness', () => {
    const offline = station({ id: 'sta_b', isOnline: false });
    const dIssue = departure({ id: 'dep_1', sessionId: 'ses_1' });
    const dOffline = departure({ id: 'dep_2', vehicleId: 'veh_2', sessionId: 'ses_2' });
    const dUnknown = departure({
      id: 'dep_3',
      vehicleId: 'veh_3',
      sessionId: 'ses_3',
      targetKind: 'soc',
      targetSocPercent: 80,
      targetSocMaxPercent: 90,
      batteryCapacityKwh: 100,
    });
    const sessions = [
      session({ id: 'ses_1', energyDeliveredWh: 1234 }),
      session({ id: 'ses_2', stationDbId: 'sta_b', vehicleId: 'veh_2' }),
      session({ id: 'ses_3', vehicleId: 'veh_3', stationDbId: 'sta_c' }),
    ];
    const deps = [dIssue, dOffline, dUnknown];
    const planBuild = buildPlanInput({
      nowMs: NOW,
      bufferMinutes: 30,
      timezone: 'UTC',
      ratePeriods: [],
      hierarchy: [panelOf(circuit([staA, offline]))],
      stations: [staA, offline],
      reservedKw: new Map([['sta_a', 10]]),
      previous: null,
      departures: deps,
      sessions,
      binding: bindDepartures(deps, sessions, NOW),
    });
    const writes = readinessWrites(planBuild, result(['dep_1', 'dep_2', 'dep_3']));
    expect(writes.map((w) => [w.departureId, w.readiness, w.readinessReason])).toEqual([
      ['dep_1', 'at_risk', 'charger_not_following'],
      ['dep_2', 'at_risk', 'station_offline'],
      ['dep_3', 'on_track', 'unknown_soc'],
    ]);
    expect(writes[0]?.deliveredKwh).toBe(1.234);
    expect(writes[0]?.predictedMaxReadyAt).toBeNull();
    expect(writes[2]?.predictedMaxReadyAt).toEqual(new Date(NOW + 2 * HOUR));
  });

  it('stores only plugged entries, with the preconditioning load and flags', () => {
    const plugged = departure({
      id: 'dep_p',
      sessionId: 'ses_1',
      departureAt: new Date(NOW + 30 * MIN),
      preconditioningPowerKw: 4,
      preconditioning: {
        climate: 'heat',
        startAt: null,
        finishAt: null,
        hvacStartAt: null,
        hvacKw: null,
        systemStartAt: null,
        systemKw: null,
      },
    });
    const waiting = departure({ id: 'dep_w', vehicleId: 'veh_9' });
    const sessions = [session({ id: 'ses_1' })];
    const planBuild = build([plugged, waiting], sessions);
    const entries = storedPlanEntries(planBuild, result(['dep_p', 'dep_w']));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      departureId: 'dep_p',
      sessionId: 'ses_1',
      stationDbId: 'sta_a',
      powerKw: [10.123, 0],
    });
    expect(entries[0]?.auxKw?.[0]).toBeGreaterThan(0);
    expect(entries[0]?.preconditioning?.[0]).toBe(true);
  });

  it('stores no aux or flags for a plugged entry without preconditioning', () => {
    const d = departure({ id: 'dep_p', sessionId: 'ses_1' });
    const entries = storedPlanEntries(build([d], [session({ id: 'ses_1' })]), result(['dep_p']));
    expect(entries[0]).not.toHaveProperty('auxKw');
    expect(entries[0]).not.toHaveProperty('preconditioning');
  });
});
