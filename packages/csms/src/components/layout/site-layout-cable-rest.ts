// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Cables of a fixed length (owner rules 2026-11-02): a cable shows its real
// length, hangs as a catenary while it clears the ground, and where it would
// reach the ground it rests on it, the rest lying in a bow on the surface
// under it. Pure: no three.js.

import { catenaryPoints, routeLength } from './site-layout-charger-cables';
import {
  densify,
  groundRun,
  liftOntoSurface,
  onBootAxis,
  restHeight,
  type GroundRect,
  type SurfaceAt,
} from './site-layout-cable-surface';
import type { Vec3 } from './site-layout-model-kit';

/** The x in [lo, hi] where the increasing `f` reaches `target` (bisection). */
export function solveIncreasing(
  f: (x: number) => number,
  lo: number,
  hi: number,
  target: number,
): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 48; i += 1) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/**
 * The catenary of `length` between p1 and p2: the lowest point solved so the
 * drawn points have the length (a lower lowest point gives a longer curve).
 * `length` at most the chord gives the chord's catenary with its lowest point
 * at the lower end.
 */
export function catenaryOfLength(p1: Vec3, p2: Vec3, length: number, n = 24): Vec3[] {
  const low = Math.min(p1[1], p2[1]);
  const at = (drop: number): Vec3[] => catenaryPoints(p1, p2, low - drop, n);
  if (routeLength(at(0)) >= length) return at(0);
  const drop = solveIncreasing((x) => routeLength(at(x)), 0, 100, length);
  return at(drop);
}

/**
 * The vertex form catenary from a support `h` above the ground to where it
 * touches down with a level tangent, its parameter `a` (the bend radius at
 * the touchdown): it reaches out a acosh(1 + h / a) and is
 * sqrt(h^2 + 2 a h) long.
 */
export function touchdownReach(h: number, a: number): number {
  return a * Math.acosh(1 + Math.max(0, h) / a);
}

export interface RestingCable {
  points: Vec3[];
  /** Whether part of it lies on the ground. */
  onGround: boolean;
}

/**
 * A cable of `length` from p1 to p2 that rests where it reaches the ground:
 * - while the catenary of that length clears the surface, that catenary;
 * - else it hangs from each end down to the ground (vertex form, bend radius
 *   `bendM`), each touchdown `out` (a unit ground direction) from below its
 *   end, and the rest lies on the surface in a teardrop bow along `lay`: out
 *   to its far end, round a turn of radius `bendM`, back, its reach solved so
 *   the drawn points have the length.
 */
