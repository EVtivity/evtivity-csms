// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The depot pantograph pole of the 3D site layout (an inverted pantograph
// that comes down onto the roof rails of a bus, OppCharge, SAE J3105-1),
// typical of the class (for example the ABB HVC-PD data sheet and the Siemens
// Sicharge UC pantograph): a steel pole on a base plate, a boom out
// over the bays, the control module with its screen on the pole, and under
// the boom over each bay the pantograph frame with its scissor linkage,
// insulators and contact head.
//
// Frame: the pole foot at the origin on y = 0, the boom reaching out along
// +z (toward the bays), x across the bays. The control module is on the +z
// face of the pole, its back against the pole.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  latheG,
  roundBoxG,
  tubeG,
} from './site-layout-model-kit';
import { roundedRect } from './site-layout-model-charger-parts';
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
 * ABB HVC-PD (HVC150P/HVC300P/HVC450P pantograph down data sheet): pole
 * 5.24 m high, the pantograph 4.67 m out from the pole, the pantograph kit
 * 1.3 by 0.9 m, the control module 1600 by 1000 by 477 mm. Boom height 5.1 m
 * and the section sizes are drawn to match.
 */
export const PANTOGRAPH_POLE = {
  heightM: 5.24,
  boomY: 5.1,
  outreachM: 4.67,
  poleM: 0.3,
  basePlate: { sizeM: 0.6, thickM: 0.03 },
  footing: { sizeM: 0.9, heightM: 0.06 },
  boom: { widthM: 0.24, heightM: 0.3 },
  housing: { widthM: 1.3, heightM: 0.3, depthM: 0.9 },
  module: {
    widthM: 1.0,
    heightM: 1.6,
    depthM: 0.477,
    bottomM: 0.45,
    /**
     * The screen center height and size on the front, and the logo area on the
     * side facing the bay entrance (owner decision 2026-11-02: the front keeps
     * only the screen, card reader and status light). Derived: the side is
     * 0.477 m deep, 0.417 m flat between its 0.03 m rounded edges, so a 0.37 m
     * square with 2 cm to spare, centered with the screen at 1.45 m, above the
     * louvers (to 0.84 m).
     */
    screen: { yM: 1.45, widthM: 0.44, heightM: 0.34 },
    logo: { yM: 1.45, widthM: 0.37, heightM: 0.37 },
  },
} as const;

/** The underside of a pantograph frame under the boom, where its linkage hangs from. */
export const PANTOGRAPH_HOUSING_BOTTOM_Y =
  PANTOGRAPH_POLE.boomY - PANTOGRAPH_POLE.boom.heightM / 2 - PANTOGRAPH_POLE.housing.heightM;

/**
 * The pantograph linkage: two stages of 0.75 m arms in two planes 0.6 m
 * apart, post insulators to the contact head, and four contact pads in a row
 * across the head (DC+, DC-, PE, CP, SAE J3105-1) landing on the roof rails.
 */
export const PANTOGRAPH_LINKAGE = {
  stages: 2,
  armM: 0.75,
  planeHalfM: 0.3,
  insulatorM: 0.18,
  headM: 0.08,
  head: { widthM: 1.1, depthM: 0.6 },
  contactXs: [-0.45, -0.15, 0.15, 0.45],
} as const;

// Derived: the 0.04 m top rail gap, the 0.04 m carrier beam, the insulators and the head.
const LINK_FIXED_M = PANTOGRAPH_LINKAGE.insulatorM + PANTOGRAPH_LINKAGE.headM + 0.08;

/** The shortest and longest drop from the frame to the contact head surface. */
export const PANTOGRAPH_DROP = {
  minM: LINK_FIXED_M + scissorHeight(PANTOGRAPH_LINKAGE.armM, PANTOGRAPH_LINKAGE.stages, 0),
  maxM: LINK_FIXED_M + scissorHeight(PANTOGRAPH_LINKAGE.armM, PANTOGRAPH_LINKAGE.stages, 99),
} as const;

/** The drop that puts the contact head surface at `headY` above the ground, clamped. */
export function pantographDropFor(headY: number): number {
  return Math.min(
    PANTOGRAPH_DROP.maxM,
    Math.max(PANTOGRAPH_DROP.minM, PANTOGRAPH_HOUSING_BOTTOM_Y - headY),
  );
}

/**
 * Where the scene puts the logo plate: on the module side facing -x (the bay
 * entrance, the gate end of the yard). `centerZ` is the module's center along
 * the pole frame z, `outM` the plate's distance from the module's center plane.
 */
