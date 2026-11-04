// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanEntry, PlanInput, PlanResult, PlanVehicleInput } from '../charging-plan.js';
import {
  buildPlanSlots,
  isBetterClassScore,
  planDepotCharging,
  withStationIssue,
} from '../charging-plan.js';
import {
  checkPlanInvariants,
  mulberry32,
  randomPlanInput,
} from './helpers/charging-plan-random.js';

interface FixtureExpectation {
  plannedKwh: number;
  shortfallKwh: number;
  state: string;
  readiness?: string;
  readinessReason?: string | null;
  powerKw?: number[];
}

interface Fixture {
  description: string;
  input: PlanInput;
  expected: Record<string, FixtureExpectation>;
  checks: {
    energyOnlyWithin?: Record<string, [number, number]>;
    equalPower?: [string, string];
    maxNodeLoad?: Record<string, number>;
    bufferEnergyKwh?: Record<string, number>;
  };
}

const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'charging-plan');
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({
    name: f.replace(/\.json$/, ''),
    fixture: JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) as Fixture,
  }));

function entryOf(result: PlanResult, id: string): PlanEntry {
  const entry = result.entries.find((e) => e.departureId === id);
  if (entry == null) throw new Error(`no entry for ${id}`);
  return entry;
}

function vehicleOf(input: PlanInput, id: string): PlanVehicleInput {
  const vehicle = input.vehicles.find((v) => v.departureId === id);
  if (vehicle == null) throw new Error(`no vehicle ${id}`);
  return vehicle;
}

describe('planDepotCharging fixtures', () => {
  it('has all twelve plan cases', () => {
    expect(fixtures.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'cheap-night',
        'shared-root',
        'priority-loses',
        'edf-within-class',
        'buffer-last',
        'buffer-last-tight',
        'circuit-limit',
        'three-phase',
        'min-power',
        'repair-two-vehicles',
        'cannot-meet',
        'nothing-to-do',
        'late-arrival',
        'beyond-horizon',
      ]),
    );
  });

  it.each(fixtures)('$name', ({ fixture }) => {
    const { input } = fixture;
    const result = planDepotCharging(input);
    expect(checkPlanInvariants(input, result)).toEqual([]);

    for (const [id, want] of Object.entries(fixture.expected)) {
      const entry = entryOf(result, id);
      expect(entry.plannedKwh, `${id} planned`).toBeCloseTo(want.plannedKwh, 3);
      expect(entry.shortfallKwh, `${id} shortfall`).toBeCloseTo(want.shortfallKwh, 3);
      expect(entry.state, `${id} state`).toBe(want.state);
      if (want.readiness != null) expect(entry.readiness, `${id} readiness`).toBe(want.readiness);
      if (want.readinessReason !== undefined) {
        expect(entry.readinessReason, `${id} reason`).toBe(want.readinessReason);
      }
      if (want.powerKw != null) {
        entry.powerKw.forEach((p, s) =>
          expect(p, `${id} slot ${String(s)}`).toBeCloseTo(want.powerKw![s]!, 3),
        );
      }
    }

    const { checks } = fixture;
    for (const [id, [fromMs, toMs]] of Object.entries(checks.energyOnlyWithin ?? {})) {
      const entry = entryOf(result, id);
      input.slots.forEach((slot, s) => {
        if (slot.endMs <= fromMs || slot.startMs >= toMs) {
          expect(entry.powerKw[s], `${id} slot ${String(s)} outside`).toBeCloseTo(0, 6);
        }
      });
    }
    if (checks.equalPower != null) {
      const [a, b] = checks.equalPower;
      const pa = entryOf(result, a).powerKw;
      const pb = entryOf(result, b).powerKw;
      pa.forEach((p, s) => expect(p).toBeCloseTo(pb[s]!, 3));
    }
    for (const [node, max] of Object.entries(checks.maxNodeLoad ?? {})) {
      for (const load of result.nodeLoadKw[node]!) expect(load).toBeLessThanOrEqual(max + 1e-6);
    }
    for (const [id, kwh] of Object.entries(checks.bufferEnergyKwh ?? {})) {
      const v = vehicleOf(input, id);
      const bufferStart = v.departureMs - input.bufferMinutes * 60_000;
      const entry = entryOf(result, id);
      const inBuffer = input.slots.reduce(
        (sum, slot, s) =>
          slot.startMs >= bufferStart ? sum + entry.powerKw[s]! * slot.hours : sum,
        0,
      );
      expect(inBuffer).toBeCloseTo(kwh, 3);
    }
  });

  it('keeps every planned power of the min-power case at 0 or at least 10 kW', () => {
    const { fixture } = fixtures.find((f) => f.name === 'min-power')!;
    const entry = entryOf(planDepotCharging(fixture.input), 'v');
    for (const p of entry.powerKw) expect(p < 1e-9 || p >= 10 - 1e-9).toBe(true);
    expect(entry.powerKw.some((p) => p > 0)).toBe(true);
  });

  it('keeps the earliest energy of the cheap-night bus out of the dear evening', () => {
    const { fixture } = fixtures.find((f) => f.name === 'cheap-night')!;
    const result = planDepotCharging(fixture.input);
    expect(result.costPerKwhWeighted).toBeCloseTo(0.1, 6);
    expect(entryOf(result, 'bus').predictedReadyMs).toBeLessThanOrEqual(
      Date.parse('2026-11-03T05:00:00Z'),
    );
  });
});

