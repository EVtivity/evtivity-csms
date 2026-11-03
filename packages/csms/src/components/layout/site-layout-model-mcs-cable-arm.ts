// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cable management arm of a megawatt (MCS) truck dispenser (owner rule
// 2026-11-02: the heavy MCS cable rides on an arm): a steel pole on the lane
// island beside the dispenser, a slewing head on top, a boom on it that
// swings over the lane, the cable resting along the boom in saddles, round a
// curved tip guide and down from its outlet beside a spring balancer. The
// arm takes the cable's weight off the driver; idle, the boom stows toward
// the dispenser face and the cable hangs into the holstered handle; charging,
// it swings toward the truck inlet.
//
// Frame: the pole stands at the origin on y = 0; the boom points along +x
// before the scene turns it (`MCS_ARM.yaw` about the pole axis).

import { CABLE_MIN_BEND_RATIO } from './site-layout-model-cable-gland';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  roundBoxG,
  type ModelKit,
  type Pt,
  type Vec3,
} from './site-layout-model-kit';
import { rodG, strutG, type DepotSlot } from './site-layout-model-scissor';

/**
 * The arm. Why: an MCS connector with its cable "may exceed 10 kg", above
 * manual handling limits, and CharIN names a retractable cable management
 * system or a gantry for it (CharIN MCS Whitepaper 2.0, page 18; Charging
 * Site Recommendations 1.0, page 9); Kempower and Siemens sell MCS
 * dispensers with cable management (Kempower Mega Satellite, cable reach
 * 2.7 m), no maker publishes its dimensions. Derived: the boom 1.5 m, the
 * MCS cable reach of the ABB MCS1200 (data sheet: cable 2.4 m, reach 1.5 m);
 * the pivot at 3.0 m, 0.68 m above the 2.32 m dispenser so the boom swings
 * over it, the outlet and the balancer under the tip guide (about 2.4 m) above
 * the 80 in (2.03 m) vertical clearance of the 2010 ADA Standards 307.4; a
 * 0.16 m square pole; the balancer 0.15 m under the outlet on its rod beside
 * the cable. The tip guide turns the cable down in a quarter turn of six cable
 * diameters (`CABLE_MIN_BEND_RATIO`), so the outlet stands that far past the tip. The hanging cable is 3.18 m,
 * the median of the published MCS cable lengths (ABB MCS1200 2.4 m, Tesla
 * Megacharger 3 m, alpitronic HYC1000 MCS dispenser 3.35 m, Power
 * Electronics NB MCS 4 m; research 2026-11-03), the balancer taking up the
 * slack so it never hangs lower than the floor the scene gives.
 */
export const MCS_ARM = {
  pivotY: 3.0,
  boomM: 1.5,
  pole: { sizeM: 0.16 },
  boom: { widthM: 0.1, heightM: 0.12 },
  balancer: { dropM: 0.15, radiusM: 0.07, lengthM: 0.22 },
  /** The cable hanging below the tip guide outlet. */
  cableM: 3.18,
  /**
   * Where the pole stands from the dispenser center: beside its -x side wall
   * on the island, the side the truck arrives from, so the boom reaches
   * forward along the lane to the inlet just past the dispenser.
   */
  poleFromDispenser: { x: -0.65, z: 0 },
} as const;

/** The boom tip, in the arm frame, for a boom turned by `yaw` (radians, from +x toward +z). */
export function mcsArmTip(yaw: number): Vec3 {
  return [Math.cos(yaw) * MCS_ARM.boomM, MCS_ARM.pivotY, Math.sin(yaw) * MCS_ARM.boomM];
}

/** The smallest bend of the MCS cable: six cable diameters (`CABLE_MIN_BEND_RATIO`). */
export function mcsArmBendM(cableDiameterM: number): number {
  return CABLE_MIN_BEND_RATIO * cableDiameterM;
}

/** The height of the cable's center line where it rests on the saddles along the boom top. */
export function mcsArmCableTopY(cableDiameterM: number): number {
  return MCS_ARM.pivotY + MCS_ARM.boom.heightM / 2 + SADDLE_M + cableDiameterM / 2;
}

/** The saddle height on the boom top. */
const SADDLE_M = 0.035;

/**
 * The cable on the boom, in the boom frame (along +x, before the yaw): out
 * of the slewing head along the boom top, over the saddles, round the tip
 * guide in a quarter turn of the smallest bend (`mcsArmBendM`) and down to
 * the guide's outlet, where it leaves pointing straight down.
 */
export function mcsArmBoomCable(cableDiameterM: number): Vec3[] {
  const top = mcsArmCableTopY(cableDiameterM);
  const R = mcsArmBendM(cableDiameterM);
  const L = MCS_ARM.boomM;
  const pts: Vec3[] = [];
  for (let x = 0.12; x < L; x += 0.05) pts.push([x, top, 0]);
  const n = Math.ceil(((Math.PI / 2) * R) / 0.05);
  for (let i = 0; i <= n; i += 1) {
    const a = Math.PI / 2 - (Math.PI / 2) * (i / n);
    pts.push([L + R * Math.cos(a), top - R + R * Math.sin(a), 0]);
  }
  return pts;
}

