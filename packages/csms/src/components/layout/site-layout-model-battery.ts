// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The battery storage cabinet of the 3D site layout, a generic container
// typical of the class (for example the Tesla Megapack 2 and the BYD MC Cube): a steel enclosure on a skid with front-access doors in bays
// (seams, recessed handles), a crowned roof, the status light strip high on
// the front, and a wall-mounted HVAC pack on one end (the BYD containerized
// layout) with a sloped hood, a fan guard of rings and spokes and condenser
// grilles; vents on the other end, stiffeners, a cable entry plate and the
// labels on the back.
//
// Frame: the doors face +z, x along the cabinet, the HVAC on the +x end,
// standing on y = 0 (the bottom of the pad), centered on the enclosure.
// Envelope kept from the scene: pad 4.0 by 2.0 m, 0.16 m high; enclosure
// 3.4 m long, 1.4 m deep, 2.44 m high above grade with the roof; HVAC out to
// 2.13 m from the center. Megapack 2 is 1.65 m deep and 2.79 m high
// (datasheet); the length is the scene footprint, not a Megapack's. Derived:
// three door bays, each a pair of leaves of a third of the length; the fan
// guard 0.6 of the HVAC depth, as wall-mount packs put their condenser fan.

import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  louversG,
  roundBoxG,
  sideProfileG,
  torusG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';
import { addWarningSign } from './site-layout-model-warning-sign';

export const BATTERY_SLOTS = [
  'concrete',
  'body',
  'door',
  'seam',
  'metal',
  'vent',
  'light',
  'plate',
  'sign',
  'ink',
] as const;
export type BatterySlot = (typeof BATTERY_SLOTS)[number];

export const BATTERY_CABINET = {
  pad: { widthM: 4.0, depthM: 2.0, heightM: 0.16 },
  lengthM: 3.4,
  depthM: 1.4,
  /** The skid under the enclosure. */
  skidM: 0.1,
  /** The enclosure top under the roof, and the roof crown. */
  bodyTopY: 2.36,
  roofTopY: 2.44,
  bays: 3,
  /** The HVAC pack on the +x end: out from the end wall, height, depth. */
  hvac: { outM: 0.4, bottomY: 0.5, topY: 2.05, depthM: 1.0 },
} as const;

export type BatteryKit = ModelKit<BatterySlot>;

/** The battery storage cabinet on its pad (see the file comment for the frame). */
export function createBatteryCabinetKit(): BatteryKit {
  const c = BATTERY_CABINET;
  const p = new ModelParts<BatterySlot>();
  const y0 = c.pad.heightM;
  const pd = c.pad.depthM / 2;
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
      c.pad.widthM,
    ),
  );
  const hl = c.lengthM / 2;
  const hd = c.depthM / 2;
  // The skid: rails front and back with cross members showing at the ends.
  for (const z of [-hd + 0.05, hd - 0.05]) {
    p.add('seam', boxG(c.lengthM, c.skidM, 0.1), { at: [0, y0 + c.skidM / 2, z] });
  }
  for (const x of [-hl + 0.05, 0, hl - 0.05]) {
    p.add('seam', boxG(0.1, c.skidM, c.depthM - 0.2), { at: [x, y0 + c.skidM / 2, 0] });
  }
  const b = y0 + c.skidM;
  p.add('body', roundBoxG(c.lengthM, c.bodyTopY - b, c.depthM, 0.04), {
    at: [0, (c.bodyTopY + b) / 2, 0],
  });
  // The crowned roof with its overhang.
  const rd = hd + 0.05;
  p.add(
    'body',
    sideProfileG(
      [
        [-rd, c.bodyTopY],
        [rd, c.bodyTopY],
        [rd, c.bodyTopY + 0.03],
        [0, c.roofTopY],
        [-rd, c.bodyTopY + 0.03],
      ],
      c.lengthM + 0.1,
      0.005,
    ),
  );
  // Door bays: two leaves per bay, seams, recessed handles.
  const bayW = c.lengthM / c.bays;
  const leafW = bayW / 2 - 0.03;
  const doorB = b + 0.1;
  const doorT = c.bodyTopY - 0.3;
  const doorH = doorT - doorB;
  const doorY = (doorB + doorT) / 2;
  const front = hd + 0.01;
  for (let i = 0; i < c.bays; i++) {
    const bx = -hl + (i + 0.5) * bayW;
    p.add('seam', boxG(bayW - 0.02, doorH + 0.03, 0.004), { at: [bx, doorY, hd + 0.002] });
    for (const side of [-1, 1]) {
      const lx = bx + side * (leafW / 2 + 0.008);
      p.add('door', roundBoxG(leafW, doorH, 0.016, 0.005), { at: [lx, doorY, hd + 0.008] });
      const hx = bx + side * 0.06;
      p.add('seam', roundBoxG(0.05, 0.2, 0.006, 0.01), { at: [hx, doorY, front + 0.001] });
      p.add('metal', roundBoxG(0.03, 0.16, 0.008, 0.008), { at: [hx, doorY, front + 0.004] });
    }
  }
  // The status light strip and its bezel, high on the right of the front.
  p.add('seam', boxG(0.56, 0.06, 0.012), { at: [hl - 0.45, c.bodyTopY - 0.15, front] });
  p.add('light', boxG(0.5, 0.025, 0.008), { at: [hl - 0.45, c.bodyTopY - 0.15, front + 0.008] });
  p.add('plate', boxG(0.22, 0.1, 0.004), { at: [-hl + 0.3, c.bodyTopY - 0.15, front] });
  // The left end: a vent grille in its frame.
  p.add('seam', boxG(0.006, 0.5, 0.8), { at: [-hl - 0.003, 1.6, 0] });
  for (const g of louversG(0.76, 0.46, 8)) {
    p.add('vent', g, { at: [-hl - 0.008, 1.6, 0], rot: [0, -Math.PI / 2, 0] });
  }
  // The back: vertical stiffeners, the cable entry plate, the labels.
  for (let i = 1; i < 6; i++) {
    p.add('body', boxG(0.06, c.bodyTopY - b - 0.2, 0.03), {
      at: [-hl + (i * c.lengthM) / 6, (c.bodyTopY + b) / 2, -hd - 0.015],
    });
  }
  p.add('metal', boxG(0.5, 0.3, 0.012), { at: [-hl + 0.6, b + 0.3, -hd - 0.006] });
  for (let i = 0; i < 3; i++) {
    p.add('seam', cylG(0.04, 0.04, 0.06, 12), {
      at: [-hl + 0.45 + i * 0.15, b + 0.3, -hd - 0.03],
      rot: [Math.PI / 2, 0, 0],
    });
  }
  p.add('metal', boxG(0.08, 0.04, 0.02), { at: [-hl + 1.0, b + 0.2, -hd - 0.01] });
  addWarningSign(p, 'sign', 'ink', 0.25, { at: [0.2, 1.7, -hd - 0.03], rot: [0, Math.PI, 0] });
  p.add('plate', boxG(0.3, 0.15, 0.004), { at: [0.8, 1.7, -hd - 0.032] });
  addHvac(p, hl);
  return p.kit();
}

