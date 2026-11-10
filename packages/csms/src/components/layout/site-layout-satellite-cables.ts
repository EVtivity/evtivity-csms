// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The holstered cables of a DC split system satellite, without three.js. A
// satellite carries at most two cables, one on each side
// (`CHARGER_PORT_LIMITS.dc.satelliteConnectors`). Each cable leaves its gland
// low on its side wall, loops over the J hook of that wall, the turns hanging
// parallel to the wall, and rises into the boot of its handle in the
// holster. Frame: the satellite's own, origin at its footprint center on the
// ground, the front +z.

import { tightestBend } from './site-layout-cable-relax';
import {
  COIL_GROUND_CLEARANCE_M,
  DC_CABLE_M,
  hookCoilPlace,
  routeLength,
} from './site-layout-charger-cables';
import {
  cableSelfClearance,
  coilBottomRadius,
  SELF_CLEARANCE_MIN_RATIO,
  coilCable,
  type CoilPlace,
} from './site-layout-cable-coil';
import { SURFACE_M, type SurfaceAt } from './site-layout-cable-surface';
import {
  CONNECTOR_SPECS,
  handleCableEntry,
  holsterPose,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import {
  CABLE_HOOK,
  cableHookSpec,
  turnsWidth,
  type CableHookSpec,
} from './site-layout-model-cable-hook';
import type { Vec3 } from './site-layout-model-kit';
import { SPLIT_SATELLITE } from './site-layout-model-split-satellite';

/** The side wall of the satellite, its x from the center line. */
export const SATELLITE_SIDE_X = SPLIT_SATELLITE.widthM / 2;

/**
 * The J hook of a side wall. Rod top 1.0 m: under the handles (their
 * lowest point, the boot, stands at 0.94 m and more) and inside the 0.38 to
 * 1.22 m reach range of the 2010 ADA Standards 308.2 and 308.3. Its rose
 * stands 0.03 m behind the wall's middle, clear of the holster rail in front
 * of it. Turns a cable may take on the peg: up to 2. Derived: the hook depth,
 * with the front gland's place, by a search over hook depth and gland height
 * and depth for the layout where every connector's idle cable keeps its
 * length, bends no tighter than 1.9 diameters and never passes through
 * itself (owner decision 2026-11-10, layout review H1).
 */
export const SATELLITE_HANGER = { topM: 1.0, zM: -0.03, turnsPerCable: 2 } as const;

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
 * The gland of the cable of side `side`: low on the side wall in the wall's
 * middle (0.45 m up), under the holster rail and the hook, where the cable's
 * U from it stays beside its own turns (`SATELLITE_HANGER`). The cable comes
 * up the front of the peg. The layout was found by a search over peg depth
 * and height and gland places for the one where every cable of every
 * connector type keeps its clearances (the tests). Derived.
 */
export function satelliteGland(side: -1 | 1): { at: Vec3; axis: Vec3 } {
  return { at: [side * SATELLITE_SIDE_X, GLAND_Y_M, 0], axis: [side, 0, 0] };
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

/** Room on the hook's throat past the turns, so they never touch the hook's tip. Derived. */
const CABLE_GAP_M = 0.006;

/** The J hook of a side carrying a cable of `kind`: a throat for its turns. */
export function satelliteHookSpec(kind: ConnectorKind): CableHookSpec {
  return cableHookSpec(turnsWidth(SATELLITE_HANGER.turnsPerCable, diameter(kind)) + CABLE_GAP_M);
}

/** Where the cable of a side loops on its hook, each turn further out along the hook. */
export function satelliteCoilPlace(side: -1 | 1, kind: ConnectorKind): CoilPlace & { mount: Vec3 } {
  const mount: Vec3 = [
    side * SATELLITE_SIDE_X,
    SATELLITE_HANGER.topM - CABLE_HOOK.rodRadiusM,
    SATELLITE_HANGER.zM,
  ];
  const place = hookCoilPlace({
    mount,
    out: [side, 0, 0],
    // The cable comes over the hook from the front, its gland's side.
    across: [0, 0, -1],
    cableDiameterM: diameter(kind),
    cable: 'dc',
    offsetM: 0,
    // The inside of the turn 5.5 cable diameters and 13 mm, wider than the 5 D
    // minimum, to the cable's center half a diameter more. Derived.
    topRadiusM: 5.5 * diameter(kind) + 0.013 + diameter(kind) / 2,
  });
  return { ...place, mount };
}

/** The ground under a satellite: its base plate, else the paving. */
export function satelliteSurface(x: number, z: number): number {
  const half = SPLIT_SATELLITE.basePlate.sizeM / 2;
  return Math.abs(x) <= half && Math.abs(z) <= half
    ? SPLIT_SATELLITE.basePlate.thickM
    : SURFACE_M.paving;
}

/**
 * The route of the cable of side `side`, `DC_CABLE_M` long (the DC dispenser
 * class median), to the holster `backM` behind the front one:
 * out of its gland (bent down at six cable diameters), up the front of the
 * hook and over it in whole hanging turns clear of the ground by 0.1 m, then
 * up into the handle's boot along the boot axis.
 */
export function satelliteHolsterCable(
  side: -1 | 1,
  kind: ConnectorKind,
  backM: number,
  surface: SurfaceAt = satelliteSurface,
): Vec3[] {
  const d = diameter(kind);
  const gland = satelliteGland(side);
  const place = satelliteCoilPlace(side, kind);
  const under = surface(place.center[0], place.center[2]);
  const floorY = under + d / 2 + COIL_GROUND_CLEARANCE_M;
  const key = `${String(side)}|${kind}|${String(backM)}|${floorY.toFixed(4)}`;
  const known = SATELLITE_IDLE_ROUTES.get(key);
  if (known != null) return known;
  // The gland bends down, the cable hanging in a U up to its hook, when its
  // length allows that; a thicker cable, whose U takes more than its length,
  // bends up to the hook.
  const bends: Vec3[] = [
    [0, -1, 0],
    [0, 1, 0],
  ];
  const route = (bend: Vec3, bottomRadiusM: number, offAngleRad: number): Vec3[] =>
    coilCable({
      entry: cableOutOfGland(gland.at, gland.axis, d, bend),
      place,
      cableDiameterM: d,
      handle: satelliteHolsterEntry(side, backM, kind),
      floorY,
      lengthM: DC_CABLE_M,
      preferTurns: [1, 2],
      bottomRadiusM,
      entryHeading: bend,
      offAngleRad,
    }).points;
  // A cable whose length falls between one and two whole turns hangs its
  // turn open wider at the bottom (up to 0.3 m), so it keeps its full length
  // on the hook instead of a shorter loop.
  const fits = (points: Vec3[]): boolean => Math.abs(routeLength(points) - DC_CABLE_M) < 0.02;
  // Of the routes that take its length, the first that bends no tighter than
  // two diameters (a wider bottom on a short drop folds the legs) and never
  // passes through itself (`SELF_CLEARANCE_MIN_RATIO` on the drawn points, owner decision
  // 2026-11-10), else the one that comes closest.
  const widest = 0.3;
  const minBend = 2 * d;
  let best: { score: number; points: Vec3[] } | null = null;
  for (const bend of bends) {
    for (let r2 = 0.12; r2 <= widest + 1e-9; r2 += 0.01) {
      for (const phi of SATELLITE_OFF_ANGLES) {
        const points = route(bend, r2, phi);
        if (!fits(points)) continue;
        const score = Math.min(
          tightestBend(points, 4, points.length - 4) / minBend,
          cableSelfClearance(points, d) / (SELF_CLEARANCE_MIN_RATIO * d),
        );
        if (score >= 1) {
          SATELLITE_IDLE_ROUTES.set(key, points);
          return points;
        }
        if (best == null || score > best.score) best = { score, points };
      }
    }
  }
  const points = best?.points ?? route(bends[0] ?? [0, -1, 0], coilBottomRadius(d), 0);
  SATELLITE_IDLE_ROUTES.set(key, points);
  return points;
}

/** The idle satellite routes solved so far (the search is pure, its inputs few). */
const SATELLITE_IDLE_ROUTES = new Map<string, Vec3[]>();

/** Where the last turn may leave for the handle, before its entry side (radians, `coilCable`). */
const SATELLITE_OFF_ANGLES = [0, 0.4, 0.8] as const;