export function restingCable(o: {
  p1: Vec3;
  p2: Vec3;
  length: number;
  surface: SurfaceAt;
  radiusM: number;
  out: readonly [number, number];
  /** The touchdown direction from p2, when it differs from `out`. */
  out2?: readonly [number, number];
  lay: readonly [number, number];
  bendM: number;
}): RestingCable {
  const r = o.radiusM;
  const hang = catenaryOfLength(o.p1, o.p2, o.length);
  const clears = hang.every((p) => p[1] >= restHeight(o.surface, p[0], p[2], r) - 1e-9);
  if (clears) return { points: hang, onGround: false };
  // `a` is the catenary parameter at each touchdown (its bend radius there).
  const touch = (p: Vec3, dir: readonly [number, number], a: number): Vec3 => {
    // The touchdown height is the surface under it; the reach follows from the drop.
    let x = p[0];
    let z = p[2];
    let y = restHeight(o.surface, x, z, r);
    for (let i = 0; i < 3; i += 1) {
      const reach = touchdownReach(p[1] - y, a);
      x = p[0] + dir[0] * reach;
      z = p[2] + dir[1] * reach;
      y = restHeight(o.surface, x, z, r);
    }
    return [x, y, z];
  };
  const build = (a: number, reach: number): Vec3[] => {
    const t1 = touch(o.p1, o.out, a);
    const t2 = touch(o.p2, o.out2 ?? o.out, a);
    const down = catenaryPoints(o.p1, t1, t1[1], 14);
    const up = catenaryPoints(t2, o.p2, t2[1], 14);
    // The bow: from t1 out along `lay` to its far end, round, back to t2; the
    // first leg on t1's side, so it never crosses itself.
    const mid: readonly [number, number] = [(t1[0] + t2[0]) / 2, (t1[2] + t2[2]) / 2];
    const flip = (t1[0] - mid[0]) * -o.lay[1] + (t1[2] - mid[1]) * o.lay[0] > 0 ? -1 : 1;
    const nx = -o.lay[1] * flip;
    const nz = o.lay[0] * flip;
    const path: Array<readonly [number, number]> = [[t1[0], t1[2]]];
    if (reach > 0) {
      const tip: readonly [number, number] = [mid[0] + o.lay[0] * reach, mid[1] + o.lay[1] * reach];
      for (let i = 0; i <= 8; i += 1) {
        const ang = -Math.PI / 2 + (Math.PI * i) / 8;
        path.push([
          tip[0] + o.lay[0] * Math.cos(ang) * o.bendM + nx * Math.sin(ang) * o.bendM,
          tip[1] + o.lay[1] * Math.cos(ang) * o.bendM + nz * Math.sin(ang) * o.bendM,
        ]);
      }
    }
    path.push([t2[0], t2[2]]);
    const ground = groundRun(path, o.surface, r);
    return [...down, ...ground.slice(1, -1), ...up];
  };
  const shortest = routeLength(build(o.bendM, 0));
  if (shortest > o.length) {
    // Too short to lie down at the bend radius: the touchdown curves open out
    // (a larger parameter, a longer reach and a shorter cable) until the drawn
    // cable has the length, at most where the two touchdowns meet.
    const span = Math.hypot(o.p2[0] - o.p1[0], o.p2[2] - o.p1[2]);
    let aMax = o.bendM;
    while (aMax < 50 && touchdownReach(o.p1[1], aMax) + touchdownReach(o.p2[1], aMax) < span) {
      aMax *= 1.5;
    }
    const a = solveIncreasing((x) => -routeLength(build(x, 0)), o.bendM, aMax, -o.length);
    return { points: build(a, 0), onGround: true };
  }
  const reach = solveIncreasing((x) => routeLength(build(o.bendM, x)), 0, 20, o.length);
  return { points: build(o.bendM, reach), onGround: true };
}

export interface PlugRoute {
  points: Vec3[];
  /** Whether the cable's length reaches (always, without a length). */
  reaches: boolean;
}

/**
 * A plugged cable from its anchor on the charger (`from`, the gland run or
 * the coil foot, the charger at the station origin, the car on +z) to the
 * handle in the car's port, outside the car and every tire:
 * - down from the anchor to the ground beside the charger (vertex form, bend
 *   radius `bendM`), along the ground to `outsideM` past the car's side at
 *   the car end facing the charger (or ahead of the nose for a nose port),
 *   and up from there into the handle along its boot axis, a hanging rise
 *   clear of the body (the port side is outside the car, the tires behind
 *   the port's inset or ahead of the axle);
 * - with `lengthM` (a fixed cable, DC) the rest of the length lies in a bow
 *   in the ground leg, its depth solved on the drawn points; a cable that
 *   cannot reach gets `reaches: false`.
 */
