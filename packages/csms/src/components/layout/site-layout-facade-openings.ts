// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The openings of the office or retail building facade (windows, the
// entrance door and its canopy), in lot x and height: the scene builds the
// facade parts from these, and every item mounted on the facade (wall box,
// sign, wall panelboard, conduit) keeps clear of them.

import { facadeDoorSize } from './site-layout-model-facade-door';
import { buildingBox, type Lot } from './site-layout-grid';

/** The facade layout: the ground floor window strip, the upper window band and the entrance canopy. */
export const FACADE_LAYOUT = {
  /** The high window strip of the ground floor (above the wall boxes and their signs). */
  strip: { bottomM: 2.3, heightM: 0.6 },
  /** The upper floor window band with a transom rail. */
  band: { bottomM: 4.0, heightM: 2.1, railM: 1.5 },
  /** The windows stop this far in from each building end. */
  insetM: 0.5,
  /** The entrance canopy. */
  canopy: { widthM: 4.6, depthM: 2.4 },
  /** A window sill hangs this far below its frame. */
  sillM: 0.06,
} as const;

export interface FacadeOpening {
  kind: 'window' | 'door' | 'canopy';
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The middle of the entrance, on the building part right of the lot. */
export function entranceX(lot: Lot): number {
  const b = buildingBox(lot);
  return lot.width + (b.maxX - lot.width) / 2;
}

/** The soffit of the entrance canopy: 0.25 m over the door head, above the 7 ft (2.134 m) awning clearance. */
export function canopySoffitM(): number {
  return Math.max(2.134, facadeDoorSize(2).heightM + 0.25);
}

/** Every opening of the facade of `lot`'s building. */
export function facadeOpenings(lot: Lot): FacadeOpening[] {
  const b = buildingBox(lot);
  const f = FACADE_LAYOUT;
  const minX = b.minX + f.insetM;
  const maxX = b.maxX - f.insetM;
  const ex = entranceX(lot);
  const door = facadeDoorSize(2);
  const soffit = canopySoffitM();
  return [
    {
      kind: 'window',
      minX,
      maxX,
      minY: f.strip.bottomM - f.sillM,
      maxY: f.strip.bottomM + f.strip.heightM,
    },
    {
      kind: 'window',
      minX,
      maxX,
      minY: f.band.bottomM - f.sillM,
      maxY: f.band.bottomM + f.band.heightM,
    },
    {
      kind: 'door',
      minX: ex - door.widthM / 2,
      maxX: ex + door.widthM / 2,
      minY: 0,
      maxY: door.heightM,
    },
    {
      kind: 'canopy',
      minX: ex - f.canopy.widthM / 2,
      maxX: ex + f.canopy.widthM / 2,
      minY: soffit,
      maxY: soffit + 0.8,
    },
  ];
}
