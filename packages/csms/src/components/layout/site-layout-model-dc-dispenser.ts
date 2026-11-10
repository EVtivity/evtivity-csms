// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The all-in-one DC dispenser of the 3D site layout: its body kit. The scene
// adds holsters, handles, cables, readers, the logo and the glow.

import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  latheG,
  louversG,
  roundBoxG,
  sideProfileG,
  type Pt,
  type Vec3,
} from './site-layout-model-kit';
import { addCableGland } from './site-layout-model-cable-gland';
import {
  arc,
  roundedRect,
  seam,
  type ChargerKit,
  type ChargerSlot,
} from './site-layout-model-charger-parts';

/**
 * A generic all-in-one DC fast charger (150 to 400 kW). Its envelope is the
 * median of seven published units, derived (H x W x D, mm): ABB Terra 184
 * 1900 x 565 x 880, Tritium PKM150 1998 x 783 x 309, alpitronic HYC300
 * 2235 x 732 x 663, alpitronic HYC400 2185 x 732 x 663, BTC Power Gen 4
 * 180 kW 2187 x 820 x 770, Wallbox Supernova 180 2000 x 453 x 714 and Delta
 * UFC 200 2079 x 859 x 998, so 2079 high, 732 wide and 714 deep. Features
 * typical of the class (for example the ABB Terra 184 product guide and the
 * alpitronic HYC300 brief): a base cover, front and side doors, a 7 in touch
 * screen in the upper front, the RFID reader and an emergency stop on the
 * front, the air inlet low on the front and the outlet high on the sides, a
 * cable outlet and holder on each side. The light strip, rain hood, seams
 * and louvers are sized from the envelope.
 */
export const DC_DISPENSER = {
  widthM: 0.732,
  depthM: 0.714,
  heightM: 2.079,
  /** The front face in the station frame (the body runs back from it). */
  frontZ: 0.34,
  plinthM: 0.08,
  /** The 7 in 16:9 screen (155 by 87 mm active area): center height, width and height. */
  screen: { y: 1.47, widthM: 0.155, heightM: 0.087 },
  /**
   * The RFID reader pad below the screen (site-layout-model-rfid-pad.ts, the
   * scene adds it): its center 1.14 m up, the pad's top inside the 48 in
   * (1.22 m) high reach of the 2010 ADA Standards 308.2.1.
   */
  rfid: { y: 1.14 },
  /** The emergency stop push button (a red mushroom head on a yellow ring). */
  stop: { x: 0.24, y: 1.62 },
  /** The status light strip above the screen. */
  lightY: 1.95,
} as const;

/** Where the RFID pad mounts: on the fascia face below the screen (the fascia 10 mm proud of the front). */
export const DC_RFID_PAD: Vec3 = [0, DC_DISPENSER.rfid.y, DC_DISPENSER.frontZ + 0.01];

/** Where a DC dispenser's side wall is (holsters and cable glands), in x. */
export const DC_SIDE_X = DC_DISPENSER.widthM / 2;

/** The charger slots a cable gland's parts go in. */
export const GLAND_SLOTS = { nut: 'metal', dome: 'trim', relief: 'rubber' } as const;

/**
 * The vent grilles on each side wall of a DC dispenser, in the station frame:
 * the hot air outlet at the top back (the inlet is the grille low on the front).
 */
type VentRect = { yMin: number; yMax: number; zMin: number; zMax: number };
export const DC_SIDE_OUTLET: VentRect = { yMin: 1.72, yMax: 1.9, zMin: -0.34, zMax: -0.06 };
export const DC_SIDE_VENTS: readonly VentRect[] = [DC_SIDE_OUTLET];

/** The front holster on a DC dispenser side wall: its mount (all holsters at this height). */
export const DC_HOLSTER = { y: 1.1, z: 0.1 } as const;

/**
 * Where the cable gland of a holster on a DC dispenser side wall stands: on
 * plain wall on the side (`DC_GLAND_Y_M`, under the handles and far below the outlet's 1.72 m),
 * pointing straight out, between the two loops of the side and outside
 * both: 0.07 m behind the front holster, 0.09 m in front of a holster `backM`
 * behind it, so each cable comes up its own loop's inner edge, keeps to its
 * own stretch of the wall and two cables never cross.
 */
/**
 * The height of the DC cable glands: 0.8 m, under the handles' grips (their
 * lowest point near the wall about 1.05 m), so a cable bends down out of its
 * gland, hangs in a U and comes up into its hook clear of the pad. Derived.
 */
export const DC_GLAND_Y_M = 0.8;

export function dcGland(side: -1 | 1, backM: number): { at: Vec3; axis: Vec3 } {
  const z = backM > 0 ? DC_HOLSTER.z - backM + 0.09 : DC_HOLSTER.z - 0.07;
  return { at: [side * DC_SIDE_X, DC_GLAND_Y_M, z], axis: [side, 0, 0] };
}

/**
 * The z of a holster's J hook on the side wall: 0.17 m in front of the front
 * holster, 0.15 m behind a holster behind it, so the turns, parallel to the
 * wall, hang clear of the handles (a handle is about 0.05 m across) and of
 * each other's loops. Derived.
 */
export function dcHookZ(backM: number): number {
  return backM > 0 ? DC_HOLSTER.z - backM - 0.15 : DC_HOLSTER.z + 0.17;
}

/**
 * A DC dispenser body with a cable gland on its side walls for each holster
 * (`glands`: side, drop and the diameter of its cable).
 */
