// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The three-phase pad-mounted transformer of the 3D site layout, generic and
// typical of the class (for example Eaton and ERMCO units; IEEE C57.12.34 outline,
// C57.12.28 enclosure integrity): the oil tank at the back with panel
// radiators on its sides and back, lifting lugs at the cover corners, the
// termination cabinet in front with a sloped hood, two doors (high voltage
// left, low voltage right), the penta-head bolt in its recessed pocket and
// the padlock hasp C57.12.28 asks for, a nameplate and the warning label.
//
// Frame: the cabinet doors face +z, x across them, standing on y = 0 (the
// bottom of the concrete pad), centered on the pad. Envelope kept from the
// scene: pad 2.9 by 2.5 m, 0.16 m high; enclosure 2.0 m wide and 1.77 m high
// above grade (a 500 kVA Eaton unit is about 1.8 m wide, 1.5 m high above its
// pad), radiators out to 1.16 m from the center.

import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  roundBoxG,
  sideProfileG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';
import { addWarningSign } from './site-layout-model-warning-sign';

export const TRANSFORMER_SLOTS = [
  'concrete',
  'body',
  'fin',
  'seam',
  'metal',
  'plate',
  'sign',
  'ink',
] as const;
export type TransformerSlot = (typeof TRANSFORMER_SLOTS)[number];

export const PAD_MOUNT_TRANSFORMER = {
  pad: { widthM: 2.9, depthM: 2.5, heightM: 0.16 },
  widthM: 2.0,
  /** The tank, from its back wall to the cabinet. */
  tank: { backZ: -0.75, frontZ: 0.15, topY: 1.7 },
  /** The cabinet front and the hood at its front and back edge. */
  cabinet: { frontZ: 0.78, hoodFrontY: 1.5, hoodBackY: 1.62 },
  /** Panel radiators: out from the wall, spacing. */
  radiator: { outM: 0.14, pitchM: 0.09, thickM: 0.022, bottomY: 0.34, topY: 1.48 },
  /** The penta-head bolt (C57.12.28) and the hasp on the right door. */
  latch: { x: 0.16, y: 0.95 },
} as const;

export type TransformerKit = ModelKit<TransformerSlot>;

