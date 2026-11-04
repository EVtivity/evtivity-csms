// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PlanInput, PlanNodeUse, PlanResult, PlanVehicleInput } from '../../charging-plan.js';
import { buildPlanSlots } from '../../charging-plan.js';

const HOUR_MS = 3_600_000;
const TOLERANCE = 1e-6;

/** Small seeded generator, so a failing case reproduces from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function between(rand: () => number, lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}

export interface RandomPlanOptions {
  vehicles?: number;
  horizonHours?: number;
  panels?: number;
  circuitsPerPanel?: number;
  ratePeriods?: number;
}

/** A random but valid planner input: a root, three-phase panels and circuits, several rates. */
export function randomPlanInput(rand: () => number, options: RandomPlanOptions = {}): PlanInput {
  const nowMs = Date.parse('2026-11-02T00:00:00Z') + Math.floor(rand() * 24 * 60) * 60_000;
  const horizonHours = options.horizonHours ?? between(rand, 0.5, 30);
  const slots = buildPlanSlots(nowMs, nowMs + horizonHours * HOUR_MS);
  const n = slots.length;

  const periods = options.ratePeriods ?? 1 + Math.floor(rand() * 4);
  const rates = Array.from(
    { length: periods },
    () => Math.round(between(rand, 0.05, 0.5) * 100) / 100,
  );
  const periodLength = Math.max(1, Math.ceil(n / periods));
  const pricePerKwh = slots.map(
    (_, s) => rates[Math.min(periods - 1, Math.floor(s / periodLength))]!,
  );

  const nodeCapacityKw: Record<string, number[]> = {};
  const capacity = (base: number): number[] =>
    Array.from({ length: n }, () => {
      const r = rand();
      if (r < 0.03) return 0;
      if (r < 0.05) return -base * 0.1;
      return base * between(rand, 0.6, 1);
    });
  nodeCapacityKw['root'] = capacity(between(rand, 50, 1500));

  const panelCount = options.panels ?? 1 + Math.floor(rand() * 2);
  const paths: PlanNodeUse[][] = [];
  for (let p = 0; p < panelCount; p += 1) {
    const panel = `panel${String(p)}`;
    nodeCapacityKw[panel] = capacity(between(rand, 40, 800));
    for (const phase of ['L1', 'L2', 'L3'])
      nodeCapacityKw[`${panel}:${phase}`] = capacity(between(rand, 15, 300));
    paths.push([
      { nodeId: 'root', weight: 1 },
      { nodeId: panel, weight: 1 },
    ]);
    for (const phase of ['L1', 'L2', 'L3']) {
      paths.push([
        { nodeId: 'root', weight: 1 },
        { nodeId: panel, weight: 1 },
        { nodeId: `${panel}:${phase}`, weight: 1 },
      ]);
    }
    const circuits = options.circuitsPerPanel ?? Math.floor(rand() * 4);
    for (let c = 0; c < circuits; c += 1) {
      const circuit = `${panel}:c${String(c)}`;
      nodeCapacityKw[circuit] = capacity(between(rand, 10, 150));
      const phase = pick(rand, ['L1', 'L2', 'L3']);
      paths.push([
        { nodeId: 'root', weight: 1 },
        { nodeId: panel, weight: 1 },
        { nodeId: `${panel}:${phase}`, weight: pick(rand, [1, 1 / 3, 0.5]) },
        { nodeId: circuit, weight: 1 },
      ]);
    }
  }

  const vehicleCount = options.vehicles ?? 1 + Math.floor(rand() * 12);
  const vehicles: PlanVehicleInput[] = [];
  for (let i = 0; i < vehicleCount; i += 1) {
    const maxKw = pick(rand, [7.4, 11, 22, 50, 150, 350]) * between(rand, 0.5, 1);
    const arrival = rand();
    const departed = rand() < 0.04;
    const basePath = pick(rand, paths);
    const duplicate = rand() < 0.15 ? pick(rand, basePath) : null;
    const path =
      duplicate == null ? basePath : [...basePath, { nodeId: duplicate.nodeId, weight: 0.5 }];
    vehicles.push({
      departureId: `d${String(i).padStart(3, '0')}`,
      departureMs: departed
        ? nowMs - Math.floor(rand() * HOUR_MS)
        : nowMs + Math.floor(between(rand, 0.1, 1.3) * horizonHours * HOUR_MS),
      priority: pick(rand, [1, 3, 5, 5, 5, 8, 10]),
      neededKwh: rand() < 0.08 ? 0 : between(rand, 1, 400),
      maxKw,
      minKw: rand() < 0.5 ? 0 : maxKw * between(rand, 0.05, 0.5),
      availableFromMs:
        arrival < 0.7
          ? nowMs - 60_000
          : nowMs + Math.floor(between(rand, 0, 1) * horizonHours * HOUR_MS),
      path,
    });
  }

  return {
    nowMs,
    bufferMinutes: pick(rand, [0, 15, 30, 45]),
    slots,
    pricePerKwh,
    nodeCapacityKw,
    rootNodeId: 'root',
    vehicles,
  };
}

