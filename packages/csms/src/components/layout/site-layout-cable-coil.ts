// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An idle cable looped over its hanger (owner rule 2026-11-02): one piece from
// its gland, up over the hanger saddle in whole hanging turns the way drivers
// coil it, the handle's cable coming off the bottom of the last turn up into
// the handle in its holster. The turns' drop is solved on the drawn points, so
// the drawn cable has the cable's length; every turn hangs clear of the ground
// under it. Pure: no three.js.

import { catenaryPoints, routeLength } from './site-layout-charger-cables';
import { solveIncreasing } from './site-layout-cable-rest';
import { densify, onBootAxis } from './site-layout-cable-surface';
import type { Vec3 } from './site-layout-model-kit';

/**
 * Where a coil hangs, in the station frame: the saddle's arc center, the unit
 * vector across the saddle in the turns' plane from the entry side toward the
 * far side (`u`, level), the saddle axis the turns stack along (`axis`), and
 * the radius the cable's center line runs at over the saddle (`r1`).
 */
export interface CoilPlace {
  center: Vec3;
  u: Vec3;
  axis: Vec3;
  r1: number;
}

/** A turn's bottom radius: the cable hangs open at its bottom, at least six diameters. */
export function coilBottomRadius(cableDiameterM: number): number {
  return Math.max(0.12, 6 * cableDiameterM);
}

const add = (p: Vec3, q: Vec3, k = 1): Vec3 => [p[0] + q[0] * k, p[1] + q[1] * k, p[2] + q[2] * k];

/** The point at (s across, t up, a along the axis) of the coil frame. */
function at(c: CoilPlace, s: number, t: number, a: number): Vec3 {
  return add(add(add(c.center, c.u, s), [0, 1, 0], t), c.axis, a);
}

function arc(
  c: CoilPlace,
  cy: number,
  r: number,
  from: number,
  to: number,
  a0: number,
  a1: number,
  n: number,
): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const k = i / n;
    const ang = from + (to - from) * k;
    return at(c, r * Math.cos(ang), cy + r * Math.sin(ang), a0 + (a1 - a0) * k);
  });
}

function line(a: Vec3, b: Vec3, n: number): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as const;
  });
}

/**
 * The turns: each over the saddle from the entry side to the far side, down
 * the far side, round the bottom back to the entry side; between turns up the
 * entry side to the saddle one plane further along the axis. Ends at the
 * bottom of the last turn on the entry side.
 */
function turnPoints(c: CoilPlace, r2: number, turns: number, drop: number, dz: number): Vec3[] {
  const pts: Vec3[] = [];
  const by = -drop;
  for (let i = 0; i < turns; i += 1) {
    const a = i * dz;
    const next = a + dz;
    pts.push(...arc(c, 0, c.r1, Math.PI, 0, a, a, 10).slice(pts.length === 0 ? 0 : 1));
    pts.push(...line(at(c, c.r1, 0, a), at(c, r2, by, a), 8));
    pts.push(...arc(c, by, r2, 0, -Math.PI, a, a + dz / 2, 10).slice(1));
    if (i < turns - 1) pts.push(...line(at(c, -r2, by, a + dz / 2), at(c, -c.r1, 0, next), 8));
  }
  return pts;
}

export interface CoilCable {
  points: Vec3[];
  turns: number;
  /** The lowest cable center height of the turns. */
  bottomY: number;
}

/**
 * The idle cable over its hanger: `entry` (the gland run, its last point
 * where the cable leaves it) up to the saddle's entry side, `turns` turns
 * (the first of `preferTurns` whose drop fits between `minDropM` and the
 * floor), off the last turn's bottom into the handle (`handle`, the boot
 * along its axis). `floorY` is the lowest the cable's center may hang.
 */
export function coilCable(o: {
  entry: readonly Vec3[];
  place: CoilPlace;
  cableDiameterM: number;
  handle: { lead: Vec3; end: Vec3 };
  floorY: number;
  lengthM: number;
  preferTurns?: readonly number[];
  minDropM?: number;
  /** The turns' bottom radius, at least `coilBottomRadius`. */
  bottomRadiusM?: number;
}): CoilCable {
  const d = o.cableDiameterM;
  const r2 = Math.max(coilBottomRadius(d), o.bottomRadiusM ?? 0);
  const dz = d * 1.15;
  const c = o.place;
  const start = o.entry[o.entry.length - 1] ?? c.center;
  const top = at(c, -c.r1, 0, 0);
  const rise = catenaryPoints(start, top, Math.min(start[1], top[1]) - 0.1, 12);
  const into = onBootAxis(o.handle.lead, o.handle.end, 0.06);
  const route = (turns: number, drop: number): Vec3[] => {
    const coil = turnPoints(c, r2, turns, drop, dz);
    const last = coil[coil.length - 1] ?? top;
    const off = catenaryPoints(last, into, Math.min(last[1], into[1]) - 0.02, 12);
    return [
      ...o.entry.slice(0, -1),
      ...rise,
      ...coil.slice(1),
      ...off.slice(1),
      o.handle.lead,
      o.handle.end,
    ];
  };
  const minDrop = o.minDropM ?? 0.05;
  // The drop that puts the turn's bottom at the floor.
  const maxDrop = c.center[1] - r2 - o.floorY;
  for (const turns of o.preferTurns ?? [3, 2, 4, 5, 6]) {
    if (maxDrop < minDrop) break;
    if (routeLength(route(turns, minDrop)) > o.lengthM) continue;
    if (routeLength(route(turns, maxDrop)) < o.lengthM) continue;
    const drop = solveIncreasing((x) => routeLength(route(turns, x)), minDrop, maxDrop, o.lengthM);
    return { points: densify(route(turns, drop)), turns, bottomY: c.center[1] - drop - r2 };
  }
  // Nothing fits: the fewest turns at the shortest drop (a cable too short for its hanger).
  const turns = 1;
  return { points: densify(route(turns, minDrop)), turns, bottomY: c.center[1] - minDrop - r2 };
}
