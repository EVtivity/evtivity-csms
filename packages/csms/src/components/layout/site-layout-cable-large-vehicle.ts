// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Charging cable routes to the side inlet of a bus in a depot bay, in the
// station frame (the bus nose toward -z, its left side toward -x). Every
// route runs outside the bus body and above the ground. Pure: no three.js.

import { densify, onBootAxis } from './site-layout-cable-surface';
import { catenaryPoints } from './site-layout-charger-cables';
import type { Vec3 } from './site-layout-model-kit';

/**
 * How far outside the bus side the arm tip of a bus dispenser hangs its
 * cable: the 0.14 m mirror reach of the bus plus room for the 0.07 m spring
 * balancer and the cable swinging under it. Derived.
 */
export const BUS_ARM_SIDE_CLEARANCE_M = 0.35;

/** The x of a bus dispenser arm tip over a bay centered on `bayCenterX`, for a bus `busWidthM` wide. */
export function busArmTipX(bayCenterX: number, busWidthM: number): number {
  return bayCenterX - busWidthM / 2 - BUS_ARM_SIDE_CLEARANCE_M;
}

/** How far the cable runs out of the handle's boot along its axis before it bends (as the MCS arm cable). */
const BOOT_RUN_M = 0.06;

/** How far below the boot the cable dips before it rises into it (a J under the handle). Derived. */
const DIP_M = 0.08;

/**
 * The cable from a balancer outlet beside the bus down into the handle in
 * the bus's left side inlet: a catenary in the vertical plane through the
 * outlet and the point on the boot axis, dipping `DIP_M` below that point,
 * then straight into the boot.
 */
export function busSideDrape(outlet: Vec3, handle: { lead: Vec3; end: Vec3 }): Vec3[] {
  const into = onBootAxis(handle.lead, handle.end, BOOT_RUN_M);
  const hang = catenaryPoints(outlet, into, Math.min(outlet[1], into[1]) - DIP_M, 24);
  return [...hang, handle.lead, handle.end];
}

/**
 * The cable of a standard charger at the head of a bus bay to the bus's left
 * side inlet: down from the charger, on the ground ahead of the nose, out
 * past the left side (`sideX`) and along it to below the inlet, then up into
 * it from outside. `groundY` is the cable center resting on the paving.
 */
export function busGroundDrape(
  start: Vec3,
  inlet: Vec3,
  sideX: number,
  noseZ: number,
  groundY: number,
): Vec3[] {
  const outX = sideX - BUS_ARM_SIDE_CLEARANCE_M;
  const aheadZ = Math.min(start[2] + 0.35, noseZ - 0.3);
  // The ground run in short steps, so the smooth curve through it never dips into the paving.
  const ground = densify(
    [
      [start[0] - 0.3, groundY, aheadZ],
      [outX, groundY, aheadZ],
      [outX, groundY, inlet[2] - 0.3],
    ],
    0.25,
  );
  return [
    start,
    [start[0] - 0.1, 0.3, aheadZ],
    [start[0] - 0.2, groundY + 0.06, aheadZ],
    ...ground,
    [outX, groundY + 0.06, inlet[2] - 0.2],
    [outX + 0.05, inlet[1] - 0.2, inlet[2]],
    [inlet[0] - 0.15, inlet[1], inlet[2]],
    inlet,
  ];
}
