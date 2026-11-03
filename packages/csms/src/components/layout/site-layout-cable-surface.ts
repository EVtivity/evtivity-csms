// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Cables rest on what is under them (owner rules 2026-11-02): every cable point
// stays above the highest surface under it (paving, curb, sidewalk, pad or
// island top) by the cable radius plus a gap, and outside every tire's contact
// patch.

import type { Vec3 } from './site-layout-model-kit';
import { TIRE_WIDTH_M } from './site-layout-car-geometry';
import { BAY_STATION_Z, CURB_M, CURB_POST_BACK_M, FACADE_Z } from './site-layout-grid';

/**
 * The gap between a cable and the surface under it: 1 cm, so a cable resting
 * on concrete never shows sunk into it (display rounding of the tube's 8 sided
 * section is under 1 mm at these radii: r (1 - cos(pi / 8)) = 0.076 r).
 */
export const CABLE_SURFACE_GAP_M = 0.01;

/**
 * The tops of the ground surfaces the scene builds: the paved lot and street
 * planes, a 0.12 m sidewalk slab and a 0.14 m curb strip (6 in curb face,
 * 4.7 in walk: the common US curb and walk, AASHTO A Policy on Geometric
 * Design, curbs 4 to 9 in high).
 */
export const SURFACE_M = { paving: 0.012, sidewalk: 0.12, curb: 0.14 } as const;

/** A surface height function in a station's own frame: the top of what is at (x, z). */
export type SurfaceAt = (x: number, z: number) => number;

/**
 * The height a cable of radius `r` rests at over (x, z): the highest surface
 * within `r` of it (so it drapes over a step instead of cutting its edge) plus
 * `r` plus the gap.
 */
export function restHeight(surface: SurfaceAt, x: number, z: number, r: number): number {
  let top = surface(x, z);
  for (const [dx, dz] of [
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
  ] as const) {
    top = Math.max(top, surface(x + dx, z + dz));
  }
  return top + r + CABLE_SURFACE_GAP_M;
}

/** Lifts every point that would sink into the surface onto it (a cable resting there). */
export function liftOntoSurface(points: readonly Vec3[], surface: SurfaceAt, r: number): Vec3[] {
  return points.map((p) => {
    const min = restHeight(surface, p[0], p[2], r);
    return p[1] < min ? [p[0], min, p[2]] : p;
  });
}

/**
 * A ground run: the polyline through `path` ([x, z] corners), split every 0.1 m,
 * every point resting on the surface (`restHeight`).
 */
export function groundRun(
  path: ReadonlyArray<readonly [number, number]>,
  surface: SurfaceAt,
  r: number,
  stepM = 0.1,
): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    if (a == null || b == null) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let k = i === 1 ? 0 : 1; k <= n; k += 1) {
      const t = k / n;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      out.push([x, restHeight(surface, x, z, r), z]);
    }
  }
  return out;
}

/** An axis aligned rectangle on the ground, in a station's own frame. */
export interface GroundRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * A tire's contact patch: the tire width (`TIRE_WIDTH_M`, 0.24 m) by its
 * length. Derived: a 2000 kg car loads each tire with about 4900 N; at a
 * 240 kPa (35 psi) inflation the patch is about 0.020 m^2, so 0.024 / 0.24 =
 * 0.085 m long; rounded up to 0.1 m. The margin is 0.15 m all round, room for
 * a hand and the tire's bulge.
 */
export const TIRE_PATCH = { widthM: TIRE_WIDTH_M, lengthM: 0.1, marginM: 0.15 } as const;

/** What the footprint needs of a car profile. */
export interface TireProfile {
  width: number;
  frontAxle: number;
  rearAxle: number;
}

/** Maps a point of a car's own frame ([x, z]: nose at z 0, body along +z) to the station frame. */
export type CarToStation = (x: number, z: number) => readonly [number, number];

/** The four tire patches of a car, each grown by the margin, in the station frame. */
export function tireFootprints(profile: TireProfile, toStation: CarToStation): GroundRect[] {
  const tx = profile.width / 2 - TIRE_PATCH.widthM / 2 - 0.03;
  const hw = TIRE_PATCH.widthM / 2 + TIRE_PATCH.marginM;
  const hl = TIRE_PATCH.lengthM / 2 + TIRE_PATCH.marginM;
  const rects: GroundRect[] = [];
  for (const axle of [profile.frontAxle, profile.rearAxle]) {
    for (const side of [-1, 1]) {
      const corners = [toStation(side * tx - hw, axle - hl), toStation(side * tx + hw, axle + hl)];
      const [a, b] = corners;
      if (a == null || b == null) continue;
      rects.push({
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
        minZ: Math.min(a[1], b[1]),
        maxZ: Math.max(a[1], b[1]),
      });
    }
  }
  return rects;
}

