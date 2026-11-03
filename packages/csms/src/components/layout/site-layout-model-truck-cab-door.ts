// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cab doors of the 3D layout trucks (box truck and semi tractor), both
// sides: the door shut lines cut in the cab, the pull handle in its pocket,
// the entry steps under the door and the two grab handles of the
// three-point entry, one ahead of the door and one behind it. Built in the
// vehicle frame (nose at z = 0, body along +z, left side at -x).

import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, cylG, roundBoxG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Truck access steps and handholds: 49 CFR 399.207 (the first step at most
 * 24 in (610 mm) above the ground, steps and handholds for three points of
 * contact). Derived: grab bars 38 mm thick (a power grip) on 50 mm standoffs
 * (hand clearance); the rear bar 0.7 m long starting 0.6 m above the lowest
 * step (reachable from it), the front bar 0.9 m along the A pillar from just
 * under the window line; the handle 200 by 40 mm, 0.35 m under the window.
 */
export const TRUCK_CAB_DOOR = {
  gapM: 0.01,
  gripRadiusM: 0.019,
  gripStandoffM: 0.05,
  rearGripLengthM: 0.7,
  frontGripLengthM: 0.9,
  firstStepMaxM: 0.61,
  stepDepthM: 0.24,
  handle: { lengthM: 0.2, heightM: 0.04, belowWindowM: 0.35 },
} as const;

export interface TruckCabDoorInput {
  /** The cab side, half its width. */
  halfWidth: number;
  /** The door edges along the vehicle. */
  front: number;
  rear: number;
  /** The door bottom and top edges and the window bottom. */
  bottom: number;
  top: number;
  windowBottom: number;
  /** Step heights above the ground, the lowest first (each at most 0.61 m and 18 in apart). */
  steps: readonly number[];
}

/** A vertical grab bar on two standoffs, its middle at (x, y, z), outboard toward `side`. */
function grab(
  parts: ModelParts<Slot>,
  side: number,
  x: number,
  y: number,
  z: number,
  length: number,
) {
  const d = TRUCK_CAB_DOOR;
  const out = x + side * d.gripStandoffM;
  parts.add('rim', cylG(d.gripRadiusM, d.gripRadiusM, length, 8), { at: [out, y, z] });
  for (const e of [-1, 1]) {
    parts.add('rim', boxG(d.gripStandoffM, 0.025, 0.025), {
      at: [x + (side * d.gripStandoffM) / 2, y + (e * (length - 0.06)) / 2, z],
    });
  }
}

export function createTruckCabDoorKit(input: TruckCabDoorInput): ModelKit<Slot> {
  const d = TRUCK_CAB_DOOR;
  const parts = new ModelParts<Slot>();
  const length = input.rear - input.front;
  const zMid = (input.front + input.rear) / 2;
  const h = input.top - input.bottom;
  for (const side of [-1, 1]) {
    const x = side * (input.halfWidth + 0.001);
    // Shut lines: both edges and the bottom; the top runs in the roof drip rail.
    for (const z of [input.front, input.rear]) {
      parts.add('trim', boxG(0.006, h, d.gapM), { at: [x, (input.bottom + input.top) / 2, z] });
    }
    parts.add('trim', boxG(0.006, d.gapM, length), { at: [x, input.bottom, zMid] });
    parts.add('trim', boxG(0.008, 0.02, length - 0.04), { at: [x, input.top, zMid] });
    // The pull handle near the rear edge, in its pocket.
    const hy = input.windowBottom - d.handle.belowWindowM;
    const hz = input.rear - 0.18;
    parts.add('trim', roundBoxG(0.006, 0.07, 0.24, 0.015), { at: [x + side * 0.002, hy, hz] });
    parts.add('rim', roundBoxG(0.03, d.handle.heightM, d.handle.lengthM, 0.015), {
      at: [x + side * 0.012, hy, hz],
    });
    // Entry steps under the door: a tread on a hanger at each step height.
    for (const y of input.steps) {
      parts.add('trim', boxG(d.stepDepthM, 0.035, length * 0.7), {
        at: [side * (input.halfWidth - d.stepDepthM / 2 + 0.06), y, zMid],
      });
      parts.add('rim', boxG(d.stepDepthM - 0.03, 0.006, length * 0.7 - 0.04), {
        at: [side * (input.halfWidth - d.stepDepthM / 2 + 0.06), y + 0.02, zMid],
      });
      for (const e of [-1, 1]) {
        parts.add('trim', boxG(0.03, input.bottom - y + 0.05, 0.04), {
          at: [side * (input.halfWidth - 0.02), (input.bottom + y) / 2, zMid + e * length * 0.3],
        });
      }
    }
    const lowest = input.steps[0] ?? input.bottom;
    grab(
      parts,
      side,
      x,
      lowest + 0.6 + d.rearGripLengthM / 2,
      input.rear + 0.06,
      d.rearGripLengthM,
    );
    grab(parts, side, x, input.windowBottom + 0.1, input.front - 0.06, d.frontGripLengthM);
  }
  return parts.kit();
}