describe('planDepotCharging readiness', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const dep = now + 4 * 3_600_000;

  function oneVehicle(overrides: Partial<PlanVehicleInput>, rootKw = 100): PlanInput {
    const slots = buildPlanSlots(now, dep);
    return {
      nowMs: now,
      bufferMinutes: 30,
      slots,
      pricePerKwh: slots.map(() => 0.2),
      nodeCapacityKw: { root: slots.map(() => rootKw) },
      rootNodeId: 'root',
      vehicles: [
        {
          departureId: 'v',
          departureMs: dep,
          priority: 5,
          neededKwh: 100,
          maxKw: 50,
          minKw: 0,
          availableFromMs: now,
          path: [{ nodeId: 'root', weight: 1 }],
          ...overrides,
        },
      ],
    };
  }

  it('marks a vehicle that is not plugged in and could still make it as waiting for the vehicle', () => {
    const entry = planDepotCharging(oneVehicle({ availableFromMs: dep })).entries[0]!;
    expect(entry.pluggedIn).toBe(false);
    expect(entry.plannedKwh).toBe(0);
    expect(entry.pluggedNowKwh).toBeCloseTo(175, 6);
    expect(entry.readiness).toBe('waiting_for_vehicle');
    expect(entry.readinessReason).toBeNull();
  });

  it('marks a vehicle that is not plugged in and would miss the buffer as at risk, not plugged in', () => {
    const entry = planDepotCharging(oneVehicle({ availableFromMs: dep, neededKwh: 190 }))
      .entries[0]!;
    expect(entry.readiness).toBe('at_risk');
    expect(entry.readinessReason).toBe('not_plugged_in');
  });

  it('marks a vehicle that is not plugged in and could not make it even now as cannot meet', () => {
    const entry = planDepotCharging(oneVehicle({ availableFromMs: dep, neededKwh: 250 }))
      .entries[0]!;
    expect(entry.readiness).toBe('cannot_meet');
    expect(entry.readinessReason).toBe('vehicle_power');
  });

  it('names a late arrival when a known arrival is too late but plugging in now would do', () => {
    const late = now + 3 * 3_600_000;
    const entry = planDepotCharging(oneVehicle({ availableFromMs: late, neededKwh: 150 }))
      .entries[0]!;
    expect(entry.state).toBe('cannot_meet');
    expect(entry.readiness).toBe('at_risk');
    expect(entry.readinessReason).toBe('late_arrival');
  });

  it('names the site capacity when the path, not the vehicle, limits it', () => {
    const entry = planDepotCharging(oneVehicle({ neededKwh: 150 }, 20)).entries[0]!;
    expect(entry.readiness).toBe('cannot_meet');
    expect(entry.readinessReason).toBe('site_capacity');
  });

  it('turns a station problem into at risk but never hides a worse state', () => {
    expect(
      withStationIssue({ readiness: 'on_track', readinessReason: null }, 'profile_rejected'),
    ).toEqual({
      readiness: 'at_risk',
      readinessReason: 'profile_rejected',
    });
    expect(
      withStationIssue(
        { readiness: 'cannot_meet', readinessReason: 'site_capacity' },
        'station_offline',
      ),
    ).toEqual({ readiness: 'cannot_meet', readinessReason: 'site_capacity' });
    expect(
      withStationIssue({ readiness: 'ready', readinessReason: null }, 'station_offline'),
    ).toEqual({
      readiness: 'ready',
      readinessReason: null,
    });
    expect(withStationIssue({ readiness: null, readinessReason: null }, 'station_offline')).toEqual(
      { readiness: null, readinessReason: null },
    );
  });

  it('plans an empty input', () => {
    const result = planDepotCharging({
      nowMs: now,
      bufferMinutes: 30,
      slots: [],
      pricePerKwh: [],
      nodeCapacityKw: {},
      rootNodeId: 'root',
      vehicles: [],
    });
    expect(result.entries).toEqual([]);
    expect(result.costPerKwhWeighted).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const input = randomPlanInput(mulberry32(7));
    expect(planDepotCharging(input)).toEqual(planDepotCharging(input));
  });
});