export const PANTOGRAPH_POLE_LOGO = {
  centerZ: PANTOGRAPH_POLE.poleM / 2 + PANTOGRAPH_POLE.module.depthM / 2,
  outM: PANTOGRAPH_POLE.module.widthM / 2 + 0.006,
  y: PANTOGRAPH_POLE.module.logo.yM,
  widthM: PANTOGRAPH_POLE.module.logo.widthM,
  heightM: PANTOGRAPH_POLE.module.logo.heightM,
} as const;

/** Where the RFID pad mounts on the control module front: right of the screen's lower half and below it, 1.12 m up (2010 ADA 308 reach). */
export const PANTOGRAPH_POLE_RFID = {
  x: 0.3,
  y: PANTOGRAPH_POLE.module.screen.yM - 0.33,
  z: PANTOGRAPH_POLE.poleM / 2 + PANTOGRAPH_POLE.module.depthM + 0.008,
} as const;

/** The screen center on the control module front (the display message and glow go there). */
export const PANTOGRAPH_POLE_SCREEN = {
  x: 0,
  y: PANTOGRAPH_POLE.module.screen.yM,
  z: PANTOGRAPH_POLE.poleM / 2 + PANTOGRAPH_POLE.module.depthM + 0.012,
} as const;

export interface PantographPoleOptions {
  outreachM?: number;
  /** The x of each pantograph frame along the crossbar (one per bay). */
  headXs?: readonly number[];
  /** The boom height (default `PANTOGRAPH_POLE.boomY`); the pole top keeps its 0.14 m above it. */
  boomY?: number;
  /** False for a pole with contact hoods, which hang from the crossbar without pantograph frames. */
  frames?: boolean;
}

