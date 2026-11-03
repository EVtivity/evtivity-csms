// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The rear swing doors of the 3D layout 53 ft dry van trailer: two leaves
// with their shut lines, four hinges on each outer edge, two lock bars a
// leaf with their handles and cam keepers, the rear header and the sill.
// Built in the vehicle frame (nose at z = 0, body along +z): the door face
// is at z = `rearZ`, facing +z.

import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, cylG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Dry van rear doors (Great Dane and Wabash 53 ft dry van spec sheets: two
 * swing doors, four hinges a door, two lock rods a door with cam locks top
 * and bottom). Derived: the lock rods at 0.35 m and 0.95 m from the middle
 * (the old kit's places, a quarter and three quarters of a 1.3 m leaf), the
 * handles 1.0 m above the floor (standing reach), hinges evenly spaced over
 * the leaf height less 0.3 m at each end, the header 0.15 m deep.
 */
export const TRAILER_REAR_DOORS = {
  rodXs: [0.35, 0.95],
  rodRadiusM: 0.02,
  handleAboveFloorM: 1.0,
  hinges: 4,
  hingeInsetM: 0.3,
  headerM: 0.15,
} as const;

export interface TrailerRearDoorsInput {
  width: number;
  floor: number;
  height: number;
  rearZ: number;
}

export function createTrailerRearDoorsKit(input: TrailerRearDoorsInput): ModelKit<Slot> {
  const t = TRAILER_REAR_DOORS;
  const parts = new ModelParts<Slot>();
  const z = input.rearZ;
  const doorH = input.height - input.floor - t.headerM;
  const midY = input.floor + doorH / 2;
  const half = input.width / 2;
  // The header above the doors and the sill under them.
  parts.add('trim', boxG(input.width, t.headerM, 0.04), {
    at: [0, input.height - t.headerM / 2, z + 0.01],
  });
  parts.add('trim', boxG(input.width, 0.1, 0.05), { at: [0, input.floor + 0.05, z + 0.01] });
  // Shut line between the leaves.
  parts.add('trim', boxG(0.02, doorH, 0.02), { at: [0, midY, z + 0.015] });
  for (const side of [-1, 1]) {
    for (const rx of t.rodXs) {
      const x = side * rx;
      parts.add('rim', cylG(t.rodRadiusM, t.rodRadiusM, doorH - 0.15, 6), {
        at: [x, midY, z + 0.03],
      });
      // Cam keepers at both ends, rod guides between.
      for (const y of [input.floor + 0.14, input.height - t.headerM - 0.04]) {
        parts.add('trim', boxG(0.09, 0.07, 0.05), { at: [x, y, z + 0.025] });
      }
      for (const y of [midY - doorH * 0.25, midY + doorH * 0.25]) {
        parts.add('trim', boxG(0.07, 0.04, 0.04), { at: [x, y, z + 0.025] });
      }
      // The handle: a lever off the rod toward the middle.
      const hy = input.floor + t.handleAboveFloorM;
      parts.add('rim', boxG(0.32, 0.035, 0.03), { at: [x - side * 0.16, hy, z + 0.06] });
      parts.add('trim', boxG(0.06, 0.08, 0.035), { at: [x - side * 0.3, hy, z + 0.035] });
    }
    // Hinges on the outer edge.
    const span = doorH - 2 * t.hingeInsetM;
    for (let i = 0; i < t.hinges; i += 1) {
      const y = input.floor + t.hingeInsetM + (span * i) / (t.hinges - 1);
      parts.add('rim', boxG(0.22, 0.06, 0.02), { at: [side * (half - 0.16), y, z + 0.02] });
      parts.add('rim', cylG(0.018, 0.018, 0.08, 6), { at: [side * (half - 0.04), y, z + 0.025] });
    }
  }
  return parts.kit();
}
