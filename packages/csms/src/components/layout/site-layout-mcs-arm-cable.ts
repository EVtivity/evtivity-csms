// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where the MCS cable management arm points and how its cable runs, in a
// station frame (`site-layout-model-mcs-cable-arm.ts` draws the arm). The
// cable is one piece: out of the slewing head along the boom top, round the
// tip guide, down from the outlet into the handle, every bend at least six
// cable diameters. Pure: no three.js.

import { routeLength } from './site-layout-charger-cables';
import { onBootAxis } from './site-layout-cable-surface';
import {
  MCS_ARM,
  mcsArmBendM,
  mcsArmBoomCable,
  mcsArmOutlet,
} from './site-layout-model-mcs-cable-arm';
import type { Vec3 } from './site-layout-model-kit';

/** The pole of the arm of a dispenser standing at (`x`, `z`), on the island beside its -x side. */
export function mcsArmPole(dispenser: { x: number; z: number }): Vec3 {
  return [dispenser.x + MCS_ARM.poleFromDispenser.x, 0, dispenser.z + MCS_ARM.poleFromDispenser.z];
}

/** The boom yaw (from +x toward +z) that points it from the pole toward `target` in the plan. */
export function mcsArmYawToward(pole: Vec3, target: Vec3): number {
  return Math.atan2(target[2] - pole[2], target[0] - pole[0]);
}

/** How far the cable outlet stands from the pole axis: the boom and one bend radius past its tip. */
export function mcsArmReachM(cableDiameterM: number): number {
  return MCS_ARM.boomM + mcsArmBendM(cableDiameterM);
}

/**
 * The boom yaw while charging: toward the truck inlet, with the cable outlet
 * kept `maxTipZ` or nearer the island (outside the truck's side, over which
 * the cable would hang onto the trailer) and far enough back from the inlet
 * for the cable's last bend.
 */
export function mcsArmChargingYaw(
  pole: Vec3,
  inlet: Vec3,
  maxTipZ: number,
  cableDiameterM: number,
): number {
  const yaw = mcsArmYawToward(pole, inlet);
  const reach = mcsArmReachM(cableDiameterM);
  // The cable turns from straight down into the inlet in one bend of at
  // least its smallest radius, so the outlet stays that far, and the handle
  // length, back from the inlet.
  const limit = Math.min(maxTipZ, inlet[2] - mcsArmBendM(cableDiameterM) - 0.45);
  if (pole[2] + Math.sin(yaw) * reach <= limit) return yaw;
  const s = Math.max(-1, Math.min(1, (limit - pole[2]) / reach));
  const toward = inlet[0] >= pole[0] ? 1 : -1;
  return Math.atan2(s, toward * Math.sqrt(1 - s * s));
}

/** The cable outlet of a boom at `yaw` on `pole`, in the station frame. */
export function mcsArmOutletAt(pole: Vec3, yaw: number, cableDiameterM: number): Vec3 {
  const o = mcsArmOutlet(yaw, cableDiameterM);
  return [pole[0] + o[0], o[1], pole[2] + o[2]];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** A cubic Bezier from p0 to p3 with control points p1 and p2, `n` points. */
function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: number): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    const k0 = u * u * u;
    const k1 = 3 * u * u * t;
    const k2 = 3 * u * t * t;
    const k3 = t * t * t;
    return [
      k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0],
      k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1],
      k0 * p0[2] + k1 * p1[2] + k2 * p2[2] + k3 * p3[2],
    ] as const;
  });
}

