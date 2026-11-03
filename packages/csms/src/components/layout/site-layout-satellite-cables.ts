// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The holstered cables of a DC split system satellite, without three.js. Each
// cable leaves its gland (the front holster's low on the side wall, a second
// holster's on the back face), loops over the cable hanger peg of its side
// wall and rises into the boot of its handle in the holster. One peg per side carries every cable of that side, side by side
// along the peg, the turns hanging parallel to the wall, so a second holster
// on one side gets its own place on the same peg. Frame: the satellite's
// own, origin at its footprint center on the ground, the front +z.

import { COIL_GROUND_CLEARANCE_M, DC_CABLE_M, routeLength } from './site-layout-charger-cables';
import { coilBottomRadius, coilCable, type CoilPlace } from './site-layout-cable-coil';
import { SURFACE_M, type SurfaceAt } from './site-layout-cable-surface';
import {
  CONNECTOR_SPECS,
  handleCableEntry,
  holsterPose,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import { cableHangerSpec, type CableHangerSpec } from './site-layout-model-cable-hanger';
import type { Vec3 } from './site-layout-model-kit';
import { SPLIT_SATELLITE } from './site-layout-model-split-satellite';

/** The side wall of the satellite, its x from the center line. */
export const SATELLITE_SIDE_X = SPLIT_SATELLITE.widthM / 2;

/**
 * The hanger peg of a side wall. Saddle top 1.0 m: under the handles (their
 * lowest point, the boot, stands at 0.94 m and more) and inside the 0.38 to
 * 1.22 m reach range of the 2010 ADA Standards 308.2 and 308.3. Its plate
 * stands 0.06 m behind the wall's middle, clear of the holster rail in front
 * of it. Turns a cable may take on the peg: up to 2. Derived.
 */
export const SATELLITE_HANGER = { topM: 1.0, zM: -0.06, turnsPerCable: 2 } as const;

/** The front gland's height on the side wall: low, so its cable rises to the saddle. */
const GLAND_Y_M = 0.45;

/**
 * A holster on the side wall `side` (-1 left, 1 right): 15 mm out of the wall
 * at the holster height; a second holster on one side stands as far back as
 * the 0.3 m deep wall allows.
 */
export function satelliteHolster(side: -1 | 1, backM: number): Vec3 {
  return [
    side * (SATELLITE_SIDE_X + 0.015),
    SPLIT_SATELLITE.holsterYM,
    SPLIT_SATELLITE.rail.zM - Math.min(backM, 0.12),
  ];
}

/**
 * The gland of the cable in place `slot` of its side. The front holster's
 * cable (slot 0): low on the side wall 0.03 m behind the front edge (0.45 m),
 * in front of the peg plate and under the holster rail. The cable of a second holster on that side (slot 1): on the back face
 * 0.09 m out from the center line, over the logo area and under the cap
 * (1.33 m), so its run comes down behind the satellite, clear of the front
 * cable's runs. Both come up the front of the peg. The layout was found by a
 * search over peg depth and height and gland places for the one where every
 * cable of every connector type keeps its clearances (the tests). Derived.
 */
export function satelliteGland(side: -1 | 1, slot: number): { at: Vec3; axis: Vec3 } {
  return slot === 0
    ? { at: [side * SATELLITE_SIDE_X, GLAND_Y_M, 0.12], axis: [side, 0, 0] }
    : { at: [side * 0.09, 1.33, -SPLIT_SATELLITE.depthM / 2], axis: [0, 0, -1] };
}

/** Where the handle of a satellite holster's cable enters its boot. */
export function satelliteHolsterEntry(
  side: -1 | 1,
  backM: number,
  kind: ConnectorKind,
): { lead: Vec3; end: Vec3 } {
  const [x, y, z] = satelliteHolster(side, backM);
  const pose = holsterPose({ x, y, z }, { x: side, z: 0 });
  const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
  return { lead: entry.lead, end: entry.end };
}

const diameter = (kind: ConnectorKind): number => CONNECTOR_SPECS[kind].cableDiameterM;

/**
 * The peg of a side carrying `kinds` (its cables, front holster first): a
 * saddle six diameters of the thickest cable in radius, as wide as every
 * cable's turns side by side.
 */
export function satelliteHangerSpec(kinds: readonly ConnectorKind[]): CableHangerSpec {
  const thickest = Math.max(...kinds.map(diameter));
  const base = cableHangerSpec(thickest, 0, 'out');
  const turns = kinds.reduce((w, k) => w + SATELLITE_HANGER.turnsPerCable * diameter(k) * 1.15, 0);
  return { ...base, widthM: turns + 0.04 };
}

/**
 * Where cable `slot` of a side loops: on its own stretch of the peg, each
 * turn further out along the peg.
 */
export function satelliteCoilPlace(
  side: -1 | 1,
  kinds: readonly ConnectorKind[],
  slot: number,
): CoilPlace & { mount: Vec3 } {
  const spec = satelliteHangerSpec(kinds);
  const thickest = Math.max(...kinds.map(diameter));
  const kind = kinds[slot] ?? kinds[0] ?? 'ccs1';
  const d = diameter(kind);
  const cy = SATELLITE_HANGER.topM - (spec.radiusM + 0.013 + thickest / 2);
  // The back holster's cable nearest the wall, the front one outside it: each
  // cable's last turn then leaves for its handle away from the other's turns.
  const before = kinds
    .slice(slot + 1)
    .reduce((w, k) => w + SATELLITE_HANGER.turnsPerCable * diameter(k) * 1.15, 0);
  return {
    center: [
      side * (SATELLITE_SIDE_X + spec.standoffM + 0.02 + before + d / 2),
      cy,
      SATELLITE_HANGER.zM,
    ],
    // Every cable comes up the front of the saddle and over to the back.
    u: [0, 0, -1],
    axis: [side, 0, 0],
    r1: spec.radiusM + 0.013 + d / 2,
    mount: [side * SATELLITE_SIDE_X, cy, SATELLITE_HANGER.zM],
  };
}

/** The ground under a satellite: its base plate, else the paving. */
export function satelliteSurface(x: number, z: number): number {
  const half = SPLIT_SATELLITE.basePlate.sizeM / 2;
  return Math.abs(x) <= half && Math.abs(z) <= half
    ? SPLIT_SATELLITE.basePlate.thickM
    : SURFACE_M.paving;
}

/**
 * The route of the cable in place `slot` of its side, `DC_CABLE_M` long (the
 * DC dispenser class median), to the holster `backM` behind the front one:
 * out of its gland (bent down at six cable diameters), up the front of the
 * peg and over it in whole hanging turns clear of the ground by 0.1 m, then
 * up into the handle's boot along the boot axis.
 */
export function satelliteHolsterCable(
  side: -1 | 1,
  kinds: readonly ConnectorKind[],
  slot: number,
  backM: number,
  surface: SurfaceAt = satelliteSurface,
): Vec3[] {
  const kind = kinds[slot] ?? kinds[0] ?? 'ccs1';
  const d = diameter(kind);
  const gland = satelliteGland(side, slot);
  const out = cableOutOfGland(gland.at, gland.axis, d, [0, -1, 0]);
  const place = satelliteCoilPlace(side, kinds, slot);
  const under = surface(place.center[0], place.center[2]);
  const floorY = under + d / 2 + COIL_GROUND_CLEARANCE_M;
  const route = (bottomRadiusM: number): Vec3[] =>
    coilCable({
      entry: out,
      place,
      cableDiameterM: d,
      handle: satelliteHolsterEntry(side, backM, kind),
      floorY,
      lengthM: DC_CABLE_M,
      preferTurns: [1, 2],
      bottomRadiusM,
    }).points;
  // A cable whose length falls between one and two whole turns hangs its
  // turn open wider at the bottom (up to the saddle's radius), so it keeps
  // its full length on the peg instead of a shorter loop.
  const fits = (points: Vec3[]): boolean => Math.abs(routeLength(points) - DC_CABLE_M) < 0.02;
  const first = route(coilBottomRadius(d));
  if (fits(first)) return first;
  for (let r2 = coilBottomRadius(d) + 0.01; r2 <= place.r1; r2 += 0.01) {
    const wider = route(r2);
    if (fits(wider)) return wider;
  }
  return first;
}
