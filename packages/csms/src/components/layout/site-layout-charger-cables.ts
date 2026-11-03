// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The routes of the holstered charger cables of the 3D site layout, without
// three.js: each cable leaves its body through its gland (`cableOutOfGland`),
// hangs in one free loop (a catenary) and rises into the boot of its handle
// in the holster. Pure, so tests check every route against the bodies,
// vents, ground and the other cables.

import {
  CONNECTOR_SPECS,
  handleCableEntry,
  holsterPose,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import {
  DC_HOLSTER as DC_HOLSTER_MOUNT,
  DC_SIDE_X,
  dcGland,
  dcHangerZ,
} from './site-layout-model-dc-dispenser';
import {
  cableHangerSaddleCenter,
  cableHangerSpec,
  type CableHangerSpec,
} from './site-layout-model-cable-hanger';
import { coilCable, type CoilPlace } from './site-layout-cable-coil';
import type { Vec3 } from './site-layout-model-kit';
import { AC_PEDESTAL, acGland } from './site-layout-model-ac-pedestal';
import { SURFACE_M, type SurfaceAt } from './site-layout-cable-surface';

/** How far over the ground an idle loop's bottom hangs (cable center above the surface). */
export const COIL_GROUND_CLEARANCE_M = 0.1;

/**
 * A hanging cable between two points as a catenary: in the vertical plane
 * through p1 and p2, with D their horizontal distance and h1, h2 their
 * heights above the lowest point y0, the curve is y = y0 + a (cosh((s - s0) / a) - 1).
 * It passes p1 at s = 0 and p2 at s = D when
 * a acosh(1 + h1 / a) + a acosh(1 + h2 / a) = D, which grows with a, so a
 * bisection finds the one a; s0 = a acosh(1 + h1 / a). The cable length
 * follows as a sinh(s0 / a) + a sinh((D - s0) / a): the sag (y0) is chosen
 * and the length derived, the same curve as a cable of that length hanging
 * from the two points. `n` points from p1 to p2 inclusive.
 */
export function catenaryPoints(p1: Vec3, p2: Vec3, lowestY: number, n = 16): Vec3[] {
  const dx = p2[0] - p1[0];
  const dz = p2[2] - p1[2];
  const D = Math.max(1e-4, Math.hypot(dx, dz));
  const h1 = Math.max(0, p1[1] - lowestY);
  const h2 = Math.max(0, p2[1] - lowestY);
  const span = (a: number): number => a * Math.acosh(1 + h1 / a) + a * Math.acosh(1 + h2 / a);
  let lo = 1e-5;
  let hi = 1e3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (span(mid) > D) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  const s0 = a * Math.acosh(1 + h1 / a);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const s = t * D;
    return [p1[0] + dx * t, lowestY + a * (Math.cosh((s - s0) / a) - 1), p1[2] + dz * t] as const;
  });
}