/** Points every `step` meters along a polyline, its ends kept. */
function resample(points: readonly Vec3[], step: number): Vec3[] {
  const total = routeLength(points);
  const n = Math.max(1, Math.round(total / step));
  const out: Vec3[] = [];
  let seg = 1;
  let done = 0;
  for (let k = 0; k <= n; k += 1) {
    const want = (total * k) / n;
    while (seg < points.length - 1) {
      const a = points[seg - 1];
      const b = points[seg];
      if (a == null || b == null) break;
      const l = len(sub(b, a));
      if (done + l >= want) break;
      done += l;
      seg += 1;
    }
    const a = points[seg - 1];
    const b = points[seg];
    if (a == null || b == null) continue;
    const l = len(sub(b, a)) || 1;
    const t = Math.min(1, Math.max(0, (want - done) / l));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** The radius of the circle through three points (Infinity when they are in line). */
export function bendRadiusAt(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = len(sub(b, a));
  const bc = len(sub(c, b));
  const ca = len(sub(a, c));
  const u = sub(b, a);
  const v = sub(c, a);
  const cross = len([
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ]);
  return cross < 1e-12 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/** The tightest bend along a polyline (over consecutive point triples). */
export function minBendRadius(points: readonly Vec3[]): number {
  let r = Infinity;
  for (let i = 2; i < points.length; i += 1) {
    const a = points[i - 2];
    const b = points[i - 1];
    const c = points[i];
    if (a != null && b != null && c != null) r = Math.min(r, bendRadiusAt(a, b, c));
  }
  return r;
}

/**
 * The whole MCS cable of an arm on `pole` turned to `yaw`, from the slewing
 * head into a handle (holstered, or in the truck inlet): along the boom top,
 * round the tip guide, then from the outlet (leaving straight down) in one
 * smooth curve into the handle's boot along its axis. The spring balancer
 * takes up the slack, so the curve is the gentlest one between the two
 * ends: of the curves tried, the one whose tightest bend is largest, kept
 * above `floorY`.
 */
export function mcsArmCable(
  pole: Vec3,
  yaw: number,
  handle: { lead: Vec3; end: Vec3 },
  floorY: number,
  cableDiameterM: number,
): Vec3[] {
  const boom = mcsArmBoomCable(cableDiameterM).map(
    (p) => [pole[0] + Math.cos(yaw) * p[0], p[1], pole[2] + Math.sin(yaw) * p[0]] as const,
  );
  const out = boom[boom.length - 1] ?? mcsArmOutletAt(pole, yaw, cableDiameterM);
  const into = onBootAxis(handle.lead, handle.end, 0.06);
  const axis = sub(handle.end, handle.lead);
  const axisLen = len(axis) || 1;
  const dir: Vec3 = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
  const chord = len(sub(into, out));
  // Sideways (square to the plane of the outlet and the handle) the curve
  // may swing out, so a handle close under the outlet still gets a gentle loop.
  const flat: Vec3 = [into[0] - out[0], 0, into[2] - out[2]];
  const flatLen = len(flat);
  const side: Vec3 = flatLen > 1e-6 ? [-flat[2] / flatLen, 0, flat[0] / flatLen] : [1, 0, 0];
  let best: Vec3[] | null = null;
  let bestR = -1;
  for (let a = 0.2; a <= 3.01; a += 0.2) {
    for (let b = 0.2; b <= 3.01; b += 0.2) {
      for (let w = -1; w <= 1.001; w += 0.25) {
        const p1: Vec3 = [
          out[0] + side[0] * w * chord,
          out[1] - a * chord,
          out[2] + side[2] * w * chord,
        ];
        const p2: Vec3 = [
          into[0] - dir[0] * b * chord + side[0] * w * chord,
          into[1] - dir[1] * b * chord,
          into[2] - dir[2] * b * chord + side[2] * w * chord,
        ];
        const hang = resample(bezier(out, p1, p2, into, 96), 0.05);
        if (hang.some((p) => p[1] < floorY)) continue;
        const r = minBendRadius([...boom.slice(-2), ...hang.slice(1), handle.lead]);
        if (r > bestR) {
          bestR = r;
          best = [...boom, ...hang.slice(1), handle.lead, handle.end];
        }
      }
    }
  }
  return best ?? [...boom, into, handle.lead, handle.end];
}

/** The length of the cable hanging below the tip guide outlet (into the handle). */
export function mcsHangingLength(route: readonly Vec3[], cableDiameterM: number): number {
  const boomPoints = mcsArmBoomCable(cableDiameterM).length;
  return routeLength(route.slice(boomPoints - 1));
}

/**
 * The boom yaw while idle: toward the holstered handle, turned by the least
 * angle (in 5 degree steps, up to 90 degrees either way) that lets the cable
 * reach the handle in bends no tighter than its smallest radius and within
 * the cable's hanging length.
 */
export function mcsArmIdleYaw(
  pole: Vec3,
  handle: { lead: Vec3; end: Vec3 },
  floorY: number,
  cableDiameterM: number,
): number {
  const toward = mcsArmYawToward(pole, handle.lead);
  const bend = mcsArmBendM(cableDiameterM);
  let best = toward;
  let bestR = -1;
  for (let k = 0; k <= 18; k += 1) {
    for (const sign of k === 0 ? [1] : [1, -1]) {
      const yaw = toward + (sign * k * Math.PI) / 36;
      const route = mcsArmCable(pole, yaw, handle, floorY, cableDiameterM);
      const r = minBendRadius(route.slice(0, -1));
      const fits = mcsHangingLength(route, cableDiameterM) <= MCS_ARM.cableM + 0.01;
      if (fits && r >= bend - 1e-6) return yaw;
      if (fits && r > bestR) {
        bestR = r;
        best = yaw;
      }
    }
  }
  return best;
}