/** The fixed parts of the pole: footing, pole, boom, brace, crossbar, frames and control module. */
export function createPantographPoleKit(o: PantographPoleOptions = {}): DepotKit {
  const P = PANTOGRAPH_POLE;
  const reach = o.outreachM ?? P.outreachM;
  const xs = o.headXs != null && o.headXs.length > 0 ? o.headXs : [0];
  const boomY = o.boomY ?? P.boomY;
  const heightM = boomY + (P.heightM - P.boomY);
  const p = new ModelParts<DepotSlot>();
  const half = P.poleM / 2;
  // The footing, crowned at grade, and the base plate with its anchor bolts.
  p.add(
    'concrete',
    latheG(
      [
        [0, P.footing.heightM],
        [P.footing.sizeM * 0.45, P.footing.heightM],
        [P.footing.sizeM * 0.55, 0.01],
        [P.footing.sizeM * 0.55, 0],
      ],
      4,
    ),
    { rot: [0, Math.PI / 4, 0] },
  );
  const plateY = P.footing.heightM + P.basePlate.thickM / 2;
  p.add('metal', boxG(P.basePlate.sizeM, P.basePlate.thickM, P.basePlate.sizeM), {
    at: [0, plateY, 0],
  });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const at = [sx * 0.23, plateY + 0.03, sz * 0.23] as const;
      p.add('metal', cylG(0.016, 0.016, 0.06, 8), { at: [at[0], at[1], at[2]] });
      p.add('trim', cylG(0.028, 0.028, 0.025, 6), { at: [at[0], plateY + 0.025, at[2]] });
    }
    // Gussets between the plate and the pole.
    p.add('body', boxG(0.012, 0.2, 0.14), { at: [sx * (half + 0.07), plateY + 0.1, 0] });
    p.add('body', boxG(0.14, 0.2, 0.012), { at: [0, plateY + 0.1, sx * (half + 0.07)] });
  }
  // The pole, a rounded square tube with a cap.
  const poleBottom = P.footing.heightM + P.basePlate.thickM;
  const poleH = heightM - poleBottom - 0.02;
  p.add('body', roundBoxG(P.poleM, poleH, P.poleM, 0.03), { at: [0, poleBottom + poleH / 2, 0] });
  p.add('trim', boxG(P.poleM + 0.03, 0.02, P.poleM + 0.03), { at: [0, heightM - 0.01, 0] });
  // The cable conduit up the back of the pole into the boom.
  p.add('trim', rodG([0, poleBottom + 0.1, -half - 0.04], [0, boomY - 0.1, -half - 0.04], 0.035));
  p.add('trim', cylG(0.05, 0.05, 0.08, 10), { at: [0, poleBottom + 0.12, -half - 0.04] });
  // The boom, from the back of the pole to past the crossbar.
  const boomEnd = reach + 0.35;
  const boomStart = -half - 0.05;
  p.add('body', roundBoxG(P.boom.widthM, P.boom.heightM, boomEnd - boomStart, 0.02), {
    at: [0, boomY, (boomEnd + boomStart) / 2],
  });
  p.add('trim', boxG(P.boom.widthM + 0.01, P.boom.heightM + 0.01, 0.012), {
    at: [0, boomY, boomEnd],
  });
  // The diagonal brace under the boom, with its end plates.
  const braceA = [0, boomY - 1.35, half] as const;
  const braceB = [0, boomY - P.boom.heightM / 2, Math.min(1.9, reach * 0.42)] as const;
  p.add('body', strutG(braceA, braceB, 0.12, 0.12));
  p.add('trim', boxG(0.2, 0.2, 0.015), { at: [0, braceA[1] + 0.04, half + 0.008] });
  p.add('trim', boxG(0.2, 0.015, 0.2), { at: [0, braceB[1] - 0.008, braceB[2]] });
  // The crossbar over two or more bays, at the end of the boom.
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  if (xMax - xMin > 0.01) {
    const span = xMax - xMin + P.housing.widthM * 0.6;
    p.add('body', roundBoxG(span, P.boom.heightM * 0.9, P.boom.widthM, 0.02), {
      at: [(xMin + xMax) / 2, boomY, reach],
    });
  }
  // The pantograph frame of each bay: a housing with its drive and the track the linkage runs in.
  const hy = PANTOGRAPH_HOUSING_BOTTOM_Y + P.housing.heightM / 2;
  for (const x of o.frames === false ? [] : xs) {
    p.add('body', roundBoxG(P.housing.widthM, P.housing.heightM, P.housing.depthM, 0.04), {
      at: [x, hy, reach],
    });
    p.add('trim', boxG(P.housing.widthM * 0.92, 0.03, P.housing.depthM * 0.92), {
      at: [x, PANTOGRAPH_HOUSING_BOTTOM_Y + 0.015, reach],
    });
    // The drive motor and gearbox on the side of the frame.
    p.add('metal', cylG(0.07, 0.07, 0.28, 12), {
      at: [x + P.housing.widthM / 2 + 0.06, hy, reach],
      rot: [Math.PI / 2, 0, 0],
    });
    p.add('trim', boxG(0.1, 0.16, 0.12), {
      at: [x + P.housing.widthM / 2 + 0.06, hy, reach + 0.18],
    });
    // The DC cable from the boom into the frame.
    p.add(
      'rubber',
      tubeG(
        [
          [x - 0.4, boomY - 0.05, reach - 0.2],
          [x - 0.55, hy, reach - 0.3],
          [x - 0.62, PANTOGRAPH_HOUSING_BOTTOM_Y + 0.05, reach],
        ],
        0.03,
        10,
        8,
      ),
    );
  }
  // The control module on the pole, its back against the pole.
  const m = P.module;
  const mz = half + m.depthM / 2;
  const my = m.bottomM + m.heightM / 2;
  p.add('body', roundBoxG(m.widthM, m.heightM, m.depthM, 0.03), { at: [0, my, mz] });
  const front = half + m.depthM;
  // The front plate area (tinted by the scene) with the door seam around it.
  p.add('plate', frontProfileG(roundedRect(m.widthM - 0.1, m.heightM - 0.14, 0.03), 0.008, 0.002), {
    at: [0, my, front + 0.004],
  });
  p.add('trim', boxG(0.006, m.heightM - 0.06, 0.004), {
    at: [m.widthM / 2 - 0.03, my, front + 0.002],
  });
  // The screen with its bezel, the light bar and the door lock (the scene adds the RFID pad).
  p.add(
    'trim',
    frontProfileG(roundedRect(m.screen.widthM + 0.06, m.screen.heightM + 0.06, 0.02), 0.012, 0.003),
    {
      at: [0, m.screen.yM, front + 0.01],
    },
  );
  p.add('glass', boxG(m.screen.widthM, m.screen.heightM, 0.006), {
    at: [0, m.screen.yM, front + 0.016],
  });
  p.add('light', frontProfileG(roundedRect(m.widthM * 0.6, 0.025, 0.012), 0.008), {
    at: [0, m.bottomM + m.heightM - 0.05, front + 0.012],
  });
  p.add('metal', cylG(0.012, 0.012, 0.02, 8), {
    at: [m.widthM / 2 - 0.08, my - 0.1, front + 0.012],
    rot: [Math.PI / 2, 0, 0],
  });
  // Louvers on each side of the module.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i += 1) {
      p.add('trim', boxG(0.006, 0.012, m.depthM * 0.6), {
        at: [side * (m.widthM / 2 + 0.003), m.bottomM + 0.2 + i * 0.035, mz],
        rot: [0, 0, side * 0.5],
      });
    }
  }
  // The mounting brackets that hold the module on the pole.
  for (const y of [m.bottomM + 0.15, m.bottomM + m.heightM - 0.15]) {
    p.add('metal', boxG(P.poleM + 0.06, 0.06, 0.04), { at: [0, y, -half - 0.02] });
  }
  return p.kit();
}