/** Whether a ground point lies inside a rectangle. */
export function insideRect(x: number, z: number, r: GroundRect): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/** The route points within `heightM` of the ground that lie in any of the rectangles. */
export function pointsInFootprints(
  points: readonly Vec3[],
  rects: readonly GroundRect[],
  heightM = 0.5,
): Vec3[] {
  return points.filter((p) => p[1] <= heightM && rects.some((r) => insideRect(p[0], p[2], r)));
}

/** The car body's plan rectangle in the station frame. */
export function bodyRect(
  profile: { width: number; length: number },
  toStation: CarToStation,
): GroundRect {
  const a = toStation(-profile.width / 2, 0);
  const b = toStation(profile.width / 2, profile.length);
  return {
    minX: Math.min(a[0], b[0]),
    maxX: Math.max(a[0], b[0]),
    minZ: Math.min(a[1], b[1]),
    maxZ: Math.max(a[1], b[1]),
  };
}

/**
 * The point `distM` out from a handle's lead along its boot axis (from the end
 * inside the boot through the lead), so the cable enters straight.
 */
export function onBootAxis(lead: Vec3, end: Vec3, distM: number): Vec3 {
  const d = [lead[0] - end[0], lead[1] - end[1], lead[2] - end[2]] as const;
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  return [lead[0] + (d[0] / n) * distM, lead[1] + (d[1] / n) * distM, lead[2] + (d[2] / n) * distM];
}

/**
 * The ground of an office or retail row station (row 0, not turned), in its
 * own frame: the paved row from the lot edge (station z = -BAY_STATION_Z),
 * the curb strip before it, the sidewalk back to the facade, nothing behind
 * the facade (inside the building, never reached).
 */
export function officeRowSurface(): SurfaceAt {
  const lotEdge = -BAY_STATION_Z;
  const curbBack = lotEdge - CURB_M;
  const facade = FACADE_Z - BAY_STATION_Z;
  return (_x, z) =>
    z >= lotEdge
      ? SURFACE_M.paving
      : z >= curbBack
        ? SURFACE_M.curb
        : z >= facade
          ? SURFACE_M.sidewalk
          : 0;
}

/**
 * The ground of a curbside station (the left curb, not turned), in its own
 * frame: the sidewalk to the curb back (station z CURB_POST_BACK_M), the curb
 * strip to its face, the parking lane and the street beyond.
 */
export function curbsideSurface(): SurfaceAt {
  const curbBack = CURB_POST_BACK_M;
  const curbFace = CURB_POST_BACK_M + CURB_M;
  return (_x, z) =>
    z >= curbFace ? SURFACE_M.paving : z >= curbBack ? SURFACE_M.curb : SURFACE_M.sidewalk;
}

/** A round post a cable must clear (a bollard): its center, radius and height. */
export interface GroundPost {
  x: number;
  z: number;
  radiusM: number;
  heightM: number;
}

/**
 * Whether a cable point of radius `r` touches the car (its plan up to its
 * height), a tire's patch (up to 0.5 m) or a post, each grown by `r` plus the
 * surface gap.
 */
export function cableBlocked(o: {
  body: GroundRect;
  bodyHeightM: number;
  tires: readonly GroundRect[];
  posts: readonly GroundPost[];
  radiusM: number;
}): (p: Vec3) => boolean {
  const g = o.radiusM + CABLE_SURFACE_GAP_M;
  return (p) => {
    const inBody =
      p[0] > o.body.minX - g &&
      p[0] < o.body.maxX + g &&
      p[2] > o.body.minZ - g &&
      p[2] < o.body.maxZ + g &&
      p[1] < o.bodyHeightM + g;
    if (inBody) return true;
    if (p[1] <= 0.5 && o.tires.some((t) => insideRect(p[0], p[2], t))) return true;
    return o.posts.some(
      (q) => Math.hypot(p[0] - q.x, p[2] - q.z) < q.radiusM + g && p[1] < q.heightM + g,
    );
  };
}

/** The car's own frame in the station frame: nose in at (x, frontZ), or backed in (turned a half turn). */
export function carToStation(
  at: { x: number; z: number },
  length: number,
  backedIn: boolean,
): CarToStation {
  return backedIn
    ? (x, z) => [at.x - x, at.z + length - z] as const
    : (x, z) => [at.x + x, at.z + z] as const;
}

/** The points with a point added on every segment longer than `maxStepM` (evenly), so a tube follows them. */
export function densify(points: readonly Vec3[], maxStepM = 0.08): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const b = points[i];
    if (b == null) continue;
    const a = out[out.length - 1];
    if (a != null) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const n = Math.ceil(len / maxStepM);
      for (let k = 1; k < n; k += 1) {
        const t = k / n;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    out.push(b);
  }
  return out;
}
