// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The outdoor switchboard of the 3D site layout, generic and typical of
// the class (for example the Eaton Pow-R-Line C and the Square D QED) in its UL 891 NEMA 3R enclosure: a line-up of three sections
// on a base channel, each with a full-height hinged front door, three hinges,
// a padlockable vault handle and hooded louvers top and bottom; a roof that
// slopes to the back with a drip edge over the doors; bolted end panels with
// louvers; bolted rear covers; a nameplate and the warning label.
//
// Frame: the doors face +z, x across the line-up, standing on y = 0 (the
// bottom of the concrete pad), centered on the pad. Envelope kept from the
// scene: pad 2.3 by 1.5 m, 0.15 m high; enclosure 1.9 m wide, 0.8 m deep,
// 2.34 m high above grade with the roof (Pow-R-Line C: 90 in (2286 mm)
// sections; the 3R roof and base channel add to it).

import {
  ModelParts,
  boxG,
  cylG,
  louversG,
  roundBoxG,
  sideProfileG,
  type ModelKit,
} from './site-layout-model-kit';
import { addWarningSign } from './site-layout-model-warning-sign';

export const SWITCHBOARD_SLOTS = [
  'concrete',
  'body',
  'door',
  'seam',
  'metal',
  'plate',
  'sign',
  'ink',
] as const;
export type SwitchboardSlot = (typeof SWITCHBOARD_SLOTS)[number];

export const OUTDOOR_SWITCHBOARD = {
  pad: { widthM: 2.3, depthM: 1.5, heightM: 0.15 },
  sections: 3,
  widthM: 1.9,
  depthM: 0.8,
  /** The base channel under the line-up. */
  baseM: 0.12,
  /** The enclosure from the base channel to the eaves. */
  bodyHeightM: 2.0,
  /** The roof: overhang at the front and sides, rise to the front edge. */
  roof: { overhangM: 0.05, riseM: 0.05, thickM: 0.025 },
  /** Doors: inset from the section edges, louver groups. */
  door: { insetM: 0.025, louverW: 0.4, louverH: 0.16, louvers: 5 },
} as const;

export type SwitchboardKit = ModelKit<SwitchboardSlot>;

