// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The bus depot dispenser of the 3D site layout with its cable management
// arm (typical of the class, for example the Kempower Cable Arm and the
// Heliox depot arm): a dispenser cabinet at the head of the bays,
// a mast behind it, and per bay a two-segment arm on pivots at 4.5 m with
// the charging cable clipped along it, hanging from a spring balancer at the
// tip over the bay.
//
// Frame: the cabinet front faces +z (the bays), x across it, standing on
// y = 0; the mast stands behind the cabinet at z = -0.5.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  roundBoxG,
  type Vec3,
} from './site-layout-model-kit';
import { roundedRect } from './site-layout-model-charger-parts';
import {
  buildDepotGroup,
  rodG,
  strutG,
  type DepotKit,
  type DepotMaterials,
  type DepotSlot,
} from './site-layout-model-scissor';

/**
 * Cabinet 0.9 by 0.7 by 2.3 m on a 0.12 m plinth and mast at z -0.5 to a
 * 4.5 m arm, above the 3.4 m bus (the dimensions the scene draws; Kempower
 * Cable Arm: a pole-mounted arm that holds the cable over the vehicle).
 * Derived: the screen at 74 percent of the cabinet height (1.82 m), the
 * holsters at 1.2 m, inside the 15 to 48 in reach range (2010 ADA 308).
 */
export const BUS_DISPENSER = {
  widthM: 0.9,
  depthM: 0.7,
  heightM: 2.3,
  plinthM: 0.12,
  screen: { yM: 0.12 + 2.3 * 0.74, widthM: 0.44, heightM: 0.34 },
  mast: { z: -0.5, sizeM: 0.18 },
  armY: 4.5,
  arm: { widthM: 0.12, heightM: 0.12 },
  /** The spring balancer hanging under each arm tip; the cable leaves it at its bottom. */
  balancer: { radiusM: 0.07, heightM: 0.24, dropM: 0.1 },
} as const;

const FRONT_Z = BUS_DISPENSER.depthM / 2;

/** The holster mount points on the cabinet front (the scene adds the holsters and handles). */
export const BUS_DISPENSER_HOLSTERS: readonly Vec3[] = [
  [-0.3, 1.2, FRONT_Z],
  [0.3, 1.2, FRONT_Z],
];

/**
 * Where the RFID pad mounts: between the holsters, 1.12 m up, inside the 15
 * to 48 in reach range (2010 ADA Standards 308.2, 308.3); the screen above
 * it is out of reach of a hand at 1.82 m.
 */
export const BUS_DISPENSER_RFID: Vec3 = [0, 1.12, FRONT_Z];

/** The screen center on the cabinet front (display message and glow). */
export const BUS_DISPENSER_SCREEN: Vec3 = [0, BUS_DISPENSER.screen.yM, FRONT_Z + 0.012];

/** The logo plate on the cabinet back, facing -z. */
export const BUS_DISPENSER_LOGO = {
  x: 0,
  y: 1.6,
  z: -FRONT_Z - 0.006,
  widthM: 0.6,
  heightM: 0.2,
} as const;

/** One arm: its tip over the bay (x, z), at the arm height. */
export interface CableArmTip {
  x: number;
  z: number;
}

const PIVOT: Vec3 = [0, BUS_DISPENSER.armY, BUS_DISPENSER.mast.z];

/**
 * The elbow of a two-segment arm from the mast pivot to `tip`. Derived:
 * equal segments of 0.6 of the reach (at least 0.8 m), so the elbow bends
 * out sideways by sqrt(a^2 - (d/2)^2), away from the cabinet center.
 */
export function cableArmElbow(tip: CableArmTip): Vec3 {
  const dx = tip.x - PIVOT[0];
  const dz = tip.z - PIVOT[2];
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return [tip.x, PIVOT[1], tip.z];
  const a = Math.max(0.8, d * 0.6);
  const off = Math.sqrt(Math.max(0, a * a - (d / 2) * (d / 2)));
  const side = tip.x >= 0 ? 1 : -1;
  // The perpendicular to the reach in the plan, toward the arm's own side.
  let nx = -dz / d;
  let nz = dx / d;
  if (nx * side < 0) {
    nx = -nx;
    nz = -nz;
  }
  return [PIVOT[0] + dx / 2 + nx * off, PIVOT[1], PIVOT[2] + dz / 2 + nz * off];
}

/** Where the hanging cable leaves the balancer under an arm tip. */
export function cableArmOutlet(tip: CableArmTip): Vec3 {
  const b = BUS_DISPENSER.balancer;
  return [tip.x, BUS_DISPENSER.armY - BUS_DISPENSER.arm.heightM / 2 - b.dropM - b.heightM, tip.z];
}

/**
 * The cable route the kit draws for an arm: out of the cabinet top into the
 * mast, up it, along the arm over the elbow to the tip, down into the
 * balancer. The scene draws the hanging part from `cableArmOutlet`.
 */
export function cableArmRoute(tip: CableArmTip): Vec3[] {
  const D = BUS_DISPENSER;
  const above = D.armY + D.arm.heightM / 2 + 0.05;
  const elbow = cableArmElbow(tip);
  return [
    [0, D.plinthM + D.heightM, -0.2],
    [0, D.plinthM + D.heightM + 0.12, D.mast.z + 0.12],
    [0, above - 0.1, D.mast.z + 0.12],
    [PIVOT[0], above, PIVOT[2] + 0.05],
    [elbow[0], above, elbow[2]],
    [tip.x, above, tip.z],
    [tip.x + 0.12, D.armY - 0.1, tip.z],
  ];
}

