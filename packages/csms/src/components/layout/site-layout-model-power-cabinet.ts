// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The power cabinet of a DC split system on its concrete pad: a double
// cabinet with two front doors (hinges, latches, louvered air inlets), a
// vented plinth, a roof with an overhang and a drip edge, intake grilles on
// both sides, and a back with two bolted service panels, the air outlet
// under the roof and the cable entry plate.
//
// Frame: origin at the pad center on the ground, the doors face +z, x across
// them, standing on y = 0.

import {
  ModelParts,
  boxG,
  cylG,
  louversG,
  roundBoxG,
  sideProfileG,
  torusG,
  type Vec3,
} from './site-layout-model-kit';
import type { PowerKit, PowerSlot } from './site-layout-model-power-slots';

/**
 * Kempower C-Series Power Unit datasheet (2022): double cabinet 1250 x 2195 x
 * 841 mm (W x H x D), two doors, air in through the doors and out under the
 * roof, https://www.nee.ca/wp-content/uploads/2023/08/Kempower-C-Series-Power-Units.pdf.
 * The cabinet height includes its plinth and roof. Derived, no published
 * value: the plinth is 100 mm (the 4.5 percent band of the product photos),
 * the roof 50 mm with a 25 mm overhang all round; each door is half the width
 * less three 15 mm gaps and runs from 40 mm over the plinth to 40 mm under
 * the roof; three hinges per door at a tenth, half and nine tenths of its
 * height (the usual pitch of a lift-off hinge set); four inlet grilles per
 * door at the scene's 0.26 m pitch. The pad (0.2 m past the sides, 0.3 m past
 * front and back, 0.15 m high) is the scene's.
 */
export const POWER_CABINET = {
  widthM: 1.25,
  heightM: 2.195,
  depthM: 0.841,
  plinthM: 0.1,
  roof: { heightM: 0.05, overM: 0.025 },
  pad: { overSideM: 0.2, overFrontM: 0.3, heightM: 0.15 },
  doorGapM: 0.015,
  doorInsetM: 0.04,
  doorThickM: 0.02,
  /** Inlet grilles on each door: width, height and the pitch down from the top one. */
  inlet: { widthM: 0.34, heightM: 0.2, pitchM: 0.26, count: 4, topFromRoofM: 0.35 },
  /** Side intake grilles: depth along the side, height, center height above the pad top. */
  sideGrille: { depthM: 0.55, heightM: 0.9, centerM: 1.05 },
} as const;

export interface PowerCabinetModel {
  kit: PowerKit;
  /** The front of the doors and the pad top, for the scene's labels and links. */
  frontZ: number;
  padTopM: number;
  /** Where the scene can put a textured warning label on the right door. */
  label: { at: Vec3; widthM: number; heightM: number };
}

/** A grille: a dark frame with louvers facing +z, centered. */
function addGrille(
  p: ModelParts<PowerSlot>,
  w: number,
  h: number,
  slats: number,
  at: Vec3,
  rotY = 0,
): void {
  p.add('trim', boxG(w, h, 0.006), { at, rot: [0, rotY, 0] });
  for (const g of louversG(w - 0.02, h - 0.02, slats, 0.014)) {
    g.translate(0, 0, 0.006);
    p.add('trim', g, { at, rot: [0, rotY, 0] });
  }
}