// The wall-mounted HVAC pack on the +x end wall at x = `wallX`.
function addHvac(p: ModelParts<BatterySlot>, wallX: number): void {
  const h = BATTERY_CABINET.hvac;
  // Side outline in [out from the wall, y]: a sloped rain hood on top, a
  // chamfered bottom over the drain pan.
  const outline: Pt[] = [
    [0, h.bottomY],
    [h.outM - 0.07, h.bottomY],
    [h.outM, h.bottomY + 0.07],
    [h.outM, h.topY - 0.14],
    [h.outM - 0.09, h.topY - 0.02],
    [0, h.topY + 0.02],
  ];
  p.add('body', frontProfileG(outline, h.depthM, 0.01), { at: [wallX, 0, 0] });
  // The hood lip and the drain pan.
  p.add('body', boxG(0.11, 0.012, h.depthM + 0.04), {
    at: [wallX + h.outM - 0.05, h.topY - 0.06, 0],
    rot: [0, 0, -0.95],
  });
  p.add('seam', boxG(h.outM - 0.05, 0.03, h.depthM - 0.04), {
    at: [wallX + (h.outM - 0.05) / 2, h.bottomY - 0.015, 0],
  });
  // Mounting brackets to the wall.
  for (const z of [-h.depthM / 2 + 0.08, h.depthM / 2 - 0.08]) {
    p.add('metal', boxG(0.25, 0.06, 0.04), { at: [wallX + 0.12, h.bottomY - 0.06, z] });
  }
  // The condenser fan: a dark opening, the shroud ring, guard rings, spokes, hub.
  const face = wallX + h.outM;
  const fy = (h.bottomY + h.topY) / 2 - 0.08;
  const fr = (h.depthM * 0.6) / 2;
  const toX: readonly [number, number, number] = [0, Math.PI / 2, 0];
  p.add('seam', cylG(fr, fr, 0.01, 28), { at: [face + 0.001, fy, 0], rot: [0, 0, Math.PI / 2] });
  p.add('metal', torusG(fr, 0.018, 6, 28), { at: [face + 0.012, fy, 0], rot: toX });
  for (const k of [0.66, 0.33]) {
    p.add('metal', torusG(fr * k, 0.005, 4, 24), { at: [face + 0.02, fy, 0], rot: toX });
  }
  for (let i = 0; i < 4; i++) {
    p.add('metal', boxG(0.008, 2 * fr, 0.008), {
      at: [face + 0.02, fy, 0],
      rot: [(i * Math.PI) / 4, 0, 0],
    });
  }
  p.add('metal', cylG(0.05, 0.05, 0.03, 14), {
    at: [face + 0.022, fy, 0],
    rot: [0, 0, Math.PI / 2],
  });
  // Condenser coil grilles on both sides of the pack.
  for (const side of [-1, 1]) {
    const z = side * (h.depthM / 2 + 0.004);
    p.add('seam', boxG(h.outM - 0.12, 0.7, 0.004), {
      at: [wallX + h.outM / 2 - 0.02, fy, z],
    });
    for (const g of louversG(h.outM - 0.14, 0.66, 12, 0.01)) {
      p.add('vent', g, {
        at: [wallX + h.outM / 2 - 0.02, fy, z + side * 0.004],
        rot: [0, side > 0 ? 0 : Math.PI, 0],
      });
    }
  }
  // The service disconnect box under the pack.
  p.add('body', roundBoxG(0.12, 0.2, 0.2, 0.01), {
    at: [wallX + 0.06, h.bottomY - 0.2, h.depthM / 2 - 0.15],
  });
}