export function createBusDispenserKit(tips: readonly CableArmTip[]): DepotKit {
  const D = BUS_DISPENSER;
  const p = new ModelParts<DepotSlot>();
  const bodyY = D.plinthM + D.heightM / 2;
  // The plinth, the cabinet with a cap, the door seams and the side louvers.
  p.add('trim', boxG(D.widthM + 0.06, D.plinthM, D.depthM + 0.06), { at: [0, D.plinthM / 2, 0] });
  p.add('body', roundBoxG(D.widthM, D.heightM, D.depthM, 0.05), { at: [0, bodyY, 0] });
  p.add('trim', roundBoxG(D.widthM + 0.08, 0.06, D.depthM + 0.08, 0.02), {
    at: [0, D.plinthM + D.heightM + 0.03, 0],
  });
  // The front plate area the scene tints, under the screen.
  p.add('plate', frontProfileG(roundedRect(D.widthM - 0.12, 1.25, 0.04), 0.008, 0.002), {
    at: [0, D.plinthM + 0.75, FRONT_Z + 0.004],
  });
  p.add(
    'trim',
    frontProfileG(roundedRect(D.screen.widthM + 0.06, D.screen.heightM + 0.06, 0.02), 0.012, 0.003),
    {
      at: [0, D.screen.yM, FRONT_Z + 0.006],
    },
  );
  p.add('glass', boxG(D.screen.widthM, D.screen.heightM, 0.006), {
    at: [0, D.screen.yM, FRONT_Z + 0.012],
  });
  p.add('light', frontProfileG(roundedRect(D.widthM * 0.7, 0.03, 0.015), 0.008), {
    at: [0, D.plinthM + D.heightM - 0.1, FRONT_Z + 0.006],
  });
  // The emergency stop beside the screen (the scene adds the RFID pad, `BUS_DISPENSER_RFID`).
  p.add('stop', cylG(0.03, 0.035, 0.04, 14), {
    at: [-0.3, D.screen.yM, FRONT_Z + 0.02],
    rot: [Math.PI / 2, 0, 0],
  });
  for (const side of [-1, 1]) {
    p.add('trim', boxG(0.004, D.heightM - 0.2, 0.004), {
      at: [side * (D.widthM / 2 - 0.05), bodyY, FRONT_Z + 0.001],
    });
    for (let i = 0; i < 8; i += 1) {
      p.add('trim', boxG(0.006, 0.012, D.depthM * 0.55), {
        at: [side * (D.widthM / 2 + 0.003), D.plinthM + 0.3 + i * 0.035, 0],
        rot: [0, 0, side * 0.5],
      });
    }
  }
  // The holster backing plates (the scene seats the holsters on them).
  for (const [x, y] of BUS_DISPENSER_HOLSTERS) {
    p.add('trim', frontProfileG(roundedRect(0.16, 0.22, 0.02), 0.008, 0.002), {
      at: [x, y, FRONT_Z + 0.004],
    });
  }
  // The mast on its base plate, with the cable entry from the cabinet top.
  const mastH = D.armY + 0.1;
  p.add('metal', boxG(0.4, 0.02, 0.4), { at: [0, 0.01, D.mast.z] });
  p.add('body', roundBoxG(D.mast.sizeM, mastH, D.mast.sizeM, 0.015), {
    at: [0, mastH / 2, D.mast.z],
  });
  p.add('trim', boxG(D.mast.sizeM + 0.03, 0.02, D.mast.sizeM + 0.03), {
    at: [0, mastH + 0.01, D.mast.z],
  });
  // The slewing bearing of the arms at the top of the mast.
  p.add('metal', cylG(0.13, 0.13, 0.08, 16), { at: [PIVOT[0], PIVOT[1], PIVOT[2]] });
  for (const tip of tips) {
    const elbow = cableArmElbow(tip);
    const tipP: Vec3 = [tip.x, PIVOT[1], tip.z];
    p.add('body', strutG(PIVOT, elbow, D.arm.widthM, D.arm.heightM));
    p.add('body', strutG(elbow, tipP, D.arm.widthM * 0.85, D.arm.heightM * 0.85));
    // The elbow and tip pivots, the balancer hanging under the tip.
    p.add('metal', cylG(0.09, 0.09, D.arm.heightM + 0.06, 14), { at: elbow });
    p.add('metal', cylG(0.06, 0.06, D.arm.heightM + 0.04, 12), { at: tipP });
    const b = D.balancer;
    const bTop = D.armY - D.arm.heightM / 2;
    p.add('metal', rodG([tip.x, bTop, tip.z], [tip.x, bTop - b.dropM, tip.z], 0.012));
    p.add('body', cylG(b.radiusM, b.radiusM, b.heightM, 14), {
      at: [tip.x, bTop - b.dropM - b.heightM / 2, tip.z],
      rot: [0, 0, Math.PI / 2],
    });
    p.add('trim', cylG(0.025, 0.025, 0.05, 8), { at: cableArmOutlet(tip) });
    // The cable along the arm, held in saddles on its top.
    const route = cableArmRoute(tip);
    for (let i = 1; i < route.length; i += 1) {
      const a = route[i - 1];
      const c = route[i];
      if (a != null && c != null) p.add('rubber', rodG(a, c, 0.035, 8));
    }
    for (const t of [0.25, 0.5, 0.75]) {
      const at: Vec3 = [
        PIVOT[0] + (elbow[0] - PIVOT[0]) * t,
        D.armY + D.arm.heightM / 2 + 0.02,
        PIVOT[2] + (elbow[2] - PIVOT[2]) * t,
      ];
      p.add('trim', boxG(0.1, 0.04, 0.1), { at });
    }
  }
  return p.kit();
}

/** The dispenser and its arms as a group. */
export function buildBusDispenser(
  materials: DepotMaterials,
  tips: readonly CableArmTip[],
): THREE.Group {
  return buildDepotGroup(createBusDispenserKit(tips), materials, 'bus-dispenser');
}