describe('planDepotCharging input safety', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const HOUR = 3_600_000;

  function inputWith(vehicles: PlanVehicleInput[], caps: Record<string, number[]>): PlanInput {
    const slots = buildPlanSlots(now, now + 4 * HOUR);
    return {
      nowMs: now,
      bufferMinutes: 0,
      slots,
      pricePerKwh: slots.map(() => 0.2),
      nodeCapacityKw: caps,
      rootNodeId: 'root',
      vehicles,
    };
  }

  function vehicle(overrides: Partial<PlanVehicleInput>): PlanVehicleInput {
    return {
      departureId: 'v',
      departureMs: now + 4 * HOUR,
      priority: 5,
      neededKwh: 100,
      maxKw: 50,
      minKw: 0,
      availableFromMs: now,
      path: [{ nodeId: 'root', weight: 1 }],
      ...overrides,
    };
  }

  const flat = (kw: number): number[] => Array.from({ length: 16 }, () => kw);

  it('keeps an extreme departure (2000 kWh in 5 minutes) within every limit', () => {
    const input = inputWith(
      [
        vehicle({
          departureId: 'extreme',
          neededKwh: 2000,
          departureMs: now + 5 * 60_000,
          priority: 10,
          maxKw: 3750,
          path: [
            { nodeId: 'circuit', weight: 1 },
            { nodeId: 'root', weight: 1 },
          ],
        }),
        vehicle({ departureId: 'other', priority: 1, path: [{ nodeId: 'root', weight: 1 }] }),
      ],
      { root: flat(120), circuit: flat(40) },
    );
    const result = planDepotCharging(input);
    expect(checkPlanInvariants(input, result)).toEqual([]);
    const extreme = entryOf(result, 'extreme');
    for (const p of extreme.powerKw) expect(p).toBeLessThanOrEqual(40 + 1e-6);
    for (const load of result.nodeLoadKw['root']!) expect(load).toBeLessThanOrEqual(120 + 1e-6);
    for (const load of result.nodeLoadKw['circuit']!) expect(load).toBeLessThanOrEqual(40 + 1e-6);
    expect(extreme.readiness).toBe('cannot_meet');
  });

  it('counts a node listed twice in a path with both weights', () => {
    const input = inputWith(
      [
        vehicle({
          neededKwh: 1000,
          maxKw: 150,
          path: [
            { nodeId: 'root', weight: 1 },
            { nodeId: 'root', weight: 1 },
          ],
        }),
      ],
      { root: flat(100) },
    );
    const result = planDepotCharging(input);
    expect(checkPlanInvariants(input, result)).toEqual([]);
    for (const p of result.entries[0]!.powerKw) expect(p).toBeLessThanOrEqual(50 + 1e-6);
    for (const load of result.nodeLoadKw['root']!) expect(load).toBeLessThanOrEqual(100 + 1e-6);
  });

  it('plans no power for a path with no usable node', () => {
    for (const path of [
      [],
      [{ nodeId: 'root', weight: 0 }],
      [{ nodeId: 'root', weight: Number.NaN }],
    ]) {
      const entry = planDepotCharging(inputWith([vehicle({ path })], { root: flat(100) }))
        .entries[0]!;
      expect(entry.plannedKwh).toBe(0);
      expect(entry.powerKw.every((p) => p === 0)).toBe(true);
      expect(entry.aloneKwh).toBe(0);
    }
  });

  it('marks a departure at or before now as departed, with no readiness to notify on', () => {
    for (const departureMs of [now, now - HOUR]) {
      const entry = planDepotCharging(inputWith([vehicle({ departureMs })], { root: flat(100) }))
        .entries[0]!;
      expect(entry.departed).toBe(true);
      expect(entry.state).toBeNull();
      expect(entry.readiness).toBeNull();
      expect(entry.readinessReason).toBeNull();
      expect(entry.powerKw.every((p) => p === 0)).toBe(true);
    }
  });

  it('never plans power that is not a finite number for bad inputs', () => {
    const bad = [
      vehicle({ departureId: 'a', maxKw: Number.NaN }),
      vehicle({ departureId: 'b', maxKw: -10 }),
      vehicle({ departureId: 'c', minKw: Number.NaN }),
      vehicle({ departureId: 'd', minKw: -5 }),
      vehicle({ departureId: 'e', neededKwh: Number.POSITIVE_INFINITY }),
      vehicle({ departureId: 'f', neededKwh: -20 }),
      vehicle({ departureId: 'g', departureMs: Number.NaN }),
      vehicle({ departureId: 'h', availableFromMs: Number.NaN }),
      vehicle({ departureId: 'i', priority: Number.NaN }),
    ];
    const result = planDepotCharging(inputWith(bad, { root: flat(500) }));
    for (const entry of result.entries) {
      for (const p of entry.powerKw) {
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
      }
      expect(Number.isFinite(entry.plannedKwh)).toBe(true);
      expect(Number.isFinite(entry.shortfallKwh)).toBe(true);
    }
    for (const load of result.nodeLoadKw['root']!) {
      expect(Number.isFinite(load)).toBe(true);
      expect(load).toBeLessThanOrEqual(500 + 1e-6);
    }
    const byId = new Map(result.entries.map((e) => [e.departureId, e]));
    expect(byId.get('a')!.plannedKwh).toBe(0);
    expect(byId.get('b')!.plannedKwh).toBe(0);
    expect(byId.get('c')!.plannedKwh).toBeCloseTo(100, 6);
    expect(byId.get('d')!.plannedKwh).toBeCloseTo(100, 6);
    expect(byId.get('e')!.readiness).toBe('ready');
    expect(byId.get('f')!.readiness).toBe('ready');
    expect(byId.get('g')!.departed).toBe(true);
    expect(byId.get('h')!.plannedKwh).toBe(0);
    expect(byId.get('h')!.readiness).toBe('waiting_for_vehicle');
    expect(byId.get('i')!.plannedKwh).toBeCloseTo(100, 6);
  });

  it('proves cannot meet beyond the horizon only from the vehicle power', () => {
    const slots = buildPlanSlots(now, now + 60 * HOUR);
    const input: PlanInput = {
      nowMs: now,
      bufferMinutes: 30,
      slots,
      pricePerKwh: slots.map(() => 0.2),
      nodeCapacityKw: { root: slots.map(() => 30) },
      rootNodeId: 'root',
      vehicles: [
        vehicle({ departureId: 'fits', departureMs: now + 60 * HOUR, neededKwh: 2000 }),
        vehicle({ departureId: 'never', departureMs: now + 60 * HOUR, neededKwh: 4000 }),
        vehicle({
          departureId: 'away',
          departureMs: now + 60 * HOUR,
          neededKwh: 2000,
          availableFromMs: now + 60 * HOUR,
        }),
      ],
    };
    const byId = new Map(planDepotCharging(input).entries.map((e) => [e.departureId, e]));
    expect(byId.get('fits')!.beyondHorizon).toBe(true);
    expect(byId.get('fits')!.readiness).toBe('on_track');
    expect(byId.get('never')!.readiness).toBe('cannot_meet');
    expect(byId.get('never')!.readinessReason).toBe('vehicle_power');
    expect(byId.get('away')!.readiness).toBe('waiting_for_vehicle');
  });
});

