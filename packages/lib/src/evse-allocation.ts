// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from './load-allocation.js';

// IEC 61851-1: the lowest AC charging current a control pilot signals.
export const AC_MIN_CURRENT_A = 6;

/** The kW of 6 A on `conductorPhases` conductor phases at `voltageV`. */
export function acMinimumKw(voltageV: number, conductorPhases: number): number {
  return (AC_MIN_CURRENT_A * voltageV * conductorFactor(conductorPhases)) / 1000;
}

export type EvseLimitKind = 'ac' | 'dc';
export type EvseLimitStrategy = 'equal_share' | 'priority_based';

export interface EvseConstraint {
  id: string;
  /** A per phase for a phase constraint, kW for a kW constraint. */
  capacity: number;
}

export interface EvseDemand {
  key: string;
  kind: EvseLimitKind;
  /** A per phase for AC, kW for DC. */
  maxLevel: number;
  /** Load one unit of level puts on each constraint the demand belongs to. */
  weights: Readonly<Record<string, number>>;
  priority: number;
  /** Lower started earlier; at equal priority the later session pauses first. */
  order: number;
}

export type EvseLimitedBy = 'own_max' | 'constraint' | 'ac_min_pause';

export interface EvseLimit {
  level: number;
  paused: boolean;
  limitedBy: EvseLimitedBy;
  constraintId?: string;
}

const EPS = 1e-9;

function progressiveFill(
  constraints: readonly EvseConstraint[],
  demands: readonly EvseDemand[],
  used: Map<string, number>,
  out: Map<string, EvseLimit>,
  floors: ReadonlyMap<string, number> = new Map(),
): void {
  const capacityOf = new Map(constraints.map((c) => [c.id, c.capacity]));
  const level = new Map(demands.map((d) => [d.key, floors.get(d.key) ?? 0]));
  let active = [...demands];
  while (active.length > 0) {
    let delta = Infinity;
    for (const d of active) delta = Math.min(delta, d.maxLevel - (level.get(d.key) ?? 0));
    for (const c of constraints) {
      let weight = 0;
      for (const d of active) weight += d.weights[c.id] ?? 0;
      if (weight <= EPS) continue;
      delta = Math.min(delta, (c.capacity - (used.get(c.id) ?? 0)) / weight);
    }
    delta = Math.max(0, delta);
    for (const d of active) {
      level.set(d.key, (level.get(d.key) ?? 0) + delta);
      for (const [cid, w] of Object.entries(d.weights)) {
        used.set(cid, (used.get(cid) ?? 0) + w * delta);
      }
    }
    const stillActive: EvseDemand[] = [];
    for (const d of active) {
      const lvl = level.get(d.key) ?? 0;
      if (d.maxLevel - lvl <= EPS) {
        out.set(d.key, { level: d.maxLevel, paused: false, limitedBy: 'own_max' });
        continue;
      }
      const full = Object.keys(d.weights).find((cid) => {
        const capacity = capacityOf.get(cid);
        return (
          capacity != null && (d.weights[cid] ?? 0) > EPS && capacity - (used.get(cid) ?? 0) <= EPS
        );
      });
      if (full != null) {
        out.set(d.key, { level: lvl, paused: false, limitedBy: 'constraint', constraintId: full });
        continue;
      }
      stillActive.push(d);
    }
    if (stillActive.length === active.length && delta === 0) {
      for (const d of stillActive) {
        out.set(d.key, { level: level.get(d.key) ?? 0, paused: false, limitedBy: 'constraint' });
      }
      return;
    }
    active = stillActive;
  }
}

/**
 * Splits the constraints between the demands by progressive filling (max-min fair), per
 * priority group under `priority_based`. Every AC demand first gets 6 A; while those floors do
 * not fit, one is paused at 0 A, lowest priority first, then the later session. The rest is
 * filled from the floors, so a DC demand never takes an AC session's floor.
 */
export function allocateEvseLimits(input: {
  constraints: readonly EvseConstraint[];
  demands: readonly EvseDemand[];
  strategy?: EvseLimitStrategy;
}): Map<string, EvseLimit> {
  const paused = new Map<string, EvseLimit>();
  let remaining = [...input.demands];
  for (;;) {
    const out = new Map<string, EvseLimit>();
    const used = new Map<string, number>();
    const floors = new Map<string, number>();
    for (const d of remaining) {
      if (d.kind !== 'ac') continue;
      const floor = Math.min(AC_MIN_CURRENT_A, d.maxLevel);
      floors.set(d.key, floor);
      for (const [cid, w] of Object.entries(d.weights)) {
        used.set(cid, (used.get(cid) ?? 0) + w * floor);
      }
    }
    const floorsFit = input.constraints.every((c) => (used.get(c.id) ?? 0) <= c.capacity + 1e-6);
    const groups =
      input.strategy === 'priority_based'
        ? [...new Set(remaining.map((d) => d.priority))]
            .sort((a, b) => b - a)
            .map((p) => remaining.filter((d) => d.priority === p))
        : [remaining];
    if (floorsFit) {
      for (const group of groups) progressiveFill(input.constraints, group, used, out, floors);
    }
    const below = floorsFit
      ? remaining.filter(
          (d) => d.kind === 'ac' && (out.get(d.key)?.level ?? 0) < AC_MIN_CURRENT_A - EPS,
        )
      : remaining.filter((d) => d.kind === 'ac');
    const victim = below.sort((a, b) => a.priority - b.priority || b.order - a.order)[0];
    if (victim == null) {
      for (const [k, v] of paused) out.set(k, v);
      return out;
    }
    paused.set(victim.key, { level: 0, paused: true, limitedBy: 'ac_min_pause' });
    remaining = remaining.filter((d) => d.key !== victim.key);
  }
}
