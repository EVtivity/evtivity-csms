// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A glass storefront entrance: the frame with a transom above, one or two
// medium stile door leaves with their glass, a push bar across each leaf on
// standoff brackets, the threshold and the hinge side butts.
//
// Facade frame: see `site-layout-model-facade-parts.ts` (wall face z = 0,
// x from the entrance's left edge, y from the ground).

import { ModelParts, boxG, cylG, frontProfileG, polyTubeG } from './site-layout-model-kit';
import {
  STOREFRONT,
  addFramedGlazing,
  rectHole,
  rectPts,
  type FacadeKit,
  type FacadeSlot,
} from './site-layout-model-facade-parts';

/**
 * Typical of the class (for example the Kawneer 350 Medium Stile Entrance
 * and the YKK AP 35H entrance): leaves 1-3/4 in (44.5 mm) thick, 3-1/2
 * in (88.9 mm) vertical stiles and top rail, 6-1/2 in (165.1 mm) bottom rail;
 * a 3070 leaf, 3 ft by 7 ft (914 by 2134 mm), gives the 32 in clear width of
 * 2010 ADA Standards 404.2.3. The push bar runs at 38 in (965 mm), inside the
 * 34 to 48 in of 404.2.7 (operable parts, 308). Derived: the transom is the
 * frame face plus a 0.45 m lite over the leaves; the leaf sits 6 mm in front
 * of the frame face plane; the bar is a 32 mm tube 60 mm off the glass,
 * spanning the leaf less 100 mm a side; the threshold is the 1/2 in (13 mm)
 * maximum of 404.2.5, 0.1 m deep.
 */
export const FACADE_DOOR = {
  leaf: { widthM: 0.914, heightM: 2.134, thicknessM: 0.0445, stileM: 0.0889, bottomRailM: 0.1651 },
  transomM: 0.45,
  pushBar: { heightM: 0.965, radiusM: 0.016, standoffM: 0.06, insetM: 0.1 },
  threshold: { heightM: 0.013, depthM: 0.1 },
} as const;

/** The overall size of an entrance with `leaves` leaves. */
export function facadeDoorSize(leaves: 1 | 2): { widthM: number; heightM: number } {
  const d = FACADE_DOOR;
  const f = STOREFRONT.faceM;
  return { widthM: leaves * d.leaf.widthM + 2 * f, heightM: d.leaf.heightM + d.transomM + 2 * f };
}

/** A storefront entrance of one or two leaves (a pair meets at the center). */
export function createFacadeDoorKit(leaves: 1 | 2 = 2): FacadeKit {
  const d = FACADE_DOOR;
  const f = STOREFRONT.faceM;
  const p = new ModelParts<FacadeSlot>();
  const { widthM, heightM } = facadeDoorSize(leaves);
  const doorTop = d.leaf.heightM;
  // The frame: the jambs beside the leaves, then the transom frame and lite above (its bottom rail is the door head).
  for (const jx of [f / 2, widthM - f / 2]) {
    p.add('frame', boxG(f, doorTop, STOREFRONT.proudM), {
      at: [jx, doorTop / 2, STOREFRONT.proudM / 2],
    });
  }
  addFramedGlazing(p, { x0: 0, y0: doorTop, x1: widthM, y1: heightM }, leaves, []);
  // The leaves.
  const zLeaf = STOREFRONT.proudM - d.leaf.thicknessM / 2 + 0.006;
  for (let i = 0; i < leaves; i += 1) {
    const x0 = f + i * d.leaf.widthM;
    const x1 = x0 + d.leaf.widthM;
    const s = d.leaf.stileM;
    p.add(
      'frame',
      frontProfileG(
        rectPts(x0 + 0.002, d.threshold.heightM, x1 - 0.002, doorTop - 0.003),
        d.leaf.thicknessM,
        0.002,
        [rectHole(x0 + s, d.leaf.bottomRailM, x1 - s, doorTop - s)],
      ),
      { at: [0, 0, zLeaf] },
    );
    p.add(
      'glass',
      boxG(d.leaf.widthM - 2 * s + 0.02, doorTop - d.leaf.bottomRailM - s + 0.02, 0.006),
      {
        at: [(x0 + x1) / 2, (d.leaf.bottomRailM + doorTop - s) / 2, zLeaf],
      },
    );
    // The push bar on its two standoffs, on the outside face.
    const b = d.pushBar;
    const face = zLeaf + d.leaf.thicknessM / 2;
    const bx0 = x0 + b.insetM;
    const bx1 = x1 - b.insetM;
    p.add(
      'metal',
      polyTubeG(
        [
          [bx0, b.heightM, face],
          [bx0, b.heightM, face + b.standoffM],
          [bx1, b.heightM, face + b.standoffM],
          [bx1, b.heightM, face],
        ],
        b.radiusM,
        8,
      ),
    );
    for (const bx of [bx0, bx1]) {
      p.add('metal', cylG(0.03, 0.03, 0.006, 12), {
        at: [bx, b.heightM, face + 0.003],
        rot: [Math.PI / 2, 0, 0],
      });
    }
    // The butt hinges on the hinge stile (outer side of each leaf).
    const hx = i === 0 ? x0 + 0.004 : x1 - 0.004;
    for (const hy of [0.25, doorTop / 2, doorTop - 0.25]) {
      p.add('metal', cylG(0.007, 0.007, 0.11, 8), { at: [hx, hy, face + 0.004] });
    }
  }
  // The threshold under the leaves.
  const t = d.threshold;
  p.add('sill', boxG(widthM - 2 * f, t.heightM, t.depthM), {
    at: [widthM / 2, t.heightM / 2, STOREFRONT.proudM - t.depthM / 2 + 0.03],
  });
  return p.kit();
}
