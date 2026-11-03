// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The NEMA 3R panelboard enclosure shared by the rack and the wall
// panelboard models: the box, the hinged door, the drip hood, the latch, the
// nameplate, the mounting flanges and the conduit hubs on the bottom.

import {
  ModelParts,
  boxG,
  cylG,
  roundBoxG,
  sideProfileG,
  type Vec3,
} from './site-layout-model-kit';
import type { PowerSlot } from './site-layout-model-power-slots';

/**
 * The enclosure of a 225 A, 42 space panelboard: 20 in (0.51 m) wide, 38 in
 * (0.97 m) high, 6.5 in (0.165 m) deep, NEMA 3R with a hinged door (Schneider
 * Electric NQ442L2C product data sheet, June 2023,
 * https://cdn.shopify.com/s/files/1/0571/5899/2039/files/NQ442L2C_document.pdf).
 * The hood, hinge, latch, flange and hub sizes have no source.
 */
export const NEMA3R_PANEL = {
  widthM: 0.51,
  heightM: 0.97,
  depthM: 0.165,
  doorM: 0.018,
  /** The drip hood over the door: how far it stands out of the front and over the sides. */
  hood: { outM: 0.03, sideM: 0.02, heightM: 0.03 },
  hingeRadiusM: 0.006,
  /** The bolt-on flanges behind the box, top and bottom. */
  flange: { overM: 0.03, heightM: 0.04, thickM: 0.004 },
  /** The conduits that leave the bottom: x position and outside diameter (2 in and 1-1/4 in RMC, ANSI C80.1). */
  conduits: [
    { x: -0.12, odM: 0.0603 },
    { x: 0.1, odM: 0.0422 },
  ],
} as const;

/** Where the scene puts the textured warning label on the door (center, facing +z). */
export interface PanelLabelSpot {
  at: Vec3;
  widthM: number;
  heightM: number;
}

/**
 * Adds the enclosure with its back at `backZ` and its bottom at `bottomY`,
 * centered on x = 0, the door facing +z. Returns the warning label spot.
 */
export function addNema3rEnclosure(
  p: ModelParts<PowerSlot>,
  bottomY: number,
  backZ: number,
): PanelLabelSpot {
  const e = NEMA3R_PANEL;
  const boxD = e.depthM - e.doorM;
  const midY = bottomY + e.heightM / 2;
  const top = bottomY + e.heightM;
  const front = backZ + e.depthM;
  // The box and the door, the door a little inside the box outline.
  p.add('body', roundBoxG(e.widthM, e.heightM, boxD, 0.006), { at: [0, midY, backZ + boxD / 2] });
  p.add('door', roundBoxG(e.widthM - 0.01, e.heightM - 0.012, e.doorM, 0.004), {
    at: [0, midY, backZ + boxD + e.doorM / 2],
  });
  // The drip hood: sloping forward and down over the door top.
  const h = e.hood;
  p.add(
    'body',
    sideProfileG(
      [
        [backZ, top],
        [front + h.outM, top],
        [front + h.outM, top + 0.008],
        [backZ, top + h.heightM],
      ],
      e.widthM + 2 * h.sideM,
      0.002,
    ),
  );
  // The hood side cheeks down over the box sides.
  for (const side of [-1, 1]) {
    p.add('body', boxG(0.003, 0.05, e.depthM + h.outM), {
      at: [side * (e.widthM / 2 + h.sideM - 0.0015), top - 0.025, backZ + (e.depthM + h.outM) / 2],
    });
  }
  // The continuous hinge on the left edge.
  p.add('metal', cylG(e.hingeRadiusM, e.hingeRadiusM, e.heightM - 0.04, 8), {
    at: [-e.widthM / 2 + 0.004, midY, front - e.doorM / 2],
  });
  // The latch with its padlock hasp on the right edge.
  p.add('trim', roundBoxG(0.032, 0.09, 0.012, 0.003), {
    at: [e.widthM / 2 - 0.04, midY, front + 0.006],
  });
  p.add('metal', boxG(0.014, 0.05, 0.016), {
    at: [e.widthM / 2 - 0.04, midY - 0.01, front + 0.012],
  });
  p.add('metal', boxG(0.026, 0.006, 0.02), {
    at: [e.widthM / 2 - 0.04, midY + 0.05, front + 0.012],
  });
  // The nameplate near the door top.
  p.add('label', boxG(0.14, 0.05, 0.003), { at: [0, top - 0.08, front + 0.0015] });
  // The mounting flanges behind the box, top and bottom.
  const f = e.flange;
  for (const y of [top - f.heightM / 2, bottomY + f.heightM / 2]) {
    p.add('metal', boxG(e.widthM + 2 * f.overM, f.heightM, f.thickM), {
      at: [0, y, backZ - f.thickM / 2],
    });
    for (const side of [-1, 1]) {
      p.add('metal', cylG(0.008, 0.008, 0.008, 6), {
        at: [side * (e.widthM / 2 + f.overM / 2), y, backZ + 0.002],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  // The conduit hubs on the bottom.
  for (const c of e.conduits) {
    p.add('conduit', cylG(c.odM / 2 + 0.008, c.odM / 2 + 0.008, 0.025, 12), {
      at: [c.x, bottomY - 0.0125, backZ + boxD / 2],
    });
  }
  return { at: [0, top - 0.22, front + 0.003], widthM: 0.16, heightM: 0.12 };
}

/** The x and z of each conduit leaving the enclosure bottom (for the conduit runs). */
export function nema3rConduitCenters(backZ: number): { x: number; z: number; odM: number }[] {
  const boxD = NEMA3R_PANEL.depthM - NEMA3R_PANEL.doorM;
  return NEMA3R_PANEL.conduits.map((c) => ({ x: c.x, z: backZ + boxD / 2, odM: c.odM }));
}
