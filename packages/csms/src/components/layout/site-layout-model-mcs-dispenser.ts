// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The megawatt (MCS) truck dispenser of the 3D site layout, after the
// a generic megawatt (MCS) dispenser, typical of the class (for example the
// alpitronic HYC1000 MCS dispenser and the ABB MCS1200 charge post): a slim post with a shaped side outline,
// the screen and front plate on the lane face and the emergency stop. Its
// heavy cable rides on the cable management arm beside it
// (`site-layout-model-mcs-cable-arm.ts`). The scene adds the holster and
// handle (`site-layout-connectors.ts`) at `MCS_DISPENSER_HOLSTER`.
//
// Frame: the lane face (front) faces +z, x across it, standing on y = 0.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  sideProfileG,
  type Pt,
  type Vec3,
} from './site-layout-model-kit';
import { roundedRect } from './site-layout-model-charger-parts';
import {
  buildDepotGroup,
  type DepotKit,
  type DepotMaterials,
  type DepotSlot,
} from './site-layout-model-scissor';

/**
 * alpitronic HYC1000 MCS dispenser: 2320 mm high, 780 mm wide. Depth 0.42 m
 * as the scene draws it (the 260 mm body plus the cable hanger and front
 * plate). Derived: the back tapers from 0.42 m at the base to 0.32 m at the
 * top, the top front corner rounded on a 0.12 m arc; screen center at 1.75 m
 * (74 percent of the 2.2 m body, as the scene places it); holster 1.2 m (inside the 15 to 48 in reach range, 2010 ADA 308).
 */
export const MCS_DISPENSER = {
  heightM: 2.32,
  widthM: 0.78,
  depthM: 0.42,
  topDepthM: 0.32,
  plinthM: 0.1,
  cornerM: 0.12,
  screen: { yM: 1.75, widthM: 0.44, heightM: 0.34 },
} as const;

const FRONT_Z = MCS_DISPENSER.depthM / 2;

/** The holster mount on the lane face. */
export const MCS_DISPENSER_HOLSTER: Vec3 = [-0.2, 1.2, FRONT_Z];
/** The screen center on the lane face. */
export const MCS_DISPENSER_SCREEN: Vec3 = [0, MCS_DISPENSER.screen.yM, FRONT_Z + 0.012];
/** The logo plate on the back, facing -z. */
export const MCS_DISPENSER_LOGO = { x: 0, y: 1.5, widthM: 0.5, heightM: 0.16 } as const;

/** The side silhouette [z, y]: vertical lane face, tapered back, rounded top front. */
function sideOutline(): Pt[] {
  const D = MCS_DISPENSER;
  const front = FRONT_Z;
  const backBottom = -FRONT_Z;
  const backTop = front - D.topDepthM;
  const r = D.cornerM;
  const pts: Pt[] = [
    [backBottom, D.plinthM],
    [front, D.plinthM],
  ];
  for (let i = 0; i <= 5; i += 1) {
    const a = (i / 5) * (Math.PI / 2);
    pts.push([front - r + Math.cos(a) * r, D.heightM - r + Math.sin(a) * r]);
  }
  pts.push([backTop, D.heightM]);
  return pts;
}

export function createMcsDispenserKit(): DepotKit {
  const D = MCS_DISPENSER;
  const p = new ModelParts<DepotSlot>();
  // The plinth and the shaped body.
  p.add('trim', boxG(D.widthM + 0.04, D.plinthM, D.depthM + 0.04), { at: [0, D.plinthM / 2, 0] });
  p.add('body', sideProfileG(sideOutline(), D.widthM, 0.02));
  // The front plate area the scene tints, between the outlet and the screen.
  p.add('plate', frontProfileG(roundedRect(D.widthM - 0.12, 0.62, 0.04), 0.008, 0.002), {
    at: [0, 1.22, FRONT_Z + 0.004],
  });
  // The screen with its bezel and the light bar above it.
  p.add(
    'trim',
    frontProfileG(roundedRect(D.screen.widthM + 0.06, D.screen.heightM + 0.06, 0.02), 0.012, 0.003),
    {
      at: [0, D.screen.yM, FRONT_Z + 0.006],
    },
  );
  p.add('glass', boxG(D.screen.widthM, D.screen.heightM, 0.006), { at: MCS_DISPENSER_SCREEN });
  p.add('light', frontProfileG(roundedRect(D.widthM * 0.6, 0.03, 0.015), 0.008), {
    at: [0, D.heightM - D.cornerM - 0.05, FRONT_Z + 0.006],
  });
  // The RFID reader and the emergency stop with its yellow collar.
  p.add('trim', frontProfileG(roundedRect(0.11, 0.11, 0.015), 0.012, 0.002), {
    at: [0.24, D.screen.yM - 0.32, FRONT_Z + 0.006],
  });
  p.add('plate', cylG(0.045, 0.045, 0.008, 16), {
    at: [0.24, D.screen.yM - 0.5, FRONT_Z + 0.006],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add('stop', cylG(0.028, 0.034, 0.04, 14), {
    at: [0.24, D.screen.yM - 0.5, FRONT_Z + 0.03],
    rot: [Math.PI / 2, 0, 0],
  });
  // The holster backing plate.
  p.add('trim', frontProfileG(roundedRect(0.2, 0.26, 0.025), 0.01, 0.002), {
    at: [MCS_DISPENSER_HOLSTER[0], MCS_DISPENSER_HOLSTER[1], FRONT_Z + 0.005],
  });
  // Side air intake louvers and the door seam.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i += 1) {
      p.add('trim', boxG(0.006, 0.012, 0.2), {
        at: [side * (D.widthM / 2 + 0.003), D.plinthM + 0.25 + i * 0.035, -0.02],
        rot: [0, 0, side * 0.5],
      });
    }
    p.add('trim', boxG(0.004, 1.9, 0.004), {
      at: [side * (D.widthM / 2 - 0.04), 1.1, FRONT_Z + 0.001],
    });
  }
  return p.kit();
}

/** The MCS dispenser as a group. */
export function buildMcsDispenser(materials: DepotMaterials): THREE.Group {
  return buildDepotGroup(createMcsDispenserKit(), materials, 'mcs-dispenser');
}
