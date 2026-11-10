// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An idle cable looped over its J hook (owner rules 2026-11-02, 2026-11-09): one piece from
// its gland, up over the hook in whole hanging turns the way drivers
// coil it, the handle's cable coming off the bottom of the last turn up into
// the handle in its holster. The turns' drop is solved on the drawn points, so
// the drawn cable has the cable's length; every turn hangs clear of the ground
// under it. Pure: no three.js.

import { routeLength } from './site-layout-charger-cables';
import { solveIncreasing } from './site-layout-cable-rest';
import { densify, onBootAxis } from './site-layout-cable-surface';
import { directionOf, dubinsJoin, smoothJoin, tightestBend } from './site-layout-cable-relax';
import { CABLE_MIN_BEND_RATIO } from './site-layout-model-cable-gland';
import { CABLE_TURN_PITCH } from './site-layout-model-cable-hook';
import type { Vec3 } from './site-layout-model-kit';

/**
 * Where a coil hangs, in the station frame: the center of the cable's top
 * bend over the hook, the unit vector across the hook in the turns' plane
 * from the entry side toward the far side (`u`, level), the hook's throat
 * the turns stack along (`axis`), and the radius the cable's center line
 * bends at over the hook (`r1`, `coilTopRadius`).
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

/**
 * The turns: each over the hook from the entry side to the far side, down
 * the far side, round the bottom back to the entry side; between turns up the
 * entry side to the hook one plane further along the axis. Ends at the
 * bottom of the last turn on the entry side. A cable that comes down onto
 * the hook (`fromTop`) lies on it from the hook's top, else it comes up the
 * entry side. The legs between the hook and the bottom are curves tangent to
 * both bends (straight down when they are as wide), so no turn has a corner.
 */
function turnPoints(
  c: CoilPlace,
  r2: number,
  turns: number,
  drop: number,
  dz: number,
  fromTop: boolean,
  offAngle = 0,
  entryA = 0,
): { pts: Vec3[]; onHook: boolean[]; offHeading: Vec3 } {
  const pts: Vec3[] = [];
  const onHook: boolean[] = [];
  const push = (list: Vec3[], held: boolean): void => {
    for (const p of list) {
      pts.push(p);
      onHook.push(held);
    }
  };
  const by = -drop;
  const down: Vec3 = [0, -1, 0];
  const up: Vec3 = [0, 1, 0];
  for (let i = 0; i < turns; i += 1) {
    const a = i * dz;
    const next = a + dz;
    const from = i === 0 && fromTop ? Math.PI / 2 : Math.PI;
    push(
      arc(c, 0, c.r1, from, 0, i === 0 ? entryA : a, a, 10).slice(pts.length === 0 ? 0 : 1),
      true,
    );
    push(smoothJoin(at(c, c.r1, 0, a), down, at(c, r2, by, a), down, 9).slice(1), false);
    // Round the bottom one whole pitch out, so the turn comes back up the
    // entry side in the next turn's plane: every leg on the entry side (the
    // gland run, each turn's way back up, the way off to the handle) keeps
    // its own plane a pitch from the others and never passes through them.
    // The last turn leaves its bottom `offAngle` before the entry side, so
    // the way off to the handle rises inside the turns, clear of the gland run.
    // The last turn's bottom moves out one and a half pitches: the way off to
    // the handle then runs half a pitch further out than a next turn would,
    // a margin over the gland run in the first plane.
    const lastTurn = i === turns - 1;
    const end = lastTurn ? -Math.PI + offAngle : -Math.PI;
    const n = Math.max(3, Math.round((10 * -end) / Math.PI));
    const outM = (lastTurn ? 1.5 : 1) * dz;
    push(arc(c, by, r2, 0, end, a, a + (outM * -end) / Math.PI, n).slice(1), false);
    if (i < turns - 1) {
      push(smoothJoin(at(c, -r2, by, next), up, at(c, -c.r1, 0, next), up, 9).slice(1), false);
    }
  }
  // The heading the cable leaves the last turn's bottom with (up at the entry side).
  const off = -Math.PI + offAngle;
  const offHeading = add(add([0, 0, 0], c.u, Math.sin(off)), [0, 1, 0], -Math.cos(off));
  return { pts, onHook, offHeading };
}

/**
 * The level heading of `h` (its horizontal part); for a heading within 15
 * degrees of straight up or down, the level way toward `toward`.
 */
function levelHeading(h: Vec3, from: Vec3, toward: Vec3): Vec3 {
  const n = Math.hypot(h[0], h[2]);
  if (n > Math.sin(Math.PI / 12)) return [h[0] / n, 0, h[2] / n];
  const dx = toward[0] - from[0];
  const dz = toward[2] - from[2];
  const m = Math.hypot(dx, dz);
  return m < 1e-6 ? [1, 0, 0] : [dx / m, 0, dz / m];
}

