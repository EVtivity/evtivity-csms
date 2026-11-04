// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The planner parts bus depot system requests use (VDV 463): maximum targets,
// ad hoc vehicles and preconditioning load.

import { describe, expect, it } from 'vitest';
import {
  buildPlanSlots,
  planDepotCharging,
  type PlanInput,
  type PlanVehicleInput,
} from '../charging-plan.js';

const NOW = Date.parse('2026-03-10T00:00:00Z');
const HOUR = 3_600_000;

function input(vehicles: PlanVehicleInput[], options: Partial<PlanInput> = {}): PlanInput {
  const last = Math.max(...vehicles.map((v) => v.departureMs));
  const slots = buildPlanSlots(NOW, last);
  return {
    nowMs: NOW,
    bufferMinutes: 30,
    slots,
    pricePerKwh: slots.map(() => 0.2),
    nodeCapacityKw: { site: slots.map(() => 200) },
    rootNodeId: 'site',
    vehicles,
    ...options,
  };
}

function bus(over: Partial<PlanVehicleInput>): PlanVehicleInput {
  return {
    departureId: 'bus',
    departureMs: NOW + 6 * HOUR,
    priority: 5,
    neededKwh: 100,
    maxKw: 100,
    minKw: 0,
    availableFromMs: NOW,
    path: [{ nodeId: 'site', weight: 1 }],
    ...over,
  };
}

function energyOf(powerKw: number[], slots: { hours: number }[]): number {
  return powerKw.reduce((sum, kw, s) => sum + kw * (slots[s]?.hours ?? 0), 0);
}

describe('maximum targets', () => {
  it('charges the extra energy from capacity nobody needs', () => {
    const plan = input([bus({ extraKwh: 50 })]);
    const entry = planDepotCharging(plan).entries[0];
    expect(entry?.plannedKwh).toBeCloseTo(150);
    expect(entry?.extraPlannedKwh).toBeCloseTo(50);
    expect(entry?.shortfallKwh).toBe(0);
    expect(entry?.predictedMaxReadyMs).not.toBeNull();
    expect(entry?.predictedMaxReadyMs ?? 0).toBeGreaterThanOrEqual(entry?.predictedReadyMs ?? 0);
  });

  it('never plans the extra energy in the buffer', () => {
    // 5.5 hours outside the buffer at 20 kW hold 110 kWh: the need fits, the
    // extra only partly, and nothing goes into the last 30 minutes.
    const plan = input([bus({ maxKw: 20, neededKwh: 100, extraKwh: 50 })]);
    const result = planDepotCharging(plan);
    const entry = result.entries[0];
    const bufferStart = NOW + 6 * HOUR - 30 * 60_000;
    const inBuffer = plan.slots.reduce(
      (sum, slot, s) =>
        slot.endMs > bufferStart ? sum + (entry?.powerKw[s] ?? 0) * slot.hours : sum,
      0,
    );
    expect(inBuffer).toBeCloseTo(0);
    expect(entry?.extraPlannedKwh).toBeCloseTo(10);
    expect(entry?.predictedMaxReadyMs).toBeNull();
    expect(entry?.readiness).toBe('on_track');
  });

  it('never takes power from another vehicle to reach a maximum', () => {
    // 200 kW for 6 hours: 1200 kWh. A needs 1000; B wants 100 more on top of 100.
    const a = bus({ departureId: 'a', neededKwh: 1000, maxKw: 200, priority: 3 });
    const b = bus({ departureId: 'b', neededKwh: 100, extraKwh: 500, priority: 9 });
    const result = planDepotCharging(input([a, b]));
    const ea = result.entries.find((e) => e.departureId === 'a');
    const eb = result.entries.find((e) => e.departureId === 'b');
    expect(ea?.shortfallKwh).toBe(0);
    expect(eb?.shortfallKwh).toBe(0);
    // Whatever B gets above its need fits in what A left.
    expect((ea?.plannedKwh ?? 0) + (eb?.plannedKwh ?? 0)).toBeLessThanOrEqual(
      1200 * (5.5 / 6) + 100 + 1e-6,
    );
  });

  it('keeps the minimum power when it tops up', () => {
    const plan = input([bus({ neededKwh: 10, minKw: 40, extraKwh: 3 })]);
    const entry = planDepotCharging(plan).entries[0];
    for (const kw of entry?.powerKw ?? []) {
      expect(kw === 0 || kw >= 40 - 1e-6).toBe(true);
    }
  });
});

describe('ad hoc vehicles', () => {
  it('charges an ad hoc vehicle in its earliest slots', () => {
    const plan = input([bus({ adHoc: true, departureMs: NOW + 48 * HOUR, neededKwh: 50 })], {
      // A cheaper night later on would win for a timed vehicle.
      pricePerKwh: buildPlanSlots(NOW, NOW + 48 * HOUR).map((_, s) => (s < 8 ? 0.5 : 0.05)),
    });
    const entry = planDepotCharging(plan).entries[0];
    expect(entry?.powerKw[0]).toBeCloseTo(100);
    expect(entry?.powerKw[1]).toBeCloseTo(100);
    expect(entry?.powerKw[2]).toBeCloseTo(0);
    expect(entry?.readiness).toBe('on_track');
  });

  it('plans ad hoc vehicles ahead of timed vehicles of the same priority', () => {
    // Root 100 kW: the ad hoc vehicle gets the first slots, the timed one waits.
    const plan = input(
      [
        bus({ departureId: 'timed', departureMs: NOW + 4 * HOUR, neededKwh: 100 }),
        bus({ departureId: 'adhoc', adHoc: true, departureMs: NOW + 48 * HOUR, neededKwh: 100 }),
      ],
      { nodeCapacityKw: { site: buildPlanSlots(NOW, NOW + 48 * HOUR).map(() => 100) } },
    );
    const result = planDepotCharging(plan);
    const adhoc = result.entries.find((e) => e.departureId === 'adhoc');
    expect(adhoc?.powerKw.slice(0, 4).every((kw) => kw > 99)).toBe(true);
  });
});

describe('preconditioning load', () => {
  it('counts the preconditioning power on the path before it plans charging', () => {
    const slots = buildPlanSlots(NOW, NOW + 6 * HOUR);
    const aux = slots.map((slot) => (slot.startMs >= NOW + 5 * HOUR ? 150 : 0));
    const plan = input([bus({ auxKw: aux, neededKwh: 100, maxKw: 100 })]);
    const result = planDepotCharging(plan);
    const entry = result.entries[0];
    const site = result.nodeLoadKw['site'] ?? [];
    for (let s = 0; s < slots.length; s += 1) {
      expect(site[s] ?? 0).toBeLessThanOrEqual(200 + 1e-6);
      if ((aux[s] ?? 0) > 0) expect(entry?.powerKw[s] ?? 0).toBeLessThanOrEqual(50 + 1e-6);
    }
    expect(energyOf(entry?.powerKw ?? [], slots)).toBeCloseTo(100);
  });
});