export function plugRoute(o: {
  from: readonly Vec3[];
  plug: { lead: Vec3; end: Vec3 };
  car: GroundRect;
  nosePort: boolean;
  surface: SurfaceAt;
  radiusM: number;
  bendM: number;
  lengthM?: number;
  outsideM?: number;
  /** Whether a point would touch the car, a tire or an obstacle (the air span is refused then). */
  blocked?: (p: Vec3) => boolean;
}): PlugRoute {
  const r = o.radiusM;
  const start = o.from[o.from.length - 1] ?? [0, 1, 0];
  const into = onBootAxis(o.plug.lead, o.plug.end, 0.06);
  // Every point rests on the surface (a curve between two points can dip below a curb edge).
  const rest = (pts: Vec3[]): Vec3[] => liftOntoSurface(densify(pts), o.surface, r);
  const carX = (o.car.minX + o.car.maxX) / 2;
  const outward = Math.sign(o.plug.lead[0] - carX) || -1;
  const out = o.outsideM ?? 0.35;
  const sideX = outward < 0 ? o.car.minX - out : o.car.maxX + out;
  // Down to the ground, toward the port's side of the car.
  const away = Math.sign(start[0]) || outward;
  const y0 = restHeight(o.surface, start[0], start[2], r);
  const reach = touchdownReach(start[1] - y0, o.bendM);
  // A nose port is ahead of the car's middle: touch down toward it, else out toward the port's side.
  const touch: readonly [number, number] = o.nosePort
    ? [start[0] - away * reach * 0.3, start[2] + reach * 0.95]
    : [start[0] + away * reach * 0.6, start[2] + reach * 0.8];
  const corner: readonly [number, number] = o.nosePort
    ? [into[0], Math.min(into[2] - 0.15, o.car.minZ - 0.2)]
    : [sideX, o.car.minZ - 0.3];
  const build = (bowM: number): Vec3[] => {
    const path: Array<readonly [number, number]> = [touch];
    if (bowM > 0) {
      const len = Math.hypot(corner[0] - touch[0], corner[1] - touch[1]) || 1;
      // Away from the car's end: the bow lies toward the charger side.
      let nx = (corner[1] - touch[1]) / len;
      let nz = -(corner[0] - touch[0]) / len;
      if (nz > 0) {
        nx = -nx;
        nz = -nz;
      }
      for (const t of [0.2, 0.4, 0.5, 0.6, 0.8]) {
        const k = Math.sin(Math.PI * t) * bowM;
        path.push([
          touch[0] + (corner[0] - touch[0]) * t + nx * k,
          touch[1] + (corner[1] - touch[1]) * t + nz * k,
        ]);
      }
    }
    path.push(corner);
    const ground = groundRun(path, o.surface, r);
    const first = ground[0] ?? [touch[0], y0, touch[1]];
    const last = ground[ground.length - 1] ?? first;
    const drop = catenaryPoints(start, first, first[1], 14);
    const rise = catenaryPoints(into, last, last[1], 14).reverse();
    return [
      ...o.from.slice(0, -1),
      ...drop,
      ...ground.slice(1),
      ...rise.slice(1),
      o.plug.lead,
      o.plug.end,
    ];
  };
  // A fixed cable first spans straight from its anchor toward the port and
  // lets the rest down onto the ground between them, bowed away from the car;
  // when that would touch the car, a tire or an obstacle, the ground route.
  if (o.lengthM != null) {
    const fixed = routeLength([...o.from]) + routeLength([into, o.plug.lead, o.plug.end]);
    const chord = [into[0] - start[0], into[2] - start[2]] as const;
    const cl = Math.hypot(chord[0], chord[1]) || 1;
    const dir = [chord[0] / cl, chord[1] / cl] as const;
    const left: readonly [number, number] = [dir[1], -dir[0]];
    const awayFromCar: readonly [number, number] =
      (start[0] + left[0] - carX) * outward > (start[0] - left[0] - carX) * outward
        ? left
        : [-left[0], -left[1]];
    const air = restingCable({
      p1: start,
      p2: into,
      length: o.lengthM - fixed,
      surface: o.surface,
      radiusM: r,
      out: dir,
      out2: [-dir[0], -dir[1]],
      lay: awayFromCar,
      bendM: o.bendM,
    });
    const points = [...o.from.slice(0, -1), ...air.points, o.plug.lead, o.plug.end];
    const clear = points.slice(0, -3).every((p) => o.blocked == null || !o.blocked(p));
    // Only a span that has the cable's length: a chord longer than the cable cannot be spanned.
    const exact = Math.abs(routeLength(points) - o.lengthM) <= 0.01 * o.lengthM;
    if (clear && exact) return { points: rest(points), reaches: true };
  }
  const bare = build(0);
  if (o.lengthM == null) return { points: rest(bare), reaches: true };
  const len = routeLength(bare);
  if (len > o.lengthM) return { points: rest(bare), reaches: false };
  const chord = Math.hypot(corner[0] - touch[0], corner[1] - touch[1]);
  const bow = solveIncreasing((x) => routeLength(build(x)), 0, Math.max(0.5, chord), o.lengthM);
  return { points: rest(build(bow)), reaches: true };
}