/**
 * The arc of radius `radiusM` from `p` heading `h` (steeply up or down) to
 * level (`levelHeading`, toward `toward` for a vertical heading): only `p`
 * when `h` is already within 15 degrees of level.
 */
function turnLevel(p: Vec3, h: Vec3, radiusM: number, toward: Vec3): Vec3[] {
  const level = levelHeading(h, p, toward);
  const ang = Math.asin(Math.max(-1, Math.min(1, h[1])));
  if (Math.abs(ang) < Math.PI / 12) return [p];
  const n = Math.max(2, Math.ceil(Math.abs(ang) / (Math.PI / 16)));
  return Array.from({ length: n + 1 }, (_, k) => {
    // The heading goes from `ang` above level to level; the arc integrates it.
    const theta = ang * (1 - k / n);
    const along = radiusM * Math.sign(ang) * (Math.sin(Math.abs(ang)) - Math.sin(Math.abs(theta)));
    const rise = radiusM * Math.sign(ang) * (Math.cos(theta) - Math.cos(ang));
    return [
      p[0] + level[0] * Math.abs(along),
      p[1] + rise,
      p[2] + level[2] * Math.abs(along),
    ] as const;
  });
}

/**
 * A join between two pieces of a cable at the cable's bend (`dubinsJoin`):
 * the tightest radius from `bendM` down to half of it that does not loop
 * round (a join that must take more than its straight distance and one half
 * turn), else half the bend. Derived.
 */
function stiffJoin(
  p0: Vec3,
  h0: Vec3,
  p1: Vec3,
  h1: Vec3,
  bendM: number,
  plane: 'vertical' | 'horizontal',
): Vec3[] {
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  let path: Vec3[] = [];
  for (const k of [1, 0.85, 0.7, 0.6, 0.5]) {
    const r = bendM * k;
    path = dubinsJoin(p0, h0, p1, h1, r, 0.04, plane);
    if (routeLength(path) <= dist + Math.PI * r) return path;
  }
  return path;
}

