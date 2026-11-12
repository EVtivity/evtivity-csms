// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The car of a curbside post and the cable to its port (owner request
// 2026-11-02: every car's port is its own, `carPortOf`). The car parks
// parallel, facing -x along the curb (with the traffic of its lane), so it
// cannot back in: a front port puts its nose by the post, a rear port parks
// it as far forward in its spot as it fits, its tail as near the post as the
// spot allows. The cable stays on the sidewalk and the curb top: a street
// side port is mirrored to the curb side (`curbPortOf`).
//
// Frame: a curbside station's own frame (the left curb, not turned): the post
// at the origin on the sidewalk, +z toward the street, the parallel spot from
// x = -CURB_POST_IN_M to the spot length past it.

import { carPortLocal, type CarPort } from './site-layout-cable';
import type { CarProfile } from './site-layout-car';
import { CURB_M, CURB_POST_BACK_M, CURB_POST_IN_M } from './site-layout-grid';
import { STANDARD_DIMENSIONS } from '@evtivity/lib/site-layout';
import type { Vec3 } from './site-layout-model-kit';
import { AC_CABLE_M, catenaryPoints } from './site-layout-charger-cables';
import {
  groundRun,
  onBootAxis,
  type CarToStation,
  type SurfaceAt,
} from './site-layout-cable-surface';

/**
 * Where a parallel car stands: its right side 0.15 m (6 in) from the curb
 * face (California Vehicle Code 22502(a): the right wheels within 18 in of
 * the curb; a common 6 in, room for a hand at a curb side inlet); its nose
 * 0.3 m past the post for a front port (as
 * the scene has always parked it) while the car fits its spot, else as far
 * forward as fits; a rear port 0.2 m inside the front end of its spot, the
 * tail as near the post as the spot allows. Derived.
 */
export const PARALLEL_CAR = { curbGapM: 0.15, noseByPostX: 0.3, endInsetM: 0.2 } as const;

/** The charging cable of a curbside post: the AC pedestal cable (`AC_CABLE_M`, 5.79 m). */
export const CURB_POST_CABLE_M = AC_CABLE_M;

/** The curb face (toward the street) and the edge of the travel lane, in the station's z. */
export const CURB_FACE_Z = CURB_POST_BACK_M + CURB_M;
export const TRAVEL_LANE_Z = CURB_FACE_Z + STANDARD_DIMENSIONS.parallelSpotWidthM;

export interface ParallelPlace {
  /** The nose x and the car's center line z. */
  noseX: number;
  centerZ: number;
  toStation: CarToStation;
}

/**
 * The charge port a curbside car draws (owner rules 2026-11-02): its own
 * port mirrored to the curb side, so no cable is ever on the street side of
 * the car (front left to front right, rear left to rear right; the nose port
 * stays, reached along the curb). A rear left port would have needed 9.3 to
 * 10.5 m of cable around the tail; the curb side ports reach in at most 5.21 m
 * (measured, a pickup truck's rear right port), inside the 5.79 m post cable
 * (`CURB_POST_CABLE_M`).
 */
export function curbPortOf(port: CarPort): CarPort {
  if (port === 'front_left') return 'front_right';
  if (port === 'rear_left') return 'rear_right';
  return port;
}

/**
 * The spot of a car at a two-port curb post (`TWO_PORT_CURB_POST`), which
 * stands on the line between its two parallel spots: EVSE 1's car in the
 * spot on its left seen from the street (`left`, x from minus the spot
 * length to 0), EVSE 2's on its right (`right`, x from 0 to the spot
 * length). Absent: a one-port post's own spot.
 */
export type CurbSpot = 'left' | 'right';

/**
 * The charge port a car draws at a two-port curb post (owner decision
 * 2026-11-12): its curb side port (`curbPortOf`) at the post end of its spot,
 * so the 5.79 m post cable reaches it. The car faces -x, so the left spot
 * puts its tail by the post (a rear right port) and the right spot its nose
 * (a front right port, or the nose port). A far end port would need 7.3 m
 * (measured, a sedan's nose port from the left spot). Derived, as the curb
 * side mirror.
 */
export function curbPairPortOf(port: CarPort, spot: CurbSpot): CarPort {
  const curb = curbPortOf(port);
  if (spot === 'left') return 'rear_right';
  return curb === 'rear_right' ? 'front_right' : curb;
}

/**
 * Where the car of `port` stands at the curb. At a two-port post (`spot`) the
 * car parks as near the post as its spot allows, 0.2 m in from the line
 * (`PARALLEL_CAR.endInsetM`): its nose by the post in the right spot, its
 * tail by the post in the left spot (it faces -x, never backed in). Derived.
 */
