// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// One photovoltaic module of the solar carport roof, after the Canadian
// Solar HiKu6 CS6W-MS datasheet: 2278 by 1134 by 35 mm, 144 half cells
// (2 x 12 x 6), an anodized aluminum frame. The frame is its real profile
// (outer wall, a lip over the glass, a return flange under it) on all four
// sides; the cells sit under the lip in six columns of two half-cell strings
// split at the middle; a junction box and its two connector stubs sit on the
// back sheet near the top end.
//
// Frame: the module lies flat, glass up, its long side along z (portrait,
// up the slope of a carport), x across it, the frame bottom on y = 0,
// centered in x and z. Meant to be instanced (one InstancedMesh per slot).

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  sideProfileG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';

export const SOLAR_MODULE_SLOTS = ['frame', 'cell', 'grid', 'back', 'box'] as const;
export type SolarModuleSlot = (typeof SOLAR_MODULE_SLOTS)[number];

export const SOLAR_MODULE = {
  lengthM: 2.278,
  widthM: 1.134,
  thicknessM: 0.035,
  columns: 6,
  /** Half cells along the length: two strings of 12 split at the middle. */
  rows: 24,
  /** Frame profile: return flange width, wall and lip thickness, lip reach over the glass. */
  frame: { flangeM: 0.025, wallM: 0.004, lipM: 0.012, lipThickM: 0.008 },
  /** Gaps between cells; drawn wider than the real 2 mm so the grid reads at 3 m. */
  gapM: 0.005,
  /**
   * Derived: six 182 mm (M10) cells span 1092 mm of the 1134 mm width, so
   * 21 mm a side reaches the edge; 12 mm of it is under the lip.
   */
  marginM: 0.009,
  laminateM: 0.0045,
} as const;

export type SolarModuleKit = ModelKit<SolarModuleSlot>;

// A flat quad facing up (+y): the cell faces only show from above.
function quadG(w: number, d: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
}

/** A module `lengthM` by `widthM` (defaults: CS6W-MS), its cell grid scaled to fit. */
export function createSolarModuleKit(
  lengthM: number = SOLAR_MODULE.lengthM,
  widthM: number = SOLAR_MODULE.widthM,
): SolarModuleKit {
  const m = SOLAR_MODULE;
  const f = m.frame;
  const p = new ModelParts<SolarModuleSlot>();
  const T = m.thicknessM;
  // Section of one frame member in [inward from the outer edge, y], drawn for
  // a member along x: the outer wall, the return flange and the glass lip.
  const section = (dir: 1 | -1): Pt[] => {
    const pts: Pt[] = [
      [0, 0],
      [f.flangeM, 0],
      [f.flangeM, f.wallM],
      [f.wallM, f.wallM],
      [f.wallM, T - f.lipThickM],
      [f.lipM, T - f.lipThickM],
      [f.lipM, T],
      [0, T],
    ];
    return dir > 0 ? pts : pts.map(([u, y]) => [-u, y] as const).reverse();
  };
  const hl = lengthM / 2;
  const hw = widthM / 2;
  // Long members along z (sides at x = +-hw), short ones along x between them.
  for (const side of [-1, 1] as const) {
    p.add('frame', sideProfileG(section(side > 0 ? -1 : 1), lengthM), {
      at: [side * hw, 0, 0],
      rot: [0, Math.PI / 2, 0],
    });
  }
  for (const side of [-1, 1] as const) {
    p.add('frame', sideProfileG(section(side > 0 ? -1 : 1), widthM - 2 * f.wallM), {
      at: [0, 0, side * hl],
    });
  }
  // The laminate: back sheet under, the cell backing on top under the lip.
  const innerL = lengthM - 2 * f.wallM;
  const innerW = widthM - 2 * f.wallM;
  const glassY = T - f.lipThickM;
  p.add('back', boxG(innerW, m.laminateM, innerL), { at: [0, glassY - m.laminateM / 2, 0] });
  const cellsW = widthM - 2 * (f.lipM + m.marginM);
  const cellsL = lengthM - 2 * (f.lipM + m.marginM);
  p.add('grid', quadG(innerW, innerL), { at: [0, glassY + 0.0002, 0] });
  // Cell strips: one per column and half, then the row gaps across them.
  const colW = (cellsW - (m.columns - 1) * m.gapM) / m.columns;
  const halfL = (cellsL - 2 * m.gapM) / 2;
  const cellY = glassY + 0.0008;
  for (let c = 0; c < m.columns; c++) {
    const x = -cellsW / 2 + colW / 2 + c * (colW + m.gapM);
    for (const half of [-1, 1]) {
      p.add('cell', quadG(colW, halfL), {
        at: [x, cellY, half * (m.gapM + halfL / 2)],
      });
    }
  }
  const perHalf = m.rows / 2;
  const rowL = halfL / perHalf;
  for (const half of [-1, 1]) {
    for (let r = 1; r < perHalf; r++) {
      const z = half * (m.gapM + r * rowL);
      p.add('grid', quadG(cellsW, m.gapM * 0.6), { at: [0, cellY + 0.0004, z] });
    }
  }
  // The junction box on the back sheet near the top end, with its two leads.
  const jy = glassY - m.laminateM - 0.011;
  p.add('box', boxG(0.12, 0.022, 0.08), { at: [0, jy, hl - 0.25] });
  for (const x of [-0.04, 0.04]) {
    p.add('box', cylG(0.006, 0.006, 0.12, 6), {
      at: [x, jy, hl - 0.25 - 0.1],
      rot: [Math.PI / 2, 0, 0],
    });
  }
  return p.kit();
}
