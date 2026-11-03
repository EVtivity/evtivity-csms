// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A storefront window unit: the aluminum frame with vertical mullions and an
// optional horizontal rail, its glazing, a sloped sill with a drip under it
// and a head flashing over it.
//
// Facade frame: see `site-layout-model-facade-parts.ts` (wall face z = 0,
// x from the unit's left edge, y from the bottom of the frame).

import { ModelParts, sideProfileG } from './site-layout-model-kit';
import {
  STOREFRONT,
  addFramedGlazing,
  type FacadeKit,
  type FacadeSlot,
} from './site-layout-model-facade-parts';

/**
 * Window details, derived from the storefront frame (`STOREFRONT`): lites at
 * most 1.52 m (5 ft) wide, the common maximum of 1/4 in tempered lites in a
 * 2 x 4-1/2 in frame, so the mullion count is ceil(width / 1.52); the sill
 * projects 38 mm (1-1/2 in) past the frame face, slopes 1:4 to shed water,
 * and drops a 10 mm drip; the head flashing projects 15 mm past the frame.
 */
export const FACADE_WINDOW = {
  maxLiteM: 1.52,
  sill: { projectM: 0.038, heightM: 0.05, slope: 0.25, dripM: 0.01 },
  head: { projectM: 0.015, heightM: 0.02 },
} as const;

export interface FacadeWindowOptions {
  widthM: number;
  heightM: number;
  /** Height of a horizontal rail above the frame bottom (a transom), if any. */
  railM?: number;
}

/** A window unit `widthM` wide and `heightM` high (frame only; the sill hangs below y = 0). */
export function createFacadeWindowKit(o: FacadeWindowOptions): FacadeKit {
  const w = FACADE_WINDOW;
  const p = new ModelParts<FacadeSlot>();
  const cols = Math.max(1, Math.ceil(o.widthM / w.maxLiteM));
  addFramedGlazing(
    p,
    { x0: 0, y0: 0, x1: o.widthM, y1: o.heightM },
    cols,
    o.railM != null ? [o.railM] : [],
  );
  // The sill: its side section [z, y] extruded along the unit, 25 mm past each jamb.
  const s = w.sill;
  const front = STOREFRONT.proudM + s.projectM;
  const sill = [
    [0, -s.heightM],
    [front, -s.heightM],
    [front, -s.dripM - s.slope * s.projectM],
    [STOREFRONT.proudM, 0],
    [0, 0],
  ] as const;
  p.add('sill', sideProfileG(sill, o.widthM + 0.05, 0.002), { at: [o.widthM / 2, 0, 0] });
  // The drip lip under the sill nose.
  p.add(
    'sill',
    sideProfileG(
      [
        [front - 0.006, -s.heightM - s.dripM],
        [front, -s.heightM - s.dripM],
        [front, -s.heightM],
        [front - 0.006, -s.heightM],
      ],
      o.widthM + 0.05,
    ),
    { at: [o.widthM / 2, 0, 0] },
  );
  // The head flashing.
  const h = w.head;
  p.add(
    'frame',
    sideProfileG(
      [
        [0, o.heightM],
        [STOREFRONT.proudM + h.projectM, o.heightM],
        [STOREFRONT.proudM + h.projectM, o.heightM + h.heightM * 0.4],
        [0, o.heightM + h.heightM],
      ],
      o.widthM + 0.02,
    ),
    { at: [o.widthM / 2, 0, 0] },
  );
  return p.kit();
}