/**
 * Where the cable leaves the tip guide, pointing straight down, in the arm
 * frame for a boom turned by `yaw`: one bend radius past the boom tip.
 */
export function mcsArmOutlet(yaw: number, cableDiameterM: number): Vec3 {
  const R = mcsArmBendM(cableDiameterM);
  const reach = MCS_ARM.boomM + R;
  return [Math.cos(yaw) * reach, mcsArmCableTopY(cableDiameterM) - R, Math.sin(yaw) * reach];
}

/** The pole, its base plate and the slewing head (fixed). */
export function createMcsArmPoleKit(): ModelKit<DepotSlot> {
  const A = MCS_ARM;
  const p = new ModelParts<DepotSlot>();
  const s = A.pole.sizeM;
  // The base plate with four anchor bolts on the island.
  p.add('metal', boxG(0.34, 0.02, 0.34), { at: [0, 0.01, 0] });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.add('metal', cylG(0.012, 0.012, 0.05, 6), { at: [sx * 0.13, 0.035, sz * 0.13] });
    }
  }
  const poleH = A.pivotY - 0.1;
  p.add('body', roundBoxG(s, poleH, s, 0.012), { at: [0, 0.02 + poleH / 2, 0] });
  // The cable entry from the dispenser: a conduit box low on the pole, on the dispenser side.
  p.add('trim', boxG(0.12, 0.2, s + 0.03), { at: [s / 2 + 0.03, 0.45, 0] });
  // The slewing head: a cap, the bearing ring and the turning collar.
  p.add('trim', boxG(s + 0.04, 0.03, s + 0.04), { at: [0, A.pivotY - 0.085, 0] });
  p.add('metal', cylG(0.11, 0.11, 0.06, 18), { at: [0, A.pivotY - 0.04, 0] });
  return p.kit();
}

/**
 * The boom along +x from the slewing head: a tapered box section with the
 * collar, the three saddles the cable rests on, the curved tip guide with its
 * outlet ring, and the spring balancer beside the outlet.
 */
export function createMcsArmBoomKit(cableDiameterM: number): ModelKit<DepotSlot> {
  const A = MCS_ARM;
  const p = new ModelParts<DepotSlot>();
  const y = A.pivotY;
  const L = A.boomM;
  p.add('metal', cylG(0.1, 0.1, A.boom.heightM + 0.04, 18), { at: [0, y, 0] });
  p.add('body', strutG([0, y, 0], [L * 0.55, y, 0], A.boom.widthM, A.boom.heightM));
  p.add('body', strutG([L * 0.55, y, 0], [L, y, 0], A.boom.widthM * 0.85, A.boom.heightM * 0.85));
  // An end cap and the tip pivot.
  p.add('trim', boxG(0.02, A.boom.heightM * 0.9, A.boom.widthM * 0.9), { at: [L + 0.01, y, 0] });
  p.add('metal', cylG(0.04, 0.04, A.boom.heightM + 0.03, 12), { at: [L - 0.05, y, 0] });
  // The saddles the cable rests on along the boom top (the scene draws the
  // cable itself, one piece from the head to the handle).
  for (const t of [0.25, 0.55, 0.85]) {
    p.add('trim', boxG(0.06, SADDLE_M, A.boom.widthM + 0.02), {
      at: [L * t, y + A.boom.heightM / 2 + SADDLE_M / 2, 0],
    });
  }
  // The tip guide: two curved cheeks either side of the cable, a quarter
  // turn of the cable's smallest bend round from the boom top to the outlet,
  // bolted to the boom end, and the outlet ring at its lower end.
  const R = mcsArmBendM(cableDiameterM);
  const r = cableDiameterM / 2;
  const top = mcsArmCableTopY(cableDiameterM);
  const sector: Pt[] = [];
  const n = 12;
  for (let i = 0; i <= n; i += 1) {
    const a = (Math.PI / 2) * (i / n);
    sector.push([(R + r + 0.03) * Math.cos(a), (R + r + 0.03) * Math.sin(a)]);
  }
  for (let i = n; i >= 0; i -= 1) {
    const a = (Math.PI / 2) * (i / n);
    sector.push([(R - r - 0.02) * Math.cos(a), (R - r - 0.02) * Math.sin(a)]);
  }
  for (const side of [-1, 1]) {
    p.add('body', frontProfileG(sector, 0.008), {
      at: [L, top - R, side * (r + 0.012) - 0.004],
    });
  }
  const out: Vec3 = [L + R, top - R, 0];
  p.add('trim', cylG(r + 0.012, r + 0.012, 0.05, 10), { at: [out[0], out[1] - 0.02, 0] });
  // The spring balancer beside the outlet, its drum hung from the guide on a rod.
  const b = A.balancer;
  const bz = r + 0.012 + b.lengthM / 2 + 0.02;
  p.add('trim', boxG(0.05, 0.03, bz - r), { at: [out[0], out[1] + 0.05, (bz + r) / 2] });
  p.add('metal', rodG([out[0], out[1] + 0.05, bz], [out[0], out[1] - b.dropM, bz], 0.01));
  p.add('body', cylG(b.radiusM, b.radiusM, b.lengthM, 16), {
    at: [out[0], out[1] - b.dropM - b.radiusM, bz],
    rot: [Math.PI / 2, 0, 0],
  });
  return p.kit();
}
