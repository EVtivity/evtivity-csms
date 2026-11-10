// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The DC split system satellite (one charging output fed from the power
// cabinet on the equipment pad): a slim column with rounded vertical edges on
// a plinth and an anchored base plate, a sloped top cap, the screen and the
// status light high on the front, a front plate the scene tints, holster
// rails on both side walls, a cable gland at the base and the logo area on
// the back. The scene adds the holsters, handles and cables
// (`site-layout-connectors.ts`), the screen message and the glow.
//
// Frame: origin at the footprint center on the ground, the front faces +z,
// x across it, standing on y = 0.

import { addCableGland } from './site-layout-model-cable-gland';
import { roundedRect } from './site-layout-model-charger-parts';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  planPrismG,
  polyTubeG,
  roundBoxG,
  sideProfileG,
  type Vec3,
} from './site-layout-model-kit';
import type { PowerKit, PowerSlot } from './site-layout-model-power-slots';

/**
 * Kempower S-Series Charging Satellite, Technical Datasheet North America
 * (2022): single satellite 300 x 1518 x 300 mm (W x H x D),
 * https://www.nee.ca/wp-content/uploads/2023/08/Kempower-S-Series-ETL-Datasheet-Rev-2.2-0622.pdf.
 * Derived, no published value: the edge radius is 300 / 7.5 = 40 mm (the
 * rounded edges of the product photos); the plinth and the base plate take
 * the bottom 90 mm (6 percent of the height) and the cap the top 60 mm; the
 * screen (200 x 150 mm, center 1.3 m) and the holster height (1.12 m) are the
 * scene's, inside the 0.38 to 1.22 m reach range of the 2010 ADA Standards
 * 308.2 and 308.3 for the holster.
 */
export const SPLIT_SATELLITE = {
  widthM: 0.3,
  heightM: 1.518,
  depthM: 0.3,
  edgeM: 0.04,
  basePlate: { sizeM: 0.34, thickM: 0.01 },
  plinth: { sizeM: 0.27, heightM: 0.08 },
  capM: 0.06,
  screen: { widthM: 0.2, heightM: 0.15, yM: 1.3 },
  light: { widthM: 0.22, heightM: 0.014, yM: 1.43 },
  /** The tinted front plate below the screen. */
  plate: { widthM: 0.24, bottomM: 0.17, topM: 1.12 },
  holsterYM: 1.12,
  /** The holster rail on each side wall: its height range and depth center. */
  rail: { bottomM: 0.72, topM: 1.22, zM: 0.04, depthM: 0.06, thickM: 0.008 },
  /** The logo area on the back: center height, size. */
  logo: { yM: 1.1, widthM: 0.22, heightM: 0.3 },
} as const;

/** Where the RFID pad mounts: on the front plate under the screen, its center 1.05 m up (2010 ADA 308 reach). */
export const SATELLITE_RFID_PAD: Vec3 = [0, 1.05, SPLIT_SATELLITE.depthM / 2 + 0.006];

/** A holster cup on the side wall (`side` -1 left, 1 right), `dropM` below the top holster. */
export function satelliteHolsterMount(
  side: -1 | 1,
  dropM: number,
): { x: number; y: number; z: number } {
  const s = SPLIT_SATELLITE;
  return { x: side * (s.widthM / 2 + 0.015), y: s.holsterYM - dropM, z: s.rail.zM };
}

/** A charging cable gland on a side wall (`satelliteGland`, site-layout-satellite-cables.ts). */
export interface SatelliteGland {
  at: Vec3;
  axis: Vec3;
  cableDiameterM: number;
}