/** The NEMA 3R switchboard on its pad (see the file comment for the frame). */
export function createOutdoorSwitchboardKit(): SwitchboardKit {
  const s = OUTDOOR_SWITCHBOARD;
  const p = new ModelParts<SwitchboardSlot>();
  const y0 = s.pad.heightM;
  const pd = s.pad.depthM / 2;
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
      s.pad.widthM,
    ),
  );
  const hw = s.widthM / 2;
  const hd = s.depthM / 2;
  // The base channel, set back a little under the enclosure.
  p.add('seam', boxG(s.widthM + 0.04, s.baseM, s.depthM + 0.06), {
    at: [0, y0 + s.baseM / 2, 0],
  });
  const b = y0 + s.baseM;
  const top = b + s.bodyHeightM;
  p.add('body', boxG(s.widthM, s.bodyHeightM, s.depthM), { at: [0, b + s.bodyHeightM / 2, 0] });
  // The roof slopes to the back, overhanging the doors and the ends.
  const r = s.roof;
  const rf = hd + r.overhangM;
  const rb = -hd - 0.02;
  p.add(
    'body',
    sideProfileG(
      [
        [rb, top],
        [rf, top + r.riseM - r.thickM],
        [rf, top + r.riseM],
        [rb, top + r.thickM],
      ],
      s.widthM + 2 * r.overhangM,
      0.004,
    ),
  );
  p.add('body', boxG(s.widthM + 2 * r.overhangM, 0.04, 0.01), {
    at: [0, top + r.riseM - r.thickM - 0.02, rf - 0.005],
  });
  // Section seams on the front, the roof edge and the back.
  const secW = s.widthM / s.sections;
  for (let i = 1; i < s.sections; i++) {
    const x = -hw + i * secW;
    p.add('seam', boxG(0.012, s.bodyHeightM, 0.004), {
      at: [x, b + s.bodyHeightM / 2, hd + 0.002],
    });
    p.add('seam', boxG(0.012, s.bodyHeightM, 0.004), {
      at: [x, b + s.bodyHeightM / 2, -hd - 0.002],
    });
  }
  const d = s.door;
  const front = hd + 0.012;
  for (let i = 0; i < s.sections; i++) {
    const cx = -hw + (i + 0.5) * secW;
    const dw = secW - 2 * d.insetM;
    const dh = s.bodyHeightM - 0.14;
    const dy = b + s.bodyHeightM / 2;
    p.add('door', roundBoxG(dw, dh, 0.024, 0.006), { at: [cx, dy, hd + 0.006] });
    // Three hinges on the left edge.
    for (const f of [0.12, 0.5, 0.88]) {
      p.add('metal', cylG(0.011, 0.011, 0.1, 8), {
        at: [cx - dw / 2 - 0.004, dy - dh / 2 + f * dh, front],
      });
    }
    // The padlockable vault handle on the right edge.
    const hx = cx + dw / 2 - 0.07;
    p.add('metal', roundBoxG(0.06, 0.16, 0.012, 0.004), { at: [hx, dy, front + 0.004] });
    p.add('metal', cylG(0.014, 0.014, 0.03, 10), {
      at: [hx, dy + 0.03, front + 0.02],
      rot: [Math.PI / 2, 0, 0],
    });
    p.add('metal', roundBoxG(0.026, 0.13, 0.016, 0.006), { at: [hx, dy - 0.03, front + 0.036] });
    p.add('seam', cylG(0.006, 0.006, 0.004, 8), {
      at: [hx, dy - 0.06, front + 0.012],
      rot: [Math.PI / 2, 0, 0],
    });
    // Hooded louvers near the top and the bottom of the door.
    for (const ly of [b + 0.28, top - 0.3]) {
      p.add('seam', boxG(d.louverW, d.louverH, 0.004), { at: [cx, ly, front] });
      for (const g of louversG(d.louverW - 0.02, d.louverH - 0.02, d.louvers)) {
        p.add('door', g, { at: [cx, ly, front + 0.006] });
      }
      p.add('door', boxG(d.louverW + 0.03, 0.012, 0.03), {
        at: [cx, ly + d.louverH / 2 + 0.01, front + 0.014],
      });
    }
  }
  // The nameplate on the middle door and the warning label on the right one.
  p.add('plate', boxG(0.34, 0.12, 0.004), { at: [0, top - 0.6, front + 0.002] });
  for (let i = 0; i < 3; i++) {
    p.add('ink', boxG(0.28 - (i % 2) * 0.08, 0.01, 0.002), {
      at: [-(i % 2) * 0.04, top - 0.57 - i * 0.03, front + 0.005],
    });
  }
  addWarningSign(p, 'sign', 'ink', 0.22, { at: [secW, top - 0.75, front] });
  // Bolted end panels with a louver group each.
  for (const side of [-1, 1]) {
    const x = side * (hw + 0.006);
    p.add('door', boxG(0.012, s.bodyHeightM - 0.08, s.depthM - 0.06), {
      at: [x, b + s.bodyHeightM / 2, 0],
    });
    for (let k = 0; k < 5; k++) {
      const y = b + 0.06 + (k * (s.bodyHeightM - 0.12)) / 4;
      for (const z of [-hd + 0.05, hd - 0.05]) {
        p.add('metal', cylG(0.008, 0.008, 0.008, 6), {
          at: [x + side * 0.008, y, z],
          rot: [0, 0, Math.PI / 2],
        });
      }
    }
    for (const g of louversG(0.38, 0.22, 6)) {
      p.add('door', g, {
        at: [x + side * 0.007, top - 0.35, 0],
        rot: [0, side * (Math.PI / 2), 0],
      });
    }
  }
  // Bolted rear covers, one per section, with a bolt at every corner and midway.
  for (let i = 0; i < s.sections; i++) {
    const cx = -hw + (i + 0.5) * secW;
    const cw = secW - 0.05;
    const ch = s.bodyHeightM - 0.1;
    p.add('door', boxG(cw, ch, 0.01), { at: [cx, b + s.bodyHeightM / 2, -hd - 0.005] });
    for (const fx of [-0.5, 0.5]) {
      for (const fy of [-0.5, -0.17, 0.17, 0.5]) {
        p.add('metal', cylG(0.008, 0.008, 0.008, 6), {
          at: [cx + fx * (cw - 0.04), b + s.bodyHeightM / 2 + fy * (ch - 0.04), -hd - 0.012],
          rot: [Math.PI / 2, 0, 0],
        });
      }
    }
    for (const g of louversG(0.36, 0.14, 4)) {
      p.add('door', g, { at: [cx, top - 0.2, -hd - 0.012], rot: [0, Math.PI, 0] });
    }
  }
  return p.kit();
}