/** The pad-mounted transformer on its pad (see the file comment for the frame). */
export function createPadMountTransformerKit(): TransformerKit {
  const t = PAD_MOUNT_TRANSFORMER;
  const p = new ModelParts<TransformerSlot>();
  const y0 = t.pad.heightM;
  const hw = t.widthM / 2;
  // The pad, its top edges chamfered.
  const pd = t.pad.depthM / 2;
  p.add(
    'concrete',
    sideProfileG(
      [
        [-pd, 0],
        [pd, 0],
        [pd, y0 - 0.02],
        [pd - 0.02, y0],
        [-pd + 0.02, y0],
        [-pd, y0 - 0.02],
      ],
      t.pad.widthM,
    ),
  );
  // The base sills the tank and cabinet stand on.
  for (const z of [t.tank.backZ + 0.05, t.cabinet.frontZ - 0.05]) {
    p.add('seam', boxG(t.widthM - 0.04, 0.05, 0.08), { at: [0, y0 + 0.025, z] });
  }
  const b = y0 + 0.05;
  // The tank and its bolted cover flange.
  const tankD = t.tank.frontZ - t.tank.backZ;
  const tankZ = (t.tank.frontZ + t.tank.backZ) / 2;
  p.add('body', roundBoxG(t.widthM, t.tank.topY - b, tankD, 0.03), {
    at: [0, (t.tank.topY + b) / 2, tankZ],
  });
  p.add('body', boxG(t.widthM + 0.04, 0.025, tankD + 0.04), {
    at: [0, t.tank.topY + 0.0125, tankZ],
  });
  for (let i = 0; i < 8; i++) {
    const x = -hw + 0.1 + (i * (t.widthM - 0.2)) / 7;
    for (const z of [t.tank.backZ - 0.005, t.tank.frontZ - 0.03]) {
      p.add('metal', cylG(0.011, 0.011, 0.012, 6), { at: [x, t.tank.topY + 0.031, z] });
    }
  }
  // The pressure relief valve and the fill plug on the cover.
  p.add('metal', cylG(0.035, 0.04, 0.05, 12), { at: [0.55, t.tank.topY + 0.05, tankZ] });
  p.add('metal', cylG(0.025, 0.025, 0.03, 8), { at: [-0.55, t.tank.topY + 0.04, tankZ] });
  // Lifting lugs at the four cover corners: a plate with an eye.
  const lug: Pt[] = [
    [-0.06, 0],
    [0.06, 0],
    [0.04, 0.09],
    [-0.04, 0.09],
  ];
  const eye: Pt[] = [
    [-0.018, 0.035],
    [-0.018, 0.065],
    [0.018, 0.065],
    [0.018, 0.035],
  ];
  for (const x of [-hw + 0.1, hw - 0.1]) {
    for (const z of [t.tank.backZ + 0.08, t.tank.frontZ - 0.1]) {
      p.add('fin', frontProfileG(lug, 0.02, 0, [eye]), { at: [x, t.tank.topY + 0.025, z] });
    }
  }
  // Panel radiators on both sides and the back, joined by headers.
  const r = t.radiator;
  const fin: Pt[] = [
    [0, r.bottomY - 0.02],
    [r.outM * 0.7, r.bottomY],
    [r.outM, r.bottomY + 0.06],
    [r.outM, r.topY - 0.06],
    [r.outM * 0.7, r.topY],
    [0, r.topY + 0.02],
  ];
  const sideFins = 9;
  const z0 = t.tank.backZ + 0.08;
  for (const side of [-1, 1]) {
    for (let i = 0; i < sideFins; i++) {
      p.add('fin', frontProfileG(fin, r.thickM), {
        at: [side * hw, 0, z0 + i * r.pitchM],
        rot: [0, side > 0 ? 0 : Math.PI, 0],
      });
    }
    const len = (sideFins - 1) * r.pitchM + 0.06;
    for (const y of [r.bottomY + 0.03, r.topY - 0.03]) {
      p.add('fin', cylG(0.03, 0.03, len, 8), {
        at: [side * (hw + 0.035), y, z0 + ((sideFins - 1) * r.pitchM) / 2],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  const backFins = 15;
  const backOut = 0.1;
  const backFin: Pt[] = fin.map(([o, y]) => [(o / r.outM) * backOut, y] as const);
  const bx0 = -((backFins - 1) * r.pitchM) / 2;
  for (let i = 0; i < backFins; i++) {
    p.add('fin', frontProfileG(backFin, r.thickM), {
      at: [bx0 + i * r.pitchM, 0, t.tank.backZ],
      rot: [0, Math.PI / 2, 0],
    });
  }
  for (const y of [r.bottomY + 0.03, r.topY - 0.03]) {
    p.add('fin', cylG(0.028, 0.028, (backFins - 1) * r.pitchM + 0.06, 8), {
      at: [0, y, t.tank.backZ - 0.03],
      rot: [0, 0, Math.PI / 2],
    });
  }
  // A ground pad and the drain valve low on the tank side.
  p.add('metal', boxG(0.012, 0.08, 0.12), { at: [hw + 0.006, b + 0.2, t.tank.frontZ - 0.06] });
  p.add('metal', cylG(0.02, 0.02, 0.06, 8), {
    at: [-hw - 0.03, b + 0.18, t.tank.frontZ - 0.07],
    rot: [0, 0, Math.PI / 2],
  });
  // The cabinet in front of the tank, its hood sloping down to the doors.
  const c = t.cabinet;
  p.add(
    'body',
    sideProfileG(
      [
        [t.tank.frontZ - 0.02, b],
        [c.frontZ, b],
        [c.frontZ, c.hoodFrontY],
        [t.tank.frontZ - 0.02, c.hoodBackY],
      ],
      t.widthM,
      0.008,
    ),
  );
  p.add(
    'body',
    sideProfileG(
      [
        [t.tank.frontZ - 0.05, c.hoodBackY - 0.005],
        [c.frontZ + 0.05, c.hoodFrontY - 0.02],
        [c.frontZ + 0.05, c.hoodFrontY + 0.01],
        [t.tank.frontZ - 0.05, c.hoodBackY + 0.025],
      ],
      t.widthM + 0.06,
    ),
  );
  // The hood drip lip and the cabinet sill.
  p.add('body', boxG(t.widthM + 0.06, 0.05, 0.012), {
    at: [0, c.hoodFrontY - 0.03, c.frontZ + 0.044],
  });
  p.add('seam', boxG(t.widthM, 0.06, 0.03), { at: [0, b + 0.03, c.frontZ + 0.005] });
  // Two doors with a seam between them and around them.
  const doorB = b + 0.08;
  const doorT = c.hoodFrontY - 0.07;
  const doorH = doorT - doorB;
  const doorY = (doorB + doorT) / 2;
  const doorW = hw - 0.03;
  for (const side of [-1, 1]) {
    p.add('body', roundBoxG(doorW, doorH, 0.014, 0.004), {
      at: [side * (doorW / 2 + 0.01), doorY, c.frontZ + 0.007],
    });
    // Three stainless hinges on the outer edge.
    for (const f of [0.15, 0.5, 0.85]) {
      p.add('metal', cylG(0.012, 0.012, 0.09, 8), {
        at: [side * (hw - 0.012), doorB + f * doorH, c.frontZ + 0.016],
      });
    }
  }
  p.add('seam', boxG(0.02, doorH, 0.004), { at: [0, doorY, c.frontZ + 0.002] });
  p.add('seam', boxG(t.widthM - 0.02, 0.012, 0.004), { at: [0, doorT + 0.012, c.frontZ + 0.002] });
  // The latch handle, the penta-head bolt in its pocket and the padlock hasp.
  const l = t.latch;
  const front = c.frontZ + 0.014;
  p.add('seam', cylG(0.032, 0.032, 0.006, 16), {
    at: [l.x, l.y, front + 0.003],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add('metal', cylG(0.013, 0.013, 0.022, 5), {
    at: [l.x, l.y, front + 0.008],
    rot: [Math.PI / 2, 0, 0],
  });
  p.add('metal', boxG(0.035, 0.2, 0.02), { at: [l.x + 0.09, l.y - 0.02, front + 0.01] });
  p.add('metal', boxG(0.12, 0.03, 0.03), { at: [l.x + 0.09, l.y - 0.13, front + 0.025] });
  p.add('metal', boxG(0.016, 0.06, 0.03), { at: [l.x + 0.2, l.y - 0.02, front + 0.015] });
  p.add('metal', boxG(0.016, 0.06, 0.03), { at: [l.x + 0.245, l.y - 0.02, front + 0.015] });
  p.add('metal', boxG(0.04, 0.045, 0.02), { at: [l.x + 0.222, l.y - 0.085, front + 0.04] });
  p.add('metal', cylG(0.005, 0.005, 0.04, 6), {
    at: [l.x + 0.222, l.y - 0.045, front + 0.04],
  });
  // The nameplate on the low voltage door with its engraved lines.
  p.add('plate', boxG(0.2, 0.13, 0.004), { at: [0.55, 1.22, front + 0.002] });
  for (let i = 0; i < 4; i++) {
    p.add('ink', boxG(0.15 - (i % 2) * 0.04, 0.008, 0.002), {
      at: [0.54 - (i % 2) * 0.02, 1.26 - i * 0.025, front + 0.005],
    });
  }
  // The warning label on each door (NEMA 260).
  addWarningSign(p, 'sign', 'ink', 0.3, { at: [-0.5, 1.15, front] });
  addWarningSign(p, 'sign', 'ink', 0.16, { at: [0.55, 0.7, front] });
  return p.kit();
}
