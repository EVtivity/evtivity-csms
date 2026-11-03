// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The rear of the 3D layout box truck's 24 ft box: the roll-up door's
// panel joints, its frame (two side jambs, the header), the sill, the lift
// handle and the latch at the bottom, a grab handle on each rear post and a
// pull strap. Built in the vehicle frame (nose at z = 0, body along +z): the
// door face is at z = `rearZ`, facing +z.

import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, cylG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Roll-up truck doors (Todco and Whiting door spec sheets: panels about
 * 300 mm high, a lift handle and a latch at the bottom center, a pull strap).
 * Derived: the jambs and header 0.1 m (the frame inside the 2.6 m box,
 * leaving the 2.4 m opening a 24 ft box gives), the grab handles 0.6 m long
 * from 0.4 m above the deck (reach from the dock or the rear step).
 */
export const BOX_REAR_DOOR = {
  panelM: 0.3,
  frameM: 0.1,
  gripLengthM: 0.6,
  gripRadiusM: 0.018,
} as const;

export interface BoxRearDoorInput {
  width: number;
  deck: number;
  height: number;
  rearZ: number;
}

export function createBoxRearDoorKit(input: BoxRearDoorInput): ModelKit<Slot> {
  const d = BOX_REAR_DOOR;
  const parts = new ModelParts<Slot>();
  const z = input.rearZ;
  const f = d.frameM;
  const openW = input.width - 2 * f;
  const top = input.height - f;
  // Panel joints of the door.
  for (let y = input.deck + d.panelM; y < top - 0.05; y += d.panelM) {
    parts.add('trim', boxG(openW, 0.025, 0.02), { at: [0, y, z + 0.012] });
  }
  // Frame: side jambs, header, the sill with its rub strip.
  for (const side of [-1, 1]) {
    parts.add('trim', boxG(f, input.height - input.deck, 0.05), {
      at: [side * (input.width / 2 - f / 2), (input.height + input.deck) / 2, z + 0.02],
    });
    // A grab handle on each rear post.
    const gy = input.deck + 0.4 + d.gripLengthM / 2;
    const gx = side * (input.width / 2 - f / 2);
    parts.add('rim', cylG(d.gripRadiusM, d.gripRadiusM, d.gripLengthM, 8), {
      at: [gx, gy, z + 0.1],
    });
    for (const e of [-1, 1]) {
      parts.add('rim', boxG(0.025, 0.025, 0.06), {
        at: [gx, gy + (e * (d.gripLengthM - 0.05)) / 2, z + 0.07],
      });
    }
  }
  parts.add('trim', boxG(input.width, f, 0.05), { at: [0, input.height - f / 2, z + 0.02] });
  parts.add('trim', boxG(input.width, 0.08, 0.08), { at: [0, input.deck, z + 0.03] });
  // Lift handle, latch and the pull strap at the bottom middle.
  parts.add('rim', boxG(0.3, 0.035, 0.04), { at: [0, input.deck + 0.15, z + 0.04] });
  parts.add('trim', boxG(0.12, 0.1, 0.04), { at: [0.3, input.deck + 0.13, z + 0.03] });
  parts.add('tire', boxG(0.04, 0.5, 0.008), { at: [-0.25, input.deck + 0.32, z + 0.03] });
  return parts.kit();
}