/** Hours of a slot inside the vehicle's window [max(availableFrom, now), departure). */
export function windowHoursOf(input: PlanInput, v: PlanVehicleInput, s: number): number {
  const slot = input.slots[s]!;
  const from = Math.max(slot.startMs, v.availableFromMs, input.nowMs);
  const to = Math.min(slot.endMs, v.departureMs);
  return to > from ? (to - from) / HOUR_MS : 0;
}

/** Every limit a plan must keep; returns one line per broken limit. */
export function checkPlanInvariants(input: PlanInput, result: PlanResult): string[] {
  const problems: string[] = [];
  const n = input.slots.length;
  if (result.entries.length !== input.vehicles.length) problems.push('entry count differs');

  const loads: Record<string, number[]> = {};
  input.vehicles.forEach((v, i) => {
    const entry = result.entries[i];
    if (entry?.departureId !== v.departureId) {
      problems.push(`entry ${String(i)} is not ${v.departureId}`);
      return;
    }
    if (entry.powerKw.length !== n)
      problems.push(`${v.departureId} has ${String(entry.powerKw.length)} slots`);
    const departed = v.departureMs <= input.nowMs;
    if (entry.departed !== departed) problems.push(`${v.departureId} departed flag is wrong`);
    if (departed && entry.readiness != null)
      problems.push(`${v.departureId} departed has readiness`);
    let energy = 0;
    entry.powerKw.forEach((p, s) => {
      if (!Number.isFinite(p)) problems.push(`${v.departureId} slot ${String(s)} not finite`);
      const hours = windowHoursOf(input, v, s);
      if (p < -TOLERANCE) problems.push(`${v.departureId} slot ${String(s)} negative ${String(p)}`);
      if (p > v.maxKw + TOLERANCE)
        problems.push(`${v.departureId} slot ${String(s)} above max ${String(p)}`);
      if (hours <= 0 && Math.abs(p) > TOLERANCE)
        problems.push(`${v.departureId} slot ${String(s)} outside window`);
      if (p > TOLERANCE && p < v.minKw - TOLERANCE)
        problems.push(`${v.departureId} slot ${String(s)} below min ${String(p)}`);
      energy += p * hours;
      for (const use of v.path) {
        const arr = (loads[use.nodeId] ??= new Array<number>(n).fill(0));
        arr[s] = arr[s]! + p * use.weight;
      }
    });
    const need = Math.max(0, v.neededKwh);
    if (energy > need + TOLERANCE)
      problems.push(`${v.departureId} above need ${String(energy)} > ${String(need)}`);
    if (Math.abs(energy - entry.plannedKwh) > 1e-4) {
      problems.push(
        `${v.departureId} planned ${String(entry.plannedKwh)} but powers give ${String(energy)}`,
      );
    }
    if (Math.abs(entry.plannedKwh + entry.shortfallKwh - need) > 1e-4) {
      problems.push(`${v.departureId} planned plus shortfall is not the need`);
    }
  });

  for (const [node, arr] of Object.entries(loads)) {
    const caps = input.nodeCapacityKw[node] ?? [];
    arr.forEach((load, s) => {
      const cap = Math.max(0, caps[s] ?? 0);
      if (load > cap + TOLERANCE)
        problems.push(`${node} slot ${String(s)} load ${String(load)} above ${String(cap)}`);
      const reported = result.nodeLoadKw[node]?.[s] ?? 0;
      if (Math.abs(reported - load) > 1e-4)
        problems.push(`${node} slot ${String(s)} reported ${String(reported)} not ${String(load)}`);
    });
  }
  return problems;
}