describe('planDepotCharging repair', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const HOUR = 3_600_000;
  const hourSlots = (count: number): PlanInput['slots'] =>
    Array.from({ length: count }, (_, i) => ({
      startMs: now + i * HOUR,
      endMs: now + (i + 1) * HOUR,
      hours: 1,
    }));

  it('follows the limit to another node when the first move frees the circuit', () => {
    const input: PlanInput = {
      nowMs: now,
      bufferMinutes: 0,
      slots: hourSlots(2),
      pricePerKwh: [1, 5],
      nodeCapacityKw: { panel: [100, 100], c1: [60, 60], c2: [200, 200], vnode: [100, 0] },
      rootNodeId: 'panel',
      vehicles: [
        {
          departureId: 'u2',
          departureMs: now + 2 * HOUR,
          priority: 5,
          neededKwh: 60,
          maxKw: 60,
          minKw: 0,
          availableFromMs: now,
          path: [
            { nodeId: 'panel', weight: 1 },
            { nodeId: 'c2', weight: 1 },
          ],
        },
        {
          departureId: 'u1',
          departureMs: now + 2 * HOUR + 60_000,
          priority: 5,
          neededKwh: 30,
          maxKw: 30,
          minKw: 0,
          availableFromMs: now,
          // Moving this vehicle frees twice as much on the circuit as on the panel,
          // so the panel limits the last vehicle after the first move.
          path: [
            { nodeId: 'panel', weight: 1 },
            { nodeId: 'c1', weight: 2 },
          ],
        },
        {
          departureId: 'v',
          departureMs: now + 2 * HOUR + 120_000,
          priority: 5,
          neededKwh: 50,
          maxKw: 50,
          minKw: 0,
          availableFromMs: now,
          path: [
            { nodeId: 'panel', weight: 1 },
            { nodeId: 'c1', weight: 1 },
            { nodeId: 'vnode', weight: 1 },
          ],
        },
      ],
    };
    const result = planDepotCharging(input);
    expect(checkPlanInvariants(input, result)).toEqual([]);
    for (const entry of result.entries) expect(entry.shortfallKwh, entry.departureId).toBe(0);
  });

  it('moves an earlier vehicle out of the way into a slot outside its buffer first', () => {
    const input: PlanInput = {
      nowMs: now,
      bufferMinutes: 60,
      slots: hourSlots(4),
      pricePerKwh: [1, 5, 5, 5],
      nodeCapacityKw: { root: [60, 60, 60, 60], vnode: [60, 0, 0, 0] },
      rootNodeId: 'root',
      vehicles: [
        {
          departureId: 'u',
          departureMs: now + 3 * HOUR,
          priority: 5,
          neededKwh: 60,
          maxKw: 60,
          minKw: 0,
          availableFromMs: now,
          path: [{ nodeId: 'root', weight: 1 }],
        },
        {
          departureId: 'v',
          departureMs: now + 4 * HOUR,
          priority: 5,
          neededKwh: 60,
          maxKw: 60,
          minKw: 0,
          availableFromMs: now,
          path: [
            { nodeId: 'root', weight: 1 },
            { nodeId: 'vnode', weight: 1 },
          ],
        },
      ],
    };
    const result = planDepotCharging(input);
    const u = result.entries.find((e) => e.departureId === 'u')!;
    const v = result.entries.find((e) => e.departureId === 'v')!;
    expect(v.shortfallKwh).toBe(0);
    expect(u.powerKw).toEqual([0, 60, 0, 0]);
    expect(u.readiness).toBe('on_track');
  });
});

describe('isBetterClassScore', () => {
  it('prefers less shortfall, then less energy in the buffer, then lower cost', () => {
    const base = { shortfall: 10, bufferKwh: 5, cost: 3 };
    expect(isBetterClassScore({ ...base, shortfall: 9 }, base)).toBe(true);
    expect(isBetterClassScore({ ...base, shortfall: 9, bufferKwh: 50 }, base)).toBe(true);
    expect(isBetterClassScore({ ...base, bufferKwh: 4, cost: 30 }, base)).toBe(true);
    expect(isBetterClassScore({ ...base, cost: 2 }, base)).toBe(true);
    expect(isBetterClassScore({ ...base, bufferKwh: 6, cost: 1 }, base)).toBe(false);
    expect(isBetterClassScore(base, base)).toBe(false);
  });
});

describe('planDepotCharging properties', () => {
  it('never breaks a limit on 200 seeded random inputs', () => {
    const rand = mulberry32(20261031);
    for (let i = 0; i < 200; i += 1) {
      const input = randomPlanInput(rand);
      const problems = checkPlanInvariants(input, planDepotCharging(input));
      expect(problems, `case ${String(i)}`).toEqual([]);
    }
  });
});
