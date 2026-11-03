// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A double passenger door of the 3D layout city bus: two glazed leaves in
// dark frames with a rubber seal where they meet, a rail across each leaf,
// the header and sill of the opening and the shut line cut in the body
// around it. Frame: centered on the door opening, its outer face at x = 0
// (the bus side), +x outward, the opening along z.

import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * A 1.2 m double door, 2.35 m of glazing (Mercedes eCitaro: door 1 and 2
 * clear width 1,200 mm, low floor entry at 320 mm). Derived: leaf frames
 * 60 mm (the old door frame width), the rail at 40 percent of the leaf height
 * (the push bar height of a 2.35 m leaf, about 0.95 m above the sill), the
 * body shut line 30 mm outside the frame.
 */
export const BUS_DOOR = {
  widthM: 1.2,
  heightM: 2.35,
  frameM: 0.06,
  railAt: 0.4,
  shutLineOffsetM: 0.03,
} as const;

export function createBusDoorKit(): ModelKit<Slot> {
  const d = BUS_DOOR;
  const parts = new ModelParts<Slot>();
  const hw = d.widthM / 2;
  const hh = d.heightM / 2;
  const f = d.frameM;
  for (const side of [-1, 1]) {
    const zc = (side * hw) / 2;
    parts.add('glass', boxG(0.015, d.heightM - 2 * f, hw - 1.5 * f), { at: [0.006, 0, zc] });
    // The leaf frame: top, bottom, outer stile, the rail.
    parts.add('trim', boxG(0.03, f, hw), { at: [0.015, hh - f / 2, zc] });
    parts.add('trim', boxG(0.03, f * 1.5, hw), { at: [0.015, -hh + f * 0.75, zc] });
    parts.add('trim', boxG(0.03, d.heightM, f), { at: [0.015, 0, side * (hw - f / 2)] });
    parts.add('trim', boxG(0.03, f * 0.6, hw - f), {
      at: [0.018, -hh + d.heightM * d.railAt, zc],
    });
  }
  // The rubber seal where the leaves meet, proud of the frames.
  parts.add('tire', boxG(0.04, d.heightM - 0.02, 0.03), { at: [0.02, 0, 0] });
  // Shut line around the opening, cut in the body.
  const o = d.shutLineOffsetM;
  parts.add('trim', boxG(0.006, 0.01, d.widthM + 2 * o), { at: [0.001, hh + o, 0] });
  for (const side of [-1, 1]) {
    parts.add('trim', boxG(0.006, d.heightM + o, 0.01), {
      at: [0.001, o / 2, side * (hw + o)],
    });
  }
  return parts.kit();
}