export function createPowerCabinetKit(): PowerCabinetModel {
  const c = POWER_CABINET;
  const p = new ModelParts<PowerSlot>();
  const hw = c.widthM / 2;
  const hd = c.depthM / 2;
  const y0 = c.pad.heightM;
  // The pad with chamfered edges.
  p.add(
    'concrete',
    roundBoxG(
      c.widthM + 2 * c.pad.overSideM,
      c.pad.heightM,
      c.depthM + 2 * c.pad.overFrontM,
      0.015,
    ),
    { at: [0, c.pad.heightM / 2, 0] },
  );
  // The plinth, set in 15 mm, with vents front and back.
  p.add('trim', boxG(c.widthM - 0.03, c.plinthM, c.depthM - 0.03), {
    at: [0, y0 + c.plinthM / 2, 0],
  });
  for (const side of [-1, 1]) {
    addGrille(
      p,
      c.widthM - 0.2,
      c.plinthM - 0.03,
      3,
      [0, y0 + c.plinthM / 2, side * (hd - 0.012)],
      side < 0 ? Math.PI : 0,
    );
  }
  // The body.
  const bodyBottom = y0 + c.plinthM;
  const bodyTop = y0 + c.heightM - c.roof.heightM;
  const bodyH = bodyTop - bodyBottom;
  p.add('body', roundBoxG(c.widthM, bodyH, c.depthM, 0.008), {
    at: [0, bodyBottom + bodyH / 2, 0],
  });
  // The roof: a slab with an overhang, sloping to the back, and a drip edge.
  const ro = c.roof;
  p.add(
    'trim',
    sideProfileG(
      [
        [-hd - ro.overM, bodyTop],
        [hd + ro.overM, bodyTop],
        [hd + ro.overM, bodyTop + ro.heightM],
        [-hd - ro.overM, bodyTop + ro.heightM - 0.012],
      ],
      c.widthM + 2 * ro.overM,
      0.004,
    ),
  );
  for (const side of [-1, 1]) {
    p.add('trim', boxG(c.widthM + 2 * ro.overM, 0.012, 0.004), {
      at: [0, bodyTop - 0.006, side * (hd + ro.overM - 0.002)],
    });
  }
  // Lifting eyes on the roof corners.
  for (const [ex, ez] of [
    [-hw + 0.1, -hd + 0.1],
    [hw - 0.1, -hd + 0.1],
    [-hw + 0.1, hd - 0.1],
    [hw - 0.1, hd - 0.1],
  ] as const) {
    p.add('metal', torusG(0.025, 0.006, 6, 12, Math.PI), {
      at: [ex, y0 + c.heightM - 0.006, ez],
    });
  }
  // The doors.
  const doorW = (c.widthM - 3 * c.doorGapM) / 2;
  const doorBottom = bodyBottom + c.doorInsetM;
  const doorTop = bodyTop - c.doorInsetM;
  const doorH = doorTop - doorBottom;
  const doorY = (doorBottom + doorTop) / 2;
  const doorZ = hd + c.doorThickM / 2;
  const frontZ = hd + c.doorThickM;
  for (const side of [-1, 1]) {
    const x = side * (c.doorGapM / 2 + doorW / 2);
    p.add('door', roundBoxG(doorW, doorH, c.doorThickM, 0.005), { at: [x, doorY, doorZ] });
    // Hinges on the outer edge.
    const hx = side * (hw - 0.004);
    for (const f of [0.1, 0.5, 0.9]) {
      p.add('metal', cylG(0.011, 0.011, 0.09, 10), {
        at: [hx, doorBottom + doorH * f, frontZ - 0.004],
      });
    }
    // The latch on the inner edge: a swing handle in a recessed housing.
    const lx = side * (c.doorGapM / 2 + 0.06);
    p.add('trim', roundBoxG(0.05, 0.22, 0.012, 0.004), { at: [lx, 1.2, frontZ + 0.006] });
    p.add('metal', roundBoxG(0.026, 0.15, 0.018, 0.005), { at: [lx, 1.19, frontZ + 0.012] });
    p.add('metal', cylG(0.008, 0.008, 0.006, 10), {
      at: [lx, 1.29, frontZ + 0.014],
      rot: [Math.PI / 2, 0, 0],
    });
    // The air inlet grilles.
    const inl = c.inlet;
    const topInlet = y0 + c.heightM - inl.topFromRoofM;
    for (let i = 0; i < inl.count; i++) {
      addGrille(p, inl.widthM, inl.heightM, 5, [x, topInlet - i * inl.pitchM, frontZ + 0.003]);
    }
  }
  // The nameplate on the left door.
  p.add('label', boxG(0.2, 0.1, 0.003), {
    at: [-(c.doorGapM / 2 + doorW / 2), doorBottom + 0.3, frontZ + 0.0015],
  });
  // Side intake grilles.
  const sg = c.sideGrille;
  for (const side of [-1, 1]) {
    addGrille(
      p,
      sg.depthM,
      sg.heightM,
      12,
      [side * (hw + 0.003), y0 + sg.centerM, 0],
      (side * Math.PI) / 2,
    );
  }
  // The back: two bolted service panels, the air outlet under the roof, the cable entry plate.
  const backZ = -hd - 0.004;
  const panelW = (c.widthM - 3 * c.doorGapM) / 2;
  for (const side of [-1, 1]) {
    const x = side * (c.doorGapM / 2 + panelW / 2);
    p.add('door', boxG(panelW, doorH - 0.3, 0.008), { at: [x, doorY - 0.15, backZ] });
    for (const bx of [-panelW / 2 + 0.03, panelW / 2 - 0.03]) {
      for (const by of [doorBottom + 0.03, doorY - 0.15, doorTop - 0.33]) {
        p.add('metal', cylG(0.007, 0.007, 0.006, 6), {
          at: [x + bx, by, backZ - 0.007],
          rot: [Math.PI / 2, 0, 0],
        });
      }
    }
  }
  addGrille(p, c.widthM - 0.12, 0.22, 6, [0, bodyTop - 0.16, -hd - 0.004], Math.PI);
  p.add('trim', boxG(0.6, 0.07, 0.01), { at: [0, y0 + 0.06, -hd + 0.002] });
  for (const gx of [-0.18, 0, 0.18]) {
    p.add('trim', cylG(0.03, 0.03, 0.03, 12), {
      at: [gx, y0 + 0.06, -hd - 0.012],
      rot: [Math.PI / 2, 0, 0],
    });
  }
  return {
    kit: p.kit(),
    frontZ,
    padTopM: y0,
    label: {
      at: [c.doorGapM / 2 + doorW / 2, doorBottom + 0.3, frontZ + 0.003],
      widthM: 0.2,
      heightM: 0.18,
    },
  };
}