export interface CoilCable {
  points: Vec3[];
  turns: number;
  /** The lowest cable center height of the turns. */
  bottomY: number;
  /** Whether a turn count of `preferTurns` takes the cable's length. */
  fits: boolean;
  /** The length each turn count tried takes at its shortest and longest drop. */
  ranges: Array<{ turns: number; shortestM: number; longestM: number }>;
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
  /** The turns' bottom radius (default: as open as the top bend, at least 0.12 m). */
  bottomRadiusM?: number;
  /** No free span bends tighter than this (default six cable diameters, the gland bend). */
  bendM?: number;
  /** The cable's heading where it leaves its gland run (default: along the run's last segment). */
  entryHeading?: Vec3;
  /** Rise straight up from the last turn to this far under the boot before turning to it (a cable with others outside it on the hook). */
  offRiseUnderBootM?: number;
  /**
   * How the cable comes onto the hook: down onto its top ('top') or up its
   * entry side ('side'); absent: onto the top when the gland run ends above
   * the hook's bend center, else up the side.
   */
  enterFrom?: 'top' | 'side';
  /**
   * How far before the entry side (radians round its bottom) the last turn
   * leaves for the handle: the way off then rises inside the turns, clear of
   * the gland run beside them (default 0: off the entry side).
   */
  offAngleRad?: number;
  /**
   * A gland behind the first turn's plane (nearer the body, an AC pedestal's
   * under its head): the way up the entry side never passes that plane
   * toward the other turns, whose ways back up the same side run a pitch
   * further out (default false).
   */
  entryBehindFirstTurn?: boolean;
  /**
   * A gland in front of the first turn's plane (a wall box's under the box):
   * the fraction of its way up the entry side by which the cable reaches
   * that plane, beside the turns (default: spread over the whole way).
   */
  entryPlaneWithin?: number;
}): CoilCable {
  const d = o.cableDiameterM;
  // The loop hangs as a long U: its bottom as open as its top bend (at least
  // 0.12 m), so the legs run straight down from the hook.
  const r2 = o.bottomRadiusM ?? Math.max(0.12, o.place.r1);
  const dz = d * CABLE_TURN_PITCH;
  const c = o.place;
  const start = o.entry[o.entry.length - 1] ?? c.center;
  const before = o.entry[o.entry.length - 2] ?? start;
  const bendM = o.bendM ?? CABLE_MIN_BEND_RATIO * d;
  // A gland above the hook lays the cable down onto the hook's top, moving
  // across it; one below brings it up the hook's entry side in a U (gravity).
  // Either way the cable leaves its gland run along it and turns on the
  // cable's bend (`bendM`) into the hook, never folding back at a corner
  // (`stiffJoin`).
  const fromTop = o.enterFrom != null ? o.enterFrom === 'top' : start[1] > c.center[1];
  // A gland behind the first turn brings the cable up a tenth of a pitch
  // behind its plane, a margin over the next turn's way back up (derived).
  const entryA = !fromTop && o.entryBehindFirstTurn === true ? -0.1 * dz : 0;
  const top = fromTop ? at(c, 0, c.r1, 0) : at(c, -c.r1, 0, entryA);
  const t0 =
    o.entryHeading != null ? directionOf([0, 0, 0], o.entryHeading) : directionOf(before, start);
  const rise = fromTop
    ? (() => {
        // A cable leaving its run steeply first bends level, then turns across onto the hook.
        const level = turnLevel(start, t0, bendM, top);
        const at0 = level[level.length - 1] ?? start;
        const h: Vec3 = levelHeading(t0, start, top);
        return [...level, ...stiffJoin(at0, h, top, c.u, bendM, 'horizontal').slice(1)];
      })()
    : // Up the entry side, never past the first turn's plane toward the
      // others: the turns' ways back up that side run a pitch further out.
      stiffJoin(
        start,
        t0,
        top,
        [0, 1, 0],
        // A U narrower than two bends where the hook stands nearer than that.
        Math.min(bendM, Math.hypot(top[0] - start[0], top[2] - start[2]) / 2),
        'vertical',
      );
  const outOf = (p: Vec3): number =>
    (p[0] - c.center[0]) * c.axis[0] +
    (p[1] - c.center[1]) * c.axis[1] +
    (p[2] - c.center[2]) * c.axis[2];
  if (!fromTop && o.entryBehindFirstTurn === true) {
    for (let i = 0; i < rise.length; i += 1) {
      const p = rise[i] ?? top;
      const out = outOf(p);
      if (out > entryA) rise[i] = add(p, c.axis, entryA - out);
    }
  }
  // A gland in front of the first turn's plane: the cable reaches that plane
  // within `entryPlaneWithin` of its way up (a smoothstep), out beside the
  // turns, then comes up in it a pitch from the turns' ways back up.
  const within = o.entryPlaneWithin;
  if (!fromTop && within != null && rise.length > 1) {
    const lens = [0];
    for (let i = 1; i < rise.length; i += 1) {
      const a = rise[i - 1] ?? top;
      const b = rise[i] ?? top;
      lens.push((lens[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = lens[lens.length - 1] ?? 1;
    const a0 = outOf(rise[0] ?? top) - entryA;
    for (let i = 1; i < rise.length; i += 1) {
      const p = rise[i] ?? top;
      const x = Math.min(1, (lens[i] ?? 0) / (total * within));
      const target = entryA + a0 * (1 - x * x * (3 - 2 * x));
      rise[i] = add(p, c.axis, target - outOf(p));
    }
  }
  // The way into the boot: planned from the boot back down to the loop (out
  // of the boot along its axis, then down), at the cable's bend.
  const into = onBootAxis(o.handle.lead, o.handle.end, 0.06);
  const t1 = directionOf(into, o.handle.lead);
  const route = (turns: number, drop: number): Vec3[] => {
    const coil = turnPoints(c, r2, turns, drop, dz, fromTop, o.offAngleRad ?? 0, entryA);
    const last = coil.pts[coil.pts.length - 1] ?? top;
    // A cable with others outside it on its hook first rises in its own
    // plane to just under the boot, so it crosses out to its handle above
    // their turns.
    const under = o.offRiseUnderBootM != null ? into[1] - o.offRiseUnderBootM : -Infinity;
    const rise2: Vec3 | null =
      under > last[1] + 0.01 && (o.offAngleRad ?? 0) === 0 ? [last[0], under, last[2]] : null;
    const leave: Vec3 = rise2 != null ? [0, 1, 0] : coil.offHeading;
    const off = [
      ...(rise2 != null ? [last] : []),
      ...stiffJoin(
        into,
        [-t1[0], -t1[1], -t1[2]],
        rise2 ?? last,
        [-leave[0], -leave[1], -leave[2]],
        bendM,
        'vertical',
      ).reverse(),
    ];
    const pts = [
      ...o.entry.slice(0, -1),
      ...rise,
      ...coil.pts.slice(1),
      ...off.slice(1),
      o.handle.lead,
      o.handle.end,
    ];
    return pts;
  };
  const minDrop = o.minDropM ?? 0.05;
  // The drop that puts the turn's bottom at the floor.
  const maxDrop = c.center[1] - r2 - o.floorY;
  const ranges: CoilCable['ranges'] = [];
  for (const turns of o.preferTurns ?? [3, 2, 4, 5, 6]) {
    if (maxDrop < minDrop) break;
    const shortest = routeLength(route(turns, minDrop));
    const longest = routeLength(route(turns, maxDrop));
    ranges.push({ turns, shortestM: shortest, longestM: longest });
    if (shortest > o.lengthM || longest < o.lengthM) continue;
    const drop = solveIncreasing((x) => routeLength(route(turns, x)), minDrop, maxDrop, o.lengthM);
    return {
      points: densify(route(turns, drop)),
      turns,
      bottomY: c.center[1] - drop - r2,
      fits: true,
      ranges,
    };
  }
  // Nothing fits: the fewest turns at the shortest drop (a cable too short for its hook).
  const turns = 1;
  return {
    points: densify(route(turns, minDrop)),
    turns,
    bottomY: c.center[1] - minDrop - r2,
    fits: false,
    ranges,
  };
}

/** The points of `points` subdivided to at most `stepM` apart. */
function subdivide(points: readonly Vec3[], stepM: number): Vec3[] {
  const out: Vec3[] = [];
  points.forEach((a, i) => {
    const b = points[i + 1];
    if (b == null) {
      out.push(a);
      return;
    }
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / stepM));
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  });
  return out;
}

/**
 * The closest two parts of a cable come, center to center, more than six
 * diameters apart along it (owner decision 2026-11-10: no cable passes
 * through itself; adjacent turns on a hook sit a pitch, 1.05 D, apart). On
 * the drawn polyline, subdivided to a quarter diameter.
 */
export function cableSelfClearance(points: readonly Vec3[], cableDiameterM: number): number {
  const pts = subdivide(points, cableDiameterM / 4);
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] ?? [0, 0, 0];
    const b = pts[i] ?? a;
    s.push((s[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const gap = 6 * cableDiameterM;
  let min = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i] ?? [0, 0, 0];
    for (let j = i + 1; j < pts.length; j += 1) {
      if ((s[j] ?? 0) - (s[i] ?? 0) < gap) continue;
      const q = pts[j] ?? p;
      const dd = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (dd < min) min = dd;
    }
  }
  return min;
}

/** The closest two cables come, center to center, on their polylines subdivided to `stepM`. */
export function cableGap(a: readonly Vec3[], b: readonly Vec3[], stepM = 0.01): number {
  const pa = subdivide(a, stepM);
  const pb = subdivide(b, stepM);
  let min = Infinity;
  for (const p of pa) {
    for (const q of pb) {
      const dd = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (dd < min) min = dd;
    }
  }
  return min;
}

/**
 * How close, in diameters, two parts of an idle cable may come on its drawn
 * points: 1.04, just under the 1.05 D pitch adjacent turns rest at on a hook
 * (`CABLE_TURN_PITCH`), a margin over the one diameter the smooth curve the
 * scene draws must keep. Derived.
 */
export const SELF_CLEARANCE_MIN_RATIO = 1.04;

/**
 * Of the coils `coilCable` hangs at each of `bottomRadii` (and each of
 * `offAngles`), the first that keeps the cable's length (within 2 cm),
 * clears itself by `SELF_CLEARANCE_MIN_RATIO` diameters on the drawn points
 * and bends no tighter than `minBendRatio` diameters past its gland run;
 * else the one that comes closest. Derived.
 */
export function clearCoilCable(
  o: Parameters<typeof coilCable>[0],
  bottomRadii: readonly number[],
  offAngles: readonly number[] = [0],
  minBendRatio = 1.9,
): CoilCable {
  const d = o.cableDiameterM;
  let best: { score: number; coil: CoilCable } | null = null;
  for (const r2 of bottomRadii) {
    for (const phi of offAngles) {
      const coil = coilCable({ ...o, bottomRadiusM: r2, offAngleRad: phi });
      const lengthOk = Math.abs(routeLength(coil.points) - o.lengthM) < 0.02;
      const clear = cableSelfClearance(coil.points, d) / (SELF_CLEARANCE_MIN_RATIO * d);
      const bend = tightestBend(coil.points, 4, coil.points.length - 4) / (minBendRatio * d);
      if (lengthOk && clear >= 1 && bend >= 1) return coil;
      const score = (lengthOk ? 1 : 0) + Math.min(clear, bend, 1);
      if (best == null || score > best.score) best = { score, coil };
    }
  }
  return best?.coil ?? coilCable(o);
}

/** Bottom radii from `fromM` to `toM` in 0.03 m steps. */
export function bottomRadiusSteps(fromM: number, toM: number): number[] {
  const out: number[] = [];
  for (let r = fromM; r <= toM + 1e-9; r += 0.03) out.push(Math.round(r * 1000) / 1000);
  return out;
}
