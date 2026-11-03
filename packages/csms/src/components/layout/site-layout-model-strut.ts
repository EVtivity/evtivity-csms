// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The strut channel of the equipment racks of the 3D site layout: the real
// open C section with inturned lips, extruded to a length.

import * as THREE from 'three';
import { frontProfileG, type Pt } from './site-layout-model-kit';

/**
 * Unistrut P1000, 12 gauge: 1-5/8 by 1-5/8 in (41.3 mm) section, 0.105 in
 * (2.66 mm) wall, 7/8 in (22.2 mm) slot opening between the inturned lips
 * (Unistrut General Engineering Catalog No. 19, P1000 channel,
 * https://www.unistrut.us/catalogs).
 */
export const STRUT_CHANNEL = {
  sizeM: 0.0413,
  wallM: 0.00266,
  slotM: 0.0222,
  /** How far the lips turn back into the channel (no source: drawn to the catalog figure). */
  lipM: 0.009,
} as const;

/** The strut channel section [x, y], centered, the slot opening toward +y, counter clockwise. */
export function strutSection(): Pt[] {
  const s = STRUT_CHANNEL.sizeM / 2;
  const t = STRUT_CHANNEL.wallM;
  const w = (STRUT_CHANNEL.sizeM - STRUT_CHANNEL.slotM) / 2;
  const d = STRUT_CHANNEL.lipM;
  return [
    [-s, -s],
    [s, -s],
    [s, s],
    [s - w, s],
    [s - w, s - d],
    [s - w + t, s - d],
    [s - w + t, s - t],
    [s - t, s - t],
    [s - t, -s + t],
    [-s + t, -s + t],
    [-s + t, s - t],
    [-s + w - t, s - t],
    [-s + w - t, s - d],
    [-s + w, s - d],
    [-s + w, s],
    [-s, s],
  ];
}

/**
 * A strut channel `lengthM` long, centered, the slot facing +z: along y
 * (a post) or along x (a crossbar).
 */
export function strutChannelG(lengthM: number, along: 'x' | 'y'): THREE.BufferGeometry {
  const g = frontProfileG(strutSection(), lengthM);
  // Section y (the slot side) to +z, the extrusion along y.
  g.rotateX(Math.PI / 2);
  if (along === 'x') g.rotateZ(Math.PI / 2);
  return g;
}
