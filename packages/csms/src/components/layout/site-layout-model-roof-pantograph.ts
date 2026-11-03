// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The bus roof pantograph (pantograph up, SAE J3105-2) of the 3D site layout,
// typical of the class (for example the Schunk SLS 102 and the Stemmann-Technik
// roof pantographs): a base frame on roof insulators, a scissor arm
// in two planes, the drive cylinder and the collector head with four contact
// shoes and guide horns.
//
// Frame: the roof surface under the base center at the origin, the arm
// rising +y; the arms cross in the y-z plane (along the bus), the shoes run
// along x (across the bus) to meet the hood's rails.

import * as THREE from 'three';
import { ModelParts, boxG, cylG } from './site-layout-model-kit';
import {
  addInsulator,
  addScissor,
  buildDepotGroup,
  rodG,
  scissorHeight,
  scissorWidth,
  strutG,
  type DepotKit,
  type DepotMaterials,
  type DepotSlot,
} from './site-layout-model-scissor';

/**
 * Schunk SLS 102: working range 1.5 to 1.8 m above the roof. Derived: two
 * stages of 0.85 m arms reach 1.65 m of linkage (97 percent of 2 x 0.85),
 * which with the 0.16 m base and the 0.12 m head covers 1.8 m; folded the
 * arms lie at 0.43 m. The base frame (1.2 by 0.8 m) holds the folded arm
 * span of 0.85 m.
 */
export const ROOF_PANTOGRAPH = {
  stages: 2,
  armM: 0.85,
  planeHalfM: 0.25,
  baseM: 0.16,
  base: { lengthM: 1.2, widthM: 0.8 },
  insulatorM: 0.1,
  headM: 0.12,
  head: { widthM: 0.9, shoeZs: [-0.24, -0.08, 0.08, 0.24] },
  workingM: { minM: 1.5, maxM: 1.8 },
} as const;

const FIXED_M = ROOF_PANTOGRAPH.baseM + ROOF_PANTOGRAPH.headM;

/** The guide horn start below the shoe tops: the half strut width (0.015 m) plus 5 mm. Derived. */
const HORN_DROP_M = 0.025;

/** The lowest (folded) and highest shoe top above the roof. */
export const ROOF_PANTOGRAPH_RISE = {
  minM: FIXED_M + scissorHeight(ROOF_PANTOGRAPH.armM, ROOF_PANTOGRAPH.stages, 0),
  maxM: FIXED_M + scissorHeight(ROOF_PANTOGRAPH.armM, ROOF_PANTOGRAPH.stages, 99),
} as const;

/** The roof pantograph with its shoe tops `riseM` above the roof (clamped). */
export function createRoofPantographKit(riseM: number = ROOF_PANTOGRAPH_RISE.minM): DepotKit {
  const R = ROOF_PANTOGRAPH;
  const p = new ModelParts<DepotSlot>();
  const linkH = scissorHeight(R.armM, R.stages, riseM - FIXED_M);
  const top = R.baseM + linkH + R.headM;
  // The roof insulators and the base frame on them.
  const bx = R.base.widthM / 2 - 0.06;
  const bz = R.base.lengthM / 2 - 0.08;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1])
      addInsulator(p, { x: sx * bx, z: sz * bz }, 0, R.insulatorM, 0.022, 0.04);
    p.add('metal', boxG(0.06, 0.05, R.base.lengthM), { at: [sx * bx, R.insulatorM + 0.025, 0] });
  }
  for (const sz of [-1, 1]) {
    p.add('metal', boxG(R.base.widthM, 0.05, 0.06), { at: [0, R.insulatorM + 0.025, sz * bz] });
  }
  // The pivot blocks and the slide rail of the lower arm ends.
  for (const sx of [-1, 1]) {
    p.add('trim', boxG(0.05, 0.03, R.base.lengthM * 0.85), {
      at: [sx * R.planeHalfM, R.baseM - 0.015, 0],
    });
  }
  const w = addScissor(p, {
    map: (u, y, s) => [s, y, u],
    startY: R.baseM,
    dir: 1,
    heightM: linkH,
    stages: R.stages,
    armM: R.armM,
    planes: [-R.planeHalfM, R.planeHalfM],
    armW: 0.045,
    armD: 0.03,
    pinR: 0.012,
  });
  // The drive cylinder from the base to the first crossing.
  const first = scissorWidth(R.armM, linkH, R.stages);
  p.add(
    'metal',
    rodG([0, R.baseM + 0.02, first / 2], [0, R.baseM + linkH / R.stages / 2, 0], 0.03, 10),
  );
  p.add('trim', cylG(0.045, 0.045, 0.06, 10), { at: [0, R.baseM + 0.03, first / 2] });
  // The head carrier, its springs and the collector frame with four shoes.
  const carrierY = R.baseM + linkH + 0.02;
  p.add('metal', boxG(R.planeHalfM * 2 + 0.08, 0.03, Math.max(0.4, w + 0.1)), {
    at: [0, carrierY, 0],
  });
  for (const sx of [-0.3, 0.3]) {
    p.add('trim', cylG(0.025, 0.025, 0.05, 8), { at: [sx, carrierY + 0.04, 0] });
  }
  const frameY = carrierY + 0.075;
  p.add('body', boxG(R.head.widthM, 0.03, 0.6), { at: [0, frameY, 0] });
  for (const z of R.head.shoeZs) {
    p.add('copper', boxG(R.head.widthM - 0.1, top - frameY - 0.015, 0.04), {
      at: [0, (top + frameY + 0.015) / 2, z],
    });
  }
  // The guide horns at each end of the collector, bent down. They start
  // HORN_DROP_M below the shoe tops, so no corner of the 0.03 m strut rises
  // past the shoes into the contact rails above them.
  for (const side of [-1, 1]) {
    const x0 = side * (R.head.widthM / 2 - 0.02);
    const y0 = top - HORN_DROP_M;
    p.add('metal', strutG([x0, y0, 0], [x0 + side * 0.14, y0 - 0.08, 0], 0.03, 0.5));
  }
  return p.kit();
}

/** The roof pantograph as a group. */
export function buildRoofPantograph(materials: DepotMaterials, riseM?: number): THREE.Group {
  return buildDepotGroup(createRoofPantographKit(riseM), materials, 'roof-pantograph');
}