export function createDcDispenserKit(
  glands: ReadonlyArray<{ side: -1 | 1; backM: number; cableDiameterM: number }>,
): ChargerKit {
  const d = DC_DISPENSER;
  const p = new ModelParts<ChargerSlot>();
  const front = d.frontZ;
  const back = front - d.depthM;
  const base = d.plinthM;
  const top = d.heightM;
  // The side silhouette: a flat front, a rounded nose at the top front, a
  // roof falling slightly to the back for rain.
  const profile: Pt[] = [
    [back, base],
    [front, base],
    [front, top - 0.12],
    ...arc(front - 0.12, top - 0.12, 0.12, 0, Math.PI / 2, 5).slice(1),
    [back + 0.04, top - 0.015],
    [back, top - 0.05],
  ];
  p.add('shell', sideProfileG(profile, d.widthM, 0.02));
  // The plinth (a recessed dark base frame) and the anchor bolt covers at its corners.
  p.add('trim', roundBoxG(d.widthM - 0.04, base, d.depthM - 0.04, 0.01), {
    at: [0, base / 2, (front + back) / 2],
  });
  for (const sx of [-1, 1]) {
    for (const z of [front - 0.08, back + 0.08]) {
      p.add('metal', cylG(0.018, 0.022, 0.025, 10), {
        at: [sx * (d.widthM / 2 - 0.06), base + 0.0125, z],
      });
    }
  }
  // The dark front fascia, inset from the edges, from the kick plate to under the light.
  const fasciaH = d.lightY - 0.05 - 0.26;
  const fasciaY = 0.26 + fasciaH / 2;
  p.add('trim', frontProfileG(roundedRect(d.widthM - 0.07, fasciaH, 0.04), 0.012, 0.003), {
    at: [0, fasciaY, front + 0.004],
  });
  // The screen bezel and its glass, under a rain hood.
  const s = d.screen;
  p.add(
    'metal',
    frontProfileG(roundedRect(s.widthM + 0.05, s.heightM + 0.05, 0.015), 0.014, 0.003),
    {
      at: [0, s.y, front + 0.011],
    },
  );
  p.add('glass', boxG(s.widthM, s.heightM, 0.006), { at: [0, s.y, front + 0.019] });
  const hoodY = s.y + s.heightM / 2 + 0.035;
  p.add(
    'metal',
    sideProfileG(
      [
        [front, hoodY - 0.008],
        [front + 0.05, hoodY - 0.022],
        [front + 0.05, hoodY - 0.012],
        [front, hoodY + 0.014],
      ],
      s.widthM + 0.07,
      0.003,
    ),
  );
  // The status light strip and its housing above the screen.
  p.add('trim', frontProfileG(roundedRect(0.36, 0.04, 0.02), 0.012, 0.003), {
    at: [0, d.lightY, front + 0.006],
  });
  p.add('light', frontProfileG(roundedRect(0.32, 0.018, 0.009), 0.006), {
    at: [0, d.lightY, front + 0.013],
  });
  // The emergency stop: a yellow ring plate and the red mushroom head.
  p.add('warn', cylG(0.04, 0.04, 0.008, 18), {
    at: [d.stop.x, d.stop.y, front + 0.014],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add(
    'stop',
    latheG(
      [
        [0.001, 0.032],
        [0.02, 0.03],
        [0.027, 0.022],
        [0.027, 0.008],
        [0.012, 0.004],
        [0.012, 0],
      ],
      16,
    ),
    {
      at: [d.stop.x, d.stop.y, front + 0.018],
      rot: [Math.PI / 2, 0, 0],
    },
  );
  // The front door seam, the service lock, and the lower air inlet behind a grille.
  seam(p, d.widthM - 0.05, 1.7, [0, 1.0, front + 0.011]);
  p.add('metal', cylG(0.011, 0.011, 0.012, 10), {
    at: [0.17, 0.42, front + 0.016],
    rot: [Math.PI / 2, 0, 0],
  });
  // The air inlet: a grille low on the front.
  for (const slat of louversG(0.46, 0.18, 8)) {
    p.add('trim', slat, { at: [0, 0.38, front + 0.014] });
  }
  for (const side of [-1, 1] as const) {
    const sx = side * (d.widthM / 2);
    // The DC accent: a stripe down the front edge of each side.
    p.add('accent', boxG(0.006, 1.3, 0.05), { at: [sx + side * 0.002, 1.0, front - 0.05] });
    // The side service door: its seams.
    seam(p, d.depthM - 0.12, 1.56, [sx + side * 0.002, 0.98, (front + back) / 2], true);
    const vent = (v: VentRect): { h: number; w: number; y: number; z: number } => ({
      h: v.yMax - v.yMin,
      w: v.zMax - v.zMin,
      y: (v.yMin + v.yMax) / 2,
      z: (v.zMin + v.zMax) / 2,
    });
    // The hot air outlet at the top back of each side.
    const vo = vent(DC_SIDE_OUTLET);
    p.add('trim', boxG(0.008, vo.h, vo.w), { at: [sx + side * 0.001, vo.y, vo.z] });
    for (const slat of louversG(vo.w - 0.04, vo.h - 0.03, 5)) {
      p.add('shell', slat, {
        at: [sx + side * 0.006, vo.y, vo.z],
        rot: [0, (side * Math.PI) / 2, 0],
      });
    }
  }
  // A cable gland where each cable leaves its side wall (`dcGland`).
  for (const g of glands) {
    const at = dcGland(g.side, g.backM);
    addCableGland(p, GLAND_SLOTS, at.at, at.axis, g.cableDiameterM);
  }
  // The back: a service door seam and the cable entry plate low down.
  seam(p, d.widthM - 0.1, 1.8, [0, 1.08, back - 0.002]);
  p.add('trim', boxG(0.3, 0.14, 0.006), { at: [0, 0.2, back - 0.003] });
  return p.kit();
}
