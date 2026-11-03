// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The contact hood of a pantograph up mast (the bus roof pantograph rises
// into it, SAE J3105-2): a flared inverted trough that guides the collector
// head in, four contact rails on insulators inside it, end plates, and two
// hangers up to the boom.
//
// Frame: the underside of the contact rails at the origin (where the roof
// pantograph shoes touch), the hood rising +y; the rails run along x (across
// the bay), spaced along z (the bus length).

import * as THREE from 'three';
import { ModelParts, boxG, frontProfileG, type Pt } from './site-layout-model-kit';
import {
  addInsulator,
  buildDepotGroup,
  type DepotKit,
  type DepotMaterials,
  type DepotSlot,
} from './site-layout-model-scissor';

/**
 * The hood is 1.4 m across and 0.7 m along the bay (the size the scene
 * already draws at 4.9 m). Derived: the flare opens 0.18 m below the rails,
 * giving the 1.4 m mouth a 0.25 m lead-in on each side for a 0.9 m collector
 * head; four rails (DC+, DC-, PE, CP) at a 0.16 m pitch fill 0.48 m of the
 * 0.7 m depth with 0.11 m to spare at each end.
 */
export const PANTOGRAPH_HOOD = {
  widthM: 1.4,
  depthM: 0.7,
  topM: 0.26,
  mouthM: -0.18,
  plateM: 0.015,
  rail: { lengthM: 1.2, widthM: 0.05, heightM: 0.04, zs: [-0.24, -0.08, 0.08, 0.24] },
  insulatorM: 0.17,
  hanger: { sizeM: 0.12, xs: [-0.45, 0.45] },
} as const;

/**
 * The hood's contact rails' underside above grade: a 3.38 m bus roof (the
 * roof contact of the bus kit) plus the 1.5 m minimum working height of a
 * roof pantograph (1.5 to 1.8 m above the roof, roof pantographs of the
 * class, for example the Schunk SLS 102), rounded up to 4.9 m. Derived.
 */
export const PANTOGRAPH_HOOD_RAIL_Y = 4.9;

/** The hanger length from the hood top to the crossbar underside. Derived: room for the two 0.12 m hanger posts' clamps. */
export const PANTOGRAPH_HOOD_HANGER_M = 0.1;

/**
 * The boom height of a pole that carries hoods: the rails at
 * PANTOGRAPH_HOOD_RAIL_Y, the hood 0.26 m tall above them, the hanger, then
 * half the 0.3 m boom (`PANTOGRAPH_POLE.boom`): 5.41 m. Derived.
 */
export function pantographUpBoomY(boomHeightM: number): number {
  return PANTOGRAPH_HOOD_RAIL_Y + PANTOGRAPH_HOOD.topM + PANTOGRAPH_HOOD_HANGER_M + boomHeightM / 2;
}

/** The trough section [x, y], a thin plate, counter clockwise. */
function troughSection(): Pt[] {
  const h = PANTOGRAPH_HOOD;
  const hw = h.widthM / 2;
  const t = h.plateM;
  const shoulder = hw - 0.17;
  return [
    [-hw, h.mouthM],
    [-hw + t, h.mouthM],
    [-shoulder + t * 0.4, h.topM - t],
    [shoulder - t * 0.4, h.topM - t],
    [hw - t, h.mouthM],
    [hw, h.mouthM],
    [shoulder, h.topM],
    [-shoulder, h.topM],
  ];
}

/** The hood with hangers `hangerM` long above its top (0 for none). */
export function createPantographHoodKit(hangerM = 0): DepotKit {
  const h = PANTOGRAPH_HOOD;
  const p = new ModelParts<DepotSlot>();
  p.add('body', frontProfileG(troughSection(), h.depthM, 0.004));
  // End plates closing the top half of each end, stiffening the trough.
  const shoulder = h.widthM / 2 - 0.17;
  for (const side of [-1, 1]) {
    const plate: Pt[] = [
      [-shoulder - 0.08, 0.1],
      [shoulder + 0.08, 0.1],
      [shoulder, h.topM],
      [-shoulder, h.topM],
    ];
    p.add('body', frontProfileG(plate, 0.012), { at: [0, 0, side * (h.depthM / 2 - 0.006)] });
    // The flared lip along each long edge.
    p.add('trim', boxG(0.04, 0.02, h.depthM + 0.02), {
      at: [side * (h.widthM / 2 - 0.02), h.mouthM, 0],
    });
  }
  // The rails on their insulators, hung from the trough top.
  const insTop = h.topM - h.plateM;
  for (const z of h.rail.zs) {
    p.add('copper', boxG(h.rail.lengthM, h.rail.heightM, h.rail.widthM), {
      at: [0, h.rail.heightM / 2, z],
    });
    p.add('trim', boxG(h.rail.lengthM + 0.04, 0.012, h.rail.widthM + 0.01), {
      at: [0, h.rail.heightM + 0.006, z],
    });
    for (const x of [-0.4, 0.4]) {
      addInsulator(p, { x, z }, h.rail.heightM + 0.012, insTop, 0.018, 0.034);
    }
  }
  // The hangers with their flange plates.
  if (hangerM > 0) {
    for (const x of h.hanger.xs) {
      p.add('metal', boxG(h.hanger.sizeM, hangerM, h.hanger.sizeM), {
        at: [x, h.topM + hangerM / 2, 0],
      });
      p.add('trim', boxG(0.22, 0.015, 0.22), { at: [x, h.topM + 0.008, 0] });
      p.add('trim', boxG(0.22, 0.015, 0.22), { at: [x, h.topM + hangerM - 0.008, 0] });
    }
    p.add('metal', boxG(h.hanger.xs[1] - h.hanger.xs[0], 0.08, 0.08), {
      at: [0, h.topM + hangerM * 0.55, 0],
    });
  }
  return p.kit();
}

/** The hood as a group. */
export function buildPantographHood(materials: DepotMaterials, hangerM = 0): THREE.Group {
  return buildDepotGroup(createPantographHoodKit(hangerM), materials, 'pantograph-hood');
}
