// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Parts shared by the facade pieces of the office or retail building
// (windows, doors, canopy, cornice): the material slots, the storefront frame
// section and a framed glazing helper.
//
// Facade frame: the wall face is the plane z = 0, the piece stands out along
// +z, x runs along the facade from the piece's left edge (x = 0) to its
// width, y up from the piece's bottom (y = 0). The integrator places a piece
// on the building mass; nothing here cuts the mass.

import { ModelParts, boxG, frontProfileG } from './site-layout-model-kit';
import type { ModelKit, Pt } from './site-layout-model-kit';

/** The material slots of the facade pieces. */
export const FACADE_SLOTS = [
  /** Anodized aluminum framing. */
  'frame',
  /** Glazing (emissive at night). */
  'glass',
  /** Sills, thresholds, the cornice body: cast stone or concrete. */
  'sill',
  /** The canopy fascia (tinted by the scene in the accent color). */
  'fascia',
  /** Stainless or painted steel: push bars, tie rods, coping. */
  'metal',
  /** Light fittings (emissive). */
  'light',
] as const;
export type FacadeSlot = (typeof FACADE_SLOTS)[number];
export type FacadeKit = ModelKit<FacadeSlot>;

/**
 * Storefront framing typical of the class (for example Kawneer Trifab
 * VersaGlaze 451T and YKK AP YES 45 TU): 2 in (50.8 mm) sight
 * line by 4-1/2 in (114.3 mm) frame depth. Derived: the frame is centered in
 * the opening, so the half in front of the glazing pocket, 50 mm, stands
 * proud of the wall face, and the glass shows 4 mm in front of the wall face
 * (the rest of the reveal is inside the building mass, which is not cut).
 */
export const STOREFRONT = {
  faceM: 0.0508,
  depthM: 0.1143,
  proudM: 0.05,
  glassZ: 0.004,
} as const;

/** A rectangle outline from (x0, y0) to (x1, y1), counter clockwise. */
export function rectPts(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** The same rectangle clockwise, for a hole. */
export function rectHole(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return rectPts(x0, y0, x1, y1).reverse();
}

/**
 * Adds storefront framing with glazing: the outer frame from (x0, y0) to
 * (x1, y1), split into `cols` lites by vertical mullions and into rows at
 * each height in `rails` (absolute y), the glass behind every lite.
 */
export function addFramedGlazing(
  p: ModelParts<FacadeSlot>,
  box: { x0: number; y0: number; x1: number; y1: number },
  cols: number,
  rails: readonly number[] = [],
): void {
  const f = STOREFRONT.faceM;
  const n = Math.max(1, Math.round(cols));
  const pitch = (box.x1 - box.x0 - f) / n;
  const ys = [box.y0, ...rails.filter((r) => r > box.y0 + f && r < box.y1 - f), box.y1];
  const holes: Pt[][] = [];
  for (let c = 0; c < n; c += 1) {
    for (let r = 0; r < ys.length - 1; r += 1) {
      const lx0 = box.x0 + f + c * pitch;
      const lx1 = box.x0 + (c + 1) * pitch;
      const ly0 = (ys[r] ?? box.y0) + (r === 0 ? f : f / 2);
      const ly1 = (ys[r + 1] ?? box.y1) - (r === ys.length - 2 ? f : f / 2);
      holes.push(rectHole(lx0, ly0, lx1, ly1));
    }
  }
  p.add(
    'frame',
    frontProfileG(rectPts(box.x0, box.y0, box.x1, box.y1), STOREFRONT.proudM, 0.002, holes),
    {
      at: [0, 0, STOREFRONT.proudM / 2],
    },
  );
  p.add('glass', boxG(box.x1 - box.x0 - f, box.y1 - box.y0 - f, 0.006), {
    at: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, STOREFRONT.glassZ + 0.003],
  });
}
