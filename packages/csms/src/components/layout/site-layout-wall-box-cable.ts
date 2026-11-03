// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The tethered cable of an office or retail wall box (owner decisions
// 2026-11-02): one piece out of the gland under the box. Idle, it loops over
// the cable hanger beside the box in hanging turns and rises into the handle
// docked in the front middle of the box. Charging, it comes off the hanger
// (left empty) and spans to the car's port, the rest of its length resting
// on the sidewalk and the curb.
//
// Frame: the station's own frame of an office row station (+z into the spot,
// the facade at `wallZ`), x across, y up from the ground.

import { wallBoxGland } from './site-layout-model-wall-box';
import { cableOutOfGland } from './site-layout-model-cable-gland';
import { cableHangerSaddleCenter, cableHangerSpec } from './site-layout-model-cable-hanger';
import type { CableHangerSpec } from './site-layout-model-cable-hanger';
import type { Vec3 } from './site-layout-model-kit';
import { coilCable, type CoilCable, type CoilPlace } from './site-layout-cable-coil';
import { plugRoute, type PlugRoute } from './site-layout-cable-rest';
import { COIL_GROUND_CLEARANCE_M } from './site-layout-charger-cables';

export { COIL_GROUND_CLEARANCE_M };
import type { GroundRect, SurfaceAt } from './site-layout-cable-surface';

/**
 * The cable length, the median of nine tethered residential Level 2 wall
 * units (25 ft, 7.62 m; manufacturer pages, research 2026-11-03):
 * ChargePoint Home Flex 23 ft (chargepoint.com/drivers/home/resource); Tesla
 * Wall Connector Gen 3 24 ft (energylibrary.tesla.com Gen3 install guide);
 * Grizzl-E Classic 24 ft (user manual rev 3.5, specification table, model
 * GR1-14-24; the product page says 25 ft); Emporia 25 ft
 * (emporiaenergy.com/ev-chargers, shop product page; the Pro install guide
 * says 24 ft); Enel X JuiceBox 40 25 ft (data sheet 012022); Wallbox Pulsar
 * Plus NA 25 ft (data sheet); ABB Terra AC NA 25 ft (installation manual
 * 9AKK108466A5307); Autel MaxiCharger AC Wallbox 25 ft (product page);
 * Siemens VersiCharge AC 20 ft (data sheet). Sorted 20, 23, 24, 24, 25, 25,
 * 25, 25, 25: the median 25 ft; with Emporia at 24 ft it would be 24 ft
 * (7.32 m). The commercial CPF50 is left out. Derived.
 */
export const WALL_BOX_CABLE_M = 7.62;

/**
 * Where the wall box's cable hanger is (a peg, its loops hanging parallel to
 * the wall), derived: 0.36 m right of the box center (the box half width
 * 0.115 m, its plate margin 0.01 m, a turn's bottom half width 0.17 m and a
 * 0.065 m gap), its saddle top 1.2 m above grade, inside the 15 to 48 in
 * (0.38 to 1.22 m) reach range (2010 ADA Standards 308.2, 308.3) so a driver
 * lifts the loops off. Three turns of the 7.62 m cable hang about 0.6 m,
 * each open 0.34 m at its bottom (a hand-coiled loop of 12.5 mm cable), their
 * bottoms at least 0.1 m above the sidewalk. The connector docks in the
 * front middle of the box (`wallBoxDock`).
 */
export const WALL_BOX_HANGER = { x: 0.36, saddleTopY: 1.2, turns: 3, bottomRadiusM: 0.17 } as const;

/** The hanger of a cable of `cableDiameterM`. */
export function wallBoxHangerSpec(cableDiameterM: number): CableHangerSpec {
  return cableHangerSpec(cableDiameterM, WALL_BOX_HANGER.turns + 1, 'out');
}

/**
 * The radius the cable's center runs at over a hanger: the saddle, its 5 mm
 * half wall and 8 mm cushion, and half the cable.
 */
export function hangerCableRadius(spec: CableHangerSpec, cableDiameterM: number): number {
  return spec.radiusM + 0.013 + cableDiameterM / 2;
}

/** Where the wall box's coil hangs (the hanger group stands at x, cy, wallZ). */
export function wallBoxCoilPlace(
  wallZ: number,
  cableDiameterM: number,
): CoilPlace & { cy: number } {
  const spec = wallBoxHangerSpec(cableDiameterM);
  const r1 = hangerCableRadius(spec, cableDiameterM);
  const cy = WALL_BOX_HANGER.saddleTopY - r1;
  const c = cableHangerSaddleCenter(spec);
  // The turns stack out along the peg from its inner end (the plate side).
  const firstZ = wallZ + c[2] - spec.widthM / 2 + 0.02 + cableDiameterM / 2;
  return {
    center: [WALL_BOX_HANGER.x, cy, firstZ],
    u: [1, 0, 0],
    axis: [0, 0, 1],
    r1,
    cy,
  };
}

/** The cable's first run: out of the gland under the box, bent toward the hanger. */
export function wallBoxGlandRun(wallZ: number, boxBottomM: number, cableDiameterM: number): Vec3[] {
  const gl = wallBoxGland(boxBottomM);
  return cableOutOfGland(
    [gl.at[0], gl.at[1], wallZ + gl.at[2]],
    gl.axis,
    cableDiameterM,
    [1, 0, 0],
  );
}

/** The idle cable: gland, the turns over the hanger, the handle in the front dock. */
export function wallBoxIdleCable(o: {
  wallZ: number;
  boxBottomM: number;
  cableDiameterM: number;
  dock: { lead: Vec3; end: Vec3 };
  sidewalkY: number;
  lengthM?: number;
}): CoilCable {
  return coilCable({
    entry: wallBoxGlandRun(o.wallZ, o.boxBottomM, o.cableDiameterM),
    place: wallBoxCoilPlace(o.wallZ, o.cableDiameterM),
    cableDiameterM: o.cableDiameterM,
    handle: o.dock,
    floorY: o.sidewalkY + o.cableDiameterM / 2 + COIL_GROUND_CLEARANCE_M,
    lengthM: o.lengthM ?? WALL_BOX_CABLE_M,
    preferTurns: [WALL_BOX_HANGER.turns, 4],
    bottomRadiusM: WALL_BOX_HANGER.bottomRadiusM,
  });
}

/** The charging cable: off the empty hanger, gland to the car's port (`plugRoute`), its 7.62 m kept. */
export function wallBoxChargingCable(o: {
  wallZ: number;
  boxBottomM: number;
  cableDiameterM: number;
  plug: { lead: Vec3; end: Vec3 };
  car: GroundRect;
  nosePort: boolean;
  surface: SurfaceAt;
  blocked?: (p: Vec3) => boolean;
  lengthM?: number;
}): PlugRoute {
  return plugRoute({
    from: wallBoxGlandRun(o.wallZ, o.boxBottomM, o.cableDiameterM),
    plug: o.plug,
    car: o.car,
    nosePort: o.nosePort,
    surface: o.surface,
    radiusM: o.cableDiameterM / 2,
    bendM: 6 * o.cableDiameterM,
    lengthM: o.lengthM ?? WALL_BOX_CABLE_M,
    ...(o.blocked != null ? { blocked: o.blocked } : {}),
  });
}
