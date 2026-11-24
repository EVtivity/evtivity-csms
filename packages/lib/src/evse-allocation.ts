// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// IEC 61851-1: the lowest AC charging current a control pilot signals.
export const AC_MIN_CURRENT_A = 6;

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
): void {
  const capacityOf = new Map(constraints.map((c) => [c.id, c.capacity]));
  const level = new Map(demands.map((d) => [d.key, 0]));
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
 * priority group under `priority_based`. An AC demand that would get less than 6 A is paused
 * at 0 A, lowest priority first, then the later session, and the rest is filled again.
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
    const groups =
      input.strategy === 'priority_based'
        ? [...new Set(remaining.map((d) => d.priority))]
            .sort((a, b) => b - a)
            .map((p) => remaining.filter((d) => d.priority === p))
        : [remaining];
    for (const group of groups) progressiveFill(input.constraints, group, used, out);
    const below = remaining.filter(
      (d) => d.kind === 'ac' && (out.get(d.key)?.level ?? 0) < AC_MIN_CURRENT_A - EPS,
    );
    const victim = below.sort((a, b) => a.priority - b.priority || b.order - a.order)[0];
    if (victim == null) {
      for (const [k, v] of paused) out.set(k, v);
      return out;
    }
    paused.set(victim.key, { level: 0, paused: true, limitedBy: 'ac_min_pause' });
    remaining = remaining.filter((d) => d.key !== victim.key);
  }
}