/** The length of a polyline route. */
export function routeLength(points: readonly Vec3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/** The holster on a DC dispenser side wall: its mount and its cup facing out of the wall. */
export const DC_HOLSTER = { x: DC_SIDE_X + 0.015, ...DC_HOLSTER_MOUNT } as const;

/** Where the handle of a DC holster's cable enters (its boot), from the holster pose. */
export function dcHolsterEntry(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
): { lead: Vec3; end: Vec3 } {
  const pose = holsterPose(
    { x: side * DC_HOLSTER.x, y: DC_HOLSTER.y, z: DC_HOLSTER.z - backM },
    {
      x: side,
      z: 0,
    },
  );
  const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
  return { lead: entry.lead, end: entry.end };
}

/**
 * The charging cable of a DC dispenser: 3.6 m, the median standard CCS cable
 * of seven all-in-one DC fast chargers (ABB Terra 184 UL 6 m, Tritium PKM150
 * 3.6 m, alpitronic HYC300 3.5 m, alpitronic HYC400 3.5 m, BTC Power Gen 4
 * 180 kW 5.49 m, Wallbox Supernova 180 5 m, Delta UFC 200 3.2 m; manufacturer
 * product guides and data sheets, research 2026-11-02; the Tritium, alpitronic
 * HYC300 and ABB values confirmed by a later review, the Delta one
 * unverified). Sorted 3.2, 3.5, 3.5, 3.6, 5, 5.49, 6: the median 3.6 m. Derived.
 */
export const DC_CABLE_M = 3.6;

/** The saddle top of a DC dispenser's cable hangers: 1.2 m, inside the ADA 308 reach (1.22 m), so a driver lifts the loop off. */
export const DC_HANGER_TOP_M = 1.2;

/** The hanger of a DC holster's cable: a bar along the side wall, the loop at right angles to the wall. */
export function dcHangerSpec(kind: ConnectorKind): CableHangerSpec {
  return cableHangerSpec(CONNECTOR_SPECS[kind].cableDiameterM, 2, 'along');
}

/** Where a DC holster's loop hangs: its hanger on the side wall at `dcHangerZ`. */
export function dcCoilPlace(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
): CoilPlace & {
  /** The hanger group's position (its mounting face on the side wall). */
  mount: Vec3;
} {
  const d = CONNECTOR_SPECS[kind].cableDiameterM;
  const spec = dcHangerSpec(kind);
  const r1 = spec.radiusM + 0.013 + d / 2;
  const cy = DC_HANGER_TOP_M - r1;
  const c = cableHangerSaddleCenter(spec);
  const z = dcHangerZ(backM);
  // Turns stack along the bar away from the holster.
  const dir = backM > 0 ? -1 : 1;
  return {
    center: [side * (DC_SIDE_X + c[2]), cy, z - dir * (spec.widthM / 2 - 0.02 - d / 2)],
    u: [side, 0, 0],
    axis: [0, 0, dir],
    r1,
    mount: [side * DC_SIDE_X, cy, z],
  };
}

/**
 * The route of a holstered DC cable, `DC_CABLE_M` long: out of its gland on
 * the side wall (along the axis, then bent down at 6 cable diameters), up
 * over its hanger in whole hanging turns (`coilCable`, the loop clear of the
 * pad by 0.1 m), then off the bottom of the last turn up into the handle's
 * boot straight along the boot axis. The front holster's hanger is in front
 * of it, a holster behind it has its hanger behind it, so the two loops of
 * one side never meet. No cable crosses a vent (the inlet grille is on the
 * front, the outlet high on the sides).
 */
export function dcHolsterCable(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
  surface: SurfaceAt = (x, z) =>
    Math.abs(x) <= 0.8 && Math.abs(z) <= 0.6 ? 0.08 : SURFACE_M.paving,
): Vec3[] {
  const d = CONNECTOR_SPECS[kind].cableDiameterM;
  const gland = dcGland(side, backM);
  const out = cableOutOfGland(gland.at, gland.axis, d, [0, -1, 0]);
  const entry = dcHolsterEntry(side, backM, kind);
  const place = dcCoilPlace(side, backM, kind);
  const under = surface(place.center[0], place.center[2]);
  return coilCable({
    entry: out,
    place,
    cableDiameterM: d,
    handle: entry,
    floorY: under + d / 2 + COIL_GROUND_CLEARANCE_M,
    lengthM: DC_CABLE_M,
    preferTurns: [2, 1, 3],
  }).points;
}

/**
 * The charging cable of an AC pedestal and a curb post: the median standard
 * cable of twelve commercial AC pedestals and posts, 19 ft (5.79 m):
 * ChargePoint CT4000 18 ft, ChargePoint CPF50 18 ft, Blink IQ 200 23 ft,
 * EVBox BusinessLine (NA) 18 ft, SemaConnect / Blink Series 6 18 ft, Enel X
 * JuicePedestal 20 ft, Enphase IQ EV Charger 2 25 ft, Siemens VersiCharge
 * commercial 20 ft, ABB Terra AC 16.4 ft, Wallbox Commander 2 16.4 ft, FLO
 * CoRe+ 25 ft, FLO SmartTWO-BSR curbside post 22 ft (manufacturer spec
 * sheets, research 2026-11-02). Sorted, the middle two are 18 and 20 ft. Derived.
 */
export const AC_CABLE_M = 5.79;

/** An AC pedestal holster on the head side: 15 mm out from the head, at the cited holster height. */
export const AC_HOLSTER = {
  x: AC_PEDESTAL.head.widthM / 2 + 0.015,
  y: AC_PEDESTAL.holsterY,
} as const;

/** Where an AC pedestal cable enters the boot of its holstered handle on `side`. */
export function acHolsterEntry(side: -1 | 1, kind: ConnectorKind): { lead: Vec3; end: Vec3 } {
  const pose = holsterPose({ x: side * AC_HOLSTER.x, y: AC_HOLSTER.y, z: 0 }, { x: side, z: 0 });
  const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
  return { lead: entry.lead, end: entry.end };
}

/** The saddle top of an AC pedestal's cable hangers: 30 mm under the head, so the turns clear it. */
export const AC_HANGER_TOP_M = AC_PEDESTAL.head.bottomM - 0.03;

/** The hanger of an AC pedestal cable: a peg out of the column side, the turns parallel to the side. */
export function acHangerSpec(cableDiameterM: number): CableHangerSpec {
  return cableHangerSpec(cableDiameterM, 4, 'out');
}

/** Where an AC pedestal cable loops: its hanger peg on the column side on `side`. */
export function acCoilPlace(
  side: -1 | 1,
  cableDiameterM: number,
): CoilPlace & {
  /** The hanger group's position (its mounting face on the column side). */
  mount: Vec3;
} {
  const d = cableDiameterM;
  const spec = acHangerSpec(d);
  const r1 = spec.radiusM + 0.013 + d / 2;
  const cy = AC_HANGER_TOP_M - r1;
  const face = AC_PEDESTAL.post.widthM / 2;
  return {
    // The first turn 20 mm out along the peg, the next ones further out.
    center: [side * (face + spec.standoffM + 0.02 + d / 2), cy, 0],
    // The cable comes up the front of the saddle and over to the back.
    u: [0, 0, -1],
    axis: [side, 0, 0],
    r1,
    mount: [side * face, cy, 0],
  };
}

/**
 * The run of an AC pedestal cable out of its gland under the head (at
 * `glandX`), along the gland axis, bent at 6 cable diameters toward the
 * hanger on `side`; in front of the column, so it never enters the body.
 */
export function acGlandRun(glandX: number, side: -1 | 1, cableDiameterM: number): Vec3[] {
  const g = acGland(glandX);
  return cableOutOfGland(g.at, g.axis, cableDiameterM, [side, 0, 0]);
}

/**
 * The first run of a plugged AC pedestal cable: out of its gland under the
 * head (at `glandX`), bent at 6 cable diameters toward the front, where the
 * car stands, so it leaves the head clear of the column.
 */
export function acGlandOut(glandX: number, cableDiameterM: number): Vec3[] {
  const g = acGland(glandX);
  return cableOutOfGland(g.at, g.axis, cableDiameterM, [0, 0, 1]);
}

/**
 * The route of a holstered AC pedestal cable, `AC_CABLE_M` long: out of its
 * gland, up the front of its hanger peg on the column side and over it in
 * whole hanging turns (`coilCable`, the turns' bottom 0.1 m over the pad,
 * each turn further out along the peg), then off the bottom of the last
 * (outermost) turn up into the handle's boot along its axis.
 */
export function acHolsterCable(
  glandX: number,
  side: -1 | 1,
  cableDiameterM: number,
  handle: { lead: Vec3; end: Vec3 },
  surface: SurfaceAt = (x, z) =>
    Math.abs(x) <= 0.5 && Math.abs(z) <= 0.45 ? 0.08 : SURFACE_M.paving,
): Vec3[] {
  const d = cableDiameterM;
  const place = acCoilPlace(side, d);
  const under = surface(place.center[0], place.center[2]);
  return coilCable({
    entry: acGlandRun(glandX, side, d),
    place,
    cableDiameterM: d,
    handle,
    floorY: under + d / 2 + COIL_GROUND_CLEARANCE_M,
    lengthM: AC_CABLE_M,
    preferTurns: [3, 2, 4],
  }).points;
}

/** The first run of a plugged DC cable: out of its holster's gland (the cable then runs to the car). */
export function dcGlandOut(side: -1 | 1, backM: number, kind: ConnectorKind): Vec3[] {
  const g = dcGland(side, backM);
  return cableOutOfGland(g.at, g.axis, CONNECTOR_SPECS[kind].cableDiameterM, [0, -1, 0]);
}