export function parallelPlace(
  profile: { width: number; length: number },
  port: CarPort,
  spot?: CurbSpot,
): ParallelPlace {
  const rear = port === 'rear_left' || port === 'rear_right';
  const front = -CURB_POST_IN_M + PARALLEL_CAR.endInsetM;
  const back = -CURB_POST_IN_M + STANDARD_DIMENSIONS.parallelSpotLengthM - PARALLEL_CAR.endInsetM;
  const noseX =
    spot === 'right'
      ? PARALLEL_CAR.endInsetM
      : spot === 'left'
        ? -PARALLEL_CAR.endInsetM - profile.length
        : rear
          ? front
          : Math.min(PARALLEL_CAR.noseByPostX, back - profile.length);
  const centerZ = CURB_FACE_Z + PARALLEL_CAR.curbGapM + profile.width / 2;
  // The car's own frame turned a quarter about y: its +z (nose to tail) along
  // +x, its left (-x) toward the street (+z).
  return { noseX, centerZ, toStation: (x, z) => [noseX + z, centerZ - x] as const };
}

/** The port in the station frame and the handle yaw (its face into the car). */
export function parallelPort(
  profile: CarProfile,
  port: CarPort,
  place: ParallelPlace,
): { at: { x: number; y: number; z: number }; yaw: number } {
  const l = carPortLocal(profile, port);
  const [x, z] = place.toStation(l.x, l.z);
  // A handle's face points along (sin yaw, cos yaw): into the car from the street
  // side (-z), from the curb side (+z), or from ahead of the nose (+x).
  const yaw = port === 'front_center' ? Math.PI / 2 : l.x < 0 ? Math.PI : 0;
  return { at: { x, y: l.y, z }, yaw };
}

/** The index of the first point at least `m` metres along `pts` (plan distance) from its start, or from its end. */
function indexAlong(pts: readonly Vec3[], m: number, fromEnd: boolean): number {
  let len = 0;
  const n = pts.length;
  for (let k = 1; k < n; k += 1) {
    const a = pts[fromEnd ? n - k : k - 1];
    const b = pts[fromEnd ? n - 1 - k : k];
    if (a == null || b == null) continue;
    len += Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len >= m) return fromEnd ? n - 1 - k : k;
  }
  return fromEnd ? 0 : n - 1;
}

function line(a: Vec3, b: Vec3, n: number): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as const;
  });
}

/**
 * The route from the post's cable anchor (`from`, its last point the anchor
 * where the cable leaves the post) to the handle in the port, only over the
 * sidewalk and the curb top (owner rule 2026-11-02: never on the street side
 * of the car):
 * - a curb side port: from the post to the curb top under the port, up into
 *   the handle across the gap;
 * - the nose port: along the curb top to ahead of the nose, onto the paving
 *   ahead of it, into the handle.
 * The cable hangs from its gland and up to the handle as a cable does (a
 * catenary to where it touches down, up to 0.9 m out, and from where it
 * leaves the ground, up to 0.5 m before the port), never straight down.
 */
export function curbChargingRoute(o: {
  from: readonly Vec3[];
  plug: { lead: Vec3; end: Vec3 };
  port: CarPort;
  place: ParallelPlace;
  surface: SurfaceAt;
  cableDiameterM: number;
}): Vec3[] {
  const r = o.cableDiameterM / 2;
  const start = o.from[o.from.length - 1] ?? [0, 1, 0];
  const into = onBootAxis(o.plug.lead, o.plug.end, 0.06);
  const curbTopZ = (CURB_POST_BACK_M + CURB_FACE_Z) / 2;
  const path: Array<readonly [number, number]> =
    o.port === 'front_center'
      ? [
          [start[0], start[2] + 0.05],
          [into[0], curbTopZ],
          [into[0], into[2]],
        ]
      : [
          [start[0], start[2] + 0.05],
          [into[0], curbTopZ],
        ];
  const ground = groundRun(path, o.surface, r);
  const total = ground.length;
  // Where the cable touches down after hanging from the gland, and where it leaves
  // the ground to rise into the handle (the nose port's run ends on the paving).
  // The span stays on the first leg of the path, over ground no higher than its touchdown.
  const firstLeg = path[1] ?? path[0];
  const legEnd = Math.ceil(
    Math.hypot(
      (firstLeg?.[0] ?? 0) - (path[0]?.[0] ?? 0),
      (firstLeg?.[1] ?? 0) - (path[0]?.[1] ?? 0),
    ) / 0.1,
  );
  let down = Math.min(indexAlong(ground, 0.9, false), legEnd);
  const higher = (k: number): boolean =>
    ground.slice(0, k).some((p) => p[1] > (ground[k]?.[1] ?? 0) + 1e-9);
  while (down > 0 && higher(down)) down -= 1;
  const up = o.port === 'front_center' ? total - 1 : Math.max(down, indexAlong(ground, 0.5, true));
  const touch = ground[down] ?? start;
  const lift = ground[up] ?? touch;
  const hang = catenaryPoints(start, touch, touch[1], 10);
  const rise =
    o.port === 'front_center'
      ? line(lift, into, 4)
      : catenaryPoints(lift, into, lift[1], 10).slice(1);
  return [
    ...o.from.slice(0, -1),
    ...hang,
    ...ground.slice(down + 1, up + 1),
    ...rise,
    o.plug.lead,
    o.plug.end,
  ];
}