/**
 * The scissor pantograph hanging from a frame: origin at the frame's
 * underside center, the linkage running down (-y) to the contact head whose
 * pads end `dropM` below the origin (clamped to `PANTOGRAPH_DROP`). The arms
 * cross in the x-y plane, in two planes at z = +-0.3 m.
 */
export function createPantographLinkageKit(dropM: number): DepotKit {
  const L = PANTOGRAPH_LINKAGE;
  const drop = Math.min(PANTOGRAPH_DROP.maxM, Math.max(PANTOGRAPH_DROP.minM, dropM));
  const linkH = scissorHeight(L.armM, L.stages, drop - LINK_FIXED_M);
  const bottom = -(LINK_FIXED_M + linkH);
  const p = new ModelParts<DepotSlot>();
  const planes = [-L.planeHalfM, L.planeHalfM];
  const w = scissorWidth(L.armM, linkH, L.stages);
  // The top rail the upper arm ends slide in, the fixed pivot blocks.
  p.add('trim', boxG(1.15, 0.03, 0.05), { at: [0, -0.015, -L.planeHalfM] });
  p.add('trim', boxG(1.15, 0.03, 0.05), { at: [0, -0.015, L.planeHalfM] });
  addScissor(p, {
    map: (u, y, s) => [u, y, s],
    startY: -0.04,
    dir: -1,
    heightM: linkH,
    stages: L.stages,
    armM: L.armM,
    planes,
    armW: 0.05,
    armD: 0.03,
    pinR: 0.014,
  });
  // The lifting cylinder from the top rail to the first crossing.
  const h1 = linkH / L.stages;
  p.add('metal', rodG([-w / 2 + 0.05, -0.04, 0], [0, -0.04 - h1 / 2, 0], 0.035, 10));
  // The carrier beam under the linkage.
  const carrierY = -0.04 - linkH - 0.02;
  p.add('body', boxG(Math.max(0.5, w + 0.12), 0.04, L.planeHalfM * 2 + 0.1), {
    at: [0, carrierY, 0],
  });
  // Insulators from the carrier down to the contact head.
  const headTop = carrierY - 0.02 - L.insulatorM;
  for (const x of [-0.3, 0.3]) {
    addInsulator(p, { x, z: 0 }, carrierY - 0.02, headTop);
  }
  // The contact head: a frame with guide horns at its ends and four pads.
  p.add('body', boxG(L.head.widthM, 0.04, 0.12), { at: [0, headTop - 0.02, 0] });
  for (const side of [-1, 1]) {
    p.add('body', boxG(0.05, 0.04, L.head.depthM), {
      at: [side * (L.head.widthM / 2 - 0.025), headTop - 0.02, 0],
    });
    p.add(
      'metal',
      strutG(
        [side * (L.head.widthM / 2 - 0.02), headTop - 0.02, 0],
        [side * (L.head.widthM / 2 + 0.12), headTop + 0.08, 0],
        0.03,
        0.03,
      ),
    );
  }
  for (const x of L.contactXs) {
    p.add('trim', boxG(0.07, 0.03, L.head.depthM * 0.9), { at: [x, headTop - 0.045, 0] });
    const padTop = headTop - 0.04;
    p.add('copper', boxG(0.05, padTop - bottom, L.head.depthM * 0.8), {
      at: [x, (padTop + bottom) / 2, 0],
    });
  }
  return p.kit();
}

/** One pantograph of the pole: the x along the crossbar and the drop of its contact head. */
export interface PantographHead {
  x: number;
  dropM: number;
}

/**
 * A pantograph pole with a pantograph over each bay. The linkage of head i
 * is a child group named `pantograph-<i>` at the underside of its frame, so
 * the scene can swap it for `createPantographLinkageKit` of another drop.
 */
export function buildPantographPole(
  materials: DepotMaterials,
  heads: readonly PantographHead[] = [{ x: 0, dropM: PANTOGRAPH_DROP.minM }],
  outreachM: number = PANTOGRAPH_POLE.outreachM,
): THREE.Group {
  const g = buildDepotGroup(
    createPantographPoleKit({ outreachM, headXs: heads.map((h) => h.x) }),
    materials,
    'pantograph-pole',
  );
  heads.forEach((h, i) => {
    const link = buildDepotGroup(
      createPantographLinkageKit(h.dropM),
      materials,
      `pantograph-${String(i)}`,
    );
    link.position.set(h.x, PANTOGRAPH_HOUSING_BOTTOM_Y, outreachM);
    g.add(link);
  });
  return g;
}