export function createSplitSatelliteKit(glands: readonly SatelliteGland[] = []): PowerKit {
  const s = SPLIT_SATELLITE;
  const p = new ModelParts<PowerSlot>();
  const hw = s.widthM / 2;
  const hd = s.depthM / 2;
  // The base plate with its four anchor nuts.
  const bp = s.basePlate;
  p.add('metal', boxG(bp.sizeM, bp.thickM, bp.sizeM), { at: [0, bp.thickM / 2, 0] });
  const a = bp.sizeM / 2 - 0.02;
  for (const [dx, dz] of [
    [-a, -a],
    [a, -a],
    [-a, a],
    [a, a],
  ] as const) {
    p.add('metal', cylG(0.011, 0.011, 0.014, 6), { at: [dx, bp.thickM + 0.007, dz] });
  }
  // The plinth, set back from the body.
  const pl = s.plinth;
  p.add('trim', planPrismG(roundedRect(pl.sizeM, pl.sizeM, 0.03, 2), pl.heightM), {
    at: [0, bp.thickM, 0],
  });
  // The body column with its rounded vertical edges.
  const bodyBottom = bp.thickM + pl.heightM;
  const bodyTop = s.heightM - s.capM;
  p.add('body', planPrismG(roundedRect(s.widthM, s.depthM, s.edgeM, 4), bodyTop - bodyBottom), {
    at: [0, bodyBottom, 0],
  });
  // The cap, 5 mm over each side, sloping down to the front.
  const o = 0.005;
  p.add(
    'body',
    sideProfileG(
      [
        [-hd - o, bodyTop],
        [hd + o, bodyTop],
        [hd + o, s.heightM - 0.015],
        [-hd - o, s.heightM],
      ],
      s.widthM + 2 * o,
      0.006,
    ),
  );
  p.add('trim', boxG(s.widthM - 0.01, 0.006, s.depthM - 0.01), { at: [0, bodyTop + 0.003, 0] });
  // The front plate the scene tints.
  const pt = s.plate;
  p.add('plate', frontProfileG(roundedRect(pt.widthM, pt.topM - pt.bottomM, 0.03), 0.006), {
    at: [0, (pt.bottomM + pt.topM) / 2, hd + 0.003],
  });
  // The screen in its bezel, and the status light above it.
  const sc = s.screen;
  p.add('trim', roundBoxG(sc.widthM + 0.03, sc.heightM + 0.03, 0.01, 0.006), {
    at: [0, sc.yM, hd + 0.005],
  });
  p.add('glass', boxG(sc.widthM, sc.heightM, 0.004), { at: [0, sc.yM, hd + 0.011] });
  p.add('light', boxG(s.light.widthM, s.light.heightM, 0.006), { at: [0, s.light.yM, hd + 0.003] });
  // The holster rails on both side walls, three bolts each.
  const r = s.rail;
  for (const side of [-1, 1]) {
    const x = side * (hw + r.thickM / 2);
    p.add('metal', boxG(r.thickM, r.topM - r.bottomM, r.depthM), {
      at: [x, (r.bottomM + r.topM) / 2, r.zM],
    });
    for (const y of [r.bottomM + 0.03, (r.bottomM + r.topM) / 2, r.topM - 0.03]) {
      p.add('trim', cylG(0.006, 0.006, 0.004, 6), {
        at: [x + side * (r.thickM / 2 + 0.002), y, r.zM],
        rot: [0, 0, Math.PI / 2],
      });
    }
  }
  // The back: the service door with its key lock and the logo area above it.
  p.add('door', roundBoxG(0.25, 0.77, 0.006, 0.004), { at: [0, 0.515, -hd - 0.003] });
  p.add('metal', cylG(0.009, 0.009, 0.01, 10), {
    at: [0.09, 0.82, -hd - 0.008],
    rot: [Math.PI / 2, 0, 0],
  });
  const lg = s.logo;
  p.add('label', roundBoxG(lg.widthM, lg.heightM, 0.004, 0.003), {
    at: [0, lg.yM, -hd - 0.002],
  });
  // The cable gland through the back of the plinth, its conduit down into the ground.
  const gy = bp.thickM + pl.heightM / 2;
  const gz = -pl.sizeM / 2;
  p.add('trim', cylG(0.022, 0.022, 0.03, 12), {
    at: [0, gy, gz - 0.015],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add('trim', cylG(0.028, 0.028, 0.012, 6), {
    at: [0, gy, gz - 0.006],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add(
    'conduit',
    polyTubeG(
      [
        [0, gy, gz - 0.03],
        [0, gy, -hd - 0.05],
        [0, -0.05, -hd - 0.05],
      ],
      0.016,
      10,
    ),
  );
  // A gland where each charging cable leaves its side wall.
  for (const g of glands) {
    addCableGland(
      p,
      { nut: 'metal', dome: 'trim', relief: 'trim' },
      g.at,
      g.axis,
      g.cableDiameterM,
    );
  }
  return p.kit();
}
