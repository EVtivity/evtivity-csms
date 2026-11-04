// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The step-down transformer of the 3D site layout: a generic three-phase
// ventilated dry-type general purpose transformer (480 V delta to 208Y/120 V,
// 75 to 500 kVA) in a NEMA 3R enclosure on a concrete housekeeping pad, as a
// 480 V EV site feeds its Level 2 panelboard through one (NREL/TP-5400-83250,
// 2.7: "a step-down transformer and service panel must be installed";
// SDG&E EV Charging Station Standards, EV-3.60 and Table EV-11.10). Typical
// of the class (Square D EE and Hammond Sentinel G units): a floor-standing
// steel box on two base channels (its legs), the ventilation intake the
// opening under the bottom plate between the legs, the exhaust high on the
// sides under a drip shield and the top cover overhang, the bolted removable front panel
// with its two lift handles, the nameplate and the warning label on the
// front, the conduits into the lower side of the wiring compartment, and a
// grounding pad. Nothing on it names a maker.
//
// Frame: the front panel faces +z, x across it, standing on y = 0 (the
// bottom of the pad), centered on the pad.

import {
  ModelParts,
  boxG,
  cylG,
  louversG,
  polyTubeG,
  roundBoxG,
  sideProfileG,
  type ModelKit,
} from './site-layout-model-kit';
import { addWarningSign } from './site-layout-model-warning-sign';

export const DRY_TRANSFORMER_SLOTS = [
  'concrete',
  'body',
  'vent',
  'seam',
  'metal',
  'plate',
  'sign',
  'ink',
  'conduit',
] as const;
export type DryTransformerSlot = (typeof DRY_TRANSFORMER_SLOTS)[number];

const IN = 0.0254;

/**
 * Enclosure outlines (height, front width, depth, inches) of a three-phase
 * 480 V delta to 208Y/120 V ventilated unit by kVA, from two published
 * catalogs:
 *
 * - Square D (Schneider Electric), Low Voltage Transformers catalog DE9,
 *   March 2014, page DE9-12, "Enclosure Dimensions and Accessories"
 *   (enclosure 20D for 75 kVA EE75T3H, 21D for 112.5 kVA, 22D for 150 kVA,
 *   24D for 225 kVA, 25D for 300 kVA, 30D for 500 kVA, page DE9-5):
 *   20D 37 x 30 x 20, 21D 37 x 30 x 24, 22D 43.75 x 32 x 27,
 *   24D 49.5 x 35 x 28.5, 25D 49.5 x 41 x 32, 30D 71 x 48 x 36.
 * - Hammond Power Solutions, Sentinel G energy efficient distribution
 *   transformers selection guide, page 12, "480 DELTA PRIMARY VOLTS 208Y/120
 *   SECONDARY VOLTS" (width, depth, height): 75 kVA SG3A0075KB 28.3, 27.0,
 *   36.0; 112.5 kVA 28.3, 27.0, 36.0; 150 kVA 31.5, 29.5, 44.5; 225 kVA
 *   38.0, 34.0, 52.0; 300 kVA 38.0, 34.0, 52.0; 500 kVA 49.0, 42.0, 64.0.
 *
 * The model takes the mean of the two (derived: (a + b) / 2 per dimension),
 * so it copies neither. Cross-checks in the same range: Eaton frame FR942
 * (75 kVA, Eaton V24M28T7516CU product data sheet: 43 in high, 30.5 in wide,
 * 24 in long) and SDG&E Table EV-11.10 footprints (75 kVA 29.00 in W by
 * 22.00 in L, 225 kVA 31.44 by 24.67, at or below the model's). The catalog
 * outlines are of 150 C rise units; SDG&E EV-11.00 note D asks for 80 C rise,
 * usually a larger frame, so the model may draw an EV unit a little small.
 */
export const DRY_TRANSFORMER_SIZES = [
  { kva: 75, heightIn: (37 + 36) / 2, widthIn: (30 + 28.3) / 2, depthIn: (20 + 27) / 2 },
  { kva: 112.5, heightIn: (37 + 36) / 2, widthIn: (30 + 28.3) / 2, depthIn: (24 + 27) / 2 },
  { kva: 150, heightIn: (43.75 + 44.5) / 2, widthIn: (32 + 31.5) / 2, depthIn: (27 + 29.5) / 2 },
  { kva: 225, heightIn: (49.5 + 52) / 2, widthIn: (35 + 38) / 2, depthIn: (28.5 + 34) / 2 },
  { kva: 300, heightIn: (49.5 + 52) / 2, widthIn: (41 + 38) / 2, depthIn: (32 + 34) / 2 },
  { kva: 500, heightIn: (71 + 64) / 2, widthIn: (48 + 49) / 2, depthIn: (36 + 42) / 2 },
] as const;

/** A size class of the model, in meters. */
export interface DryTransformerSize {
  kva: number;
  heightM: number;
  widthM: number;
  depthM: number;
}

/**
 * The size class drawn for a rating: the smallest listed rating at or above
 * it (a 90 kVA unit draws as 112.5), the largest above 500 kVA, the 75 kVA
 * class for an unrated or smaller unit.
 */
export function dryTransformerSize(kva: number | null): DryTransformerSize {
  const list = DRY_TRANSFORMER_SIZES;
  const row =
    kva == null
      ? list[0]
      : (list.find((s) => s.kva >= kva - 1e-9) ?? list[list.length - 1] ?? list[0]);
  return {
    kva: row.kva,
    heightM: row.heightIn * IN,
    widthM: row.widthIn * IN,
    depthM: row.depthIn * IN,
  };
}

/**
 * The fixed parts, meters. The housekeeping pad: 4 in (0.10 m) high and
 * 6 in (0.15 m) wider than the enclosure on each side (no source: a common
 * concrete equipment pad; it keeps the base channels off the grade, which
 * the Hammond IOM DIM16 (May 2025) asks for: "verify that adequate site
 * drainage exists to prevent groundwater from entering the transformers").
 * The base channels (the legs) run front to back under each side, 2.5 in
 * (0.064 m) high and 3 in (0.076 m) wide, and the top cover's drip edge
 * stands 1 in (0.025 m) out (no source). The air intake is the opening under
 * the enclosure's bottom plate between the legs, as the Hammond IOM DIM16
 * (May 2025), Ventilation, describes it: "the front ventilation area defined
 * between the bottom plate and the supporting legs"; with the legs running
 * front to back the opening goes through to the back (derived). The front
 * and back panels carry no louvers. The exhaust openings sit high on each
 * side under the weathershield: their place follows the hood that covers
 * them; their size and louver count have no source. The hood over each side's
 * exhaust louvers is the bolt-on weathershield of the class: 6.2 in
 * (0.157 m) high and 3.125 in (0.079 m) deep, "Gray painted steel" (Square D
 * WS364 product data sheet, for enclosures 19D, 20D and 21D; Eaton names one
 * per frame, WS59 for frame 942, Eaton V24M28T7516CU product data sheet;
 * Hammond builds it in, "Integrated Drip Shield"); the larger weathershields
 * (WS380, WS381) publish no size, so every class draws the WS364 one. The
 * front panel lift handles and the screw count have no source.
 */
export const DRY_TRANSFORMER = {
  pad: { overM: 0.15, heightM: 0.1 },
  baseM: 0.064,
  /** The width of each leg (base channel) under a side (no source). */
  legM: 0.076,
  dripM: 0.025,
  hood: { heightM: 6.2 * IN, outM: 3.125 * IN },
  /** The conduits into the lower right side: outside diameter (2 in and 3 in RMC, ANSI C80.1). */
  conduits: [0.0603, 0.0889],
} as const;

export type DryTransformerKit = ModelKit<DryTransformerSlot>;

/** The concrete pad under a unit of this size, x by z (the bollards keep off it). */
export function dryTransformerPad(size: DryTransformerSize): { w: number; d: number } {
  const o = DRY_TRANSFORMER.pad.overM;
  return { w: size.widthM + 2 * o, d: size.depthM + 2 * o };
}

/** The dry-type transformer of `size` on its pad (see the file comment for the frame). */
export function createDryTransformerKit(size: DryTransformerSize): DryTransformerKit {
  const t = DRY_TRANSFORMER;
  const p = new ModelParts<DryTransformerSlot>();
  const pad = dryTransformerPad(size);
  const y0 = t.pad.heightM;
  const w = size.widthM;
  const d = size.depthM;
  const hw = w / 2;
  const hd = d / 2;
  // The pad, its top edges chamfered.
  const pz = pad.d / 2;
  p.add(
    'concrete',
    sideProfileG(
      [
        [-pz, 0],
        [pz, 0],
        [pz, y0 - 0.015],
        [pz - 0.015, y0],
        [-pz + 0.015, y0],
        [-pz, y0 - 0.015],
      ],
      pad.w,
    ),
  );
  // Two base channels (the legs) front to back under the sides, with the
  // lifting and anchor holes near their ends.
  const b = y0 + t.baseM;
  for (const side of [-1, 1]) {
    const x = side * (hw - t.legM / 2);
    p.add('seam', boxG(t.legM, t.baseM, d), { at: [x, y0 + t.baseM / 2, 0] });
    for (const z of [hd - 0.06, -hd + 0.06]) {
      p.add('metal', cylG(0.013, 0.013, t.legM + 0.01, 10), {
        at: [x, y0 + t.baseM / 2, z],
        rot: [0, 0, Math.PI / 2],
      });
    }
  }
  // The air intake: the opening under the bottom plate between the legs,
  // drawn as the shadowed cavity set back from the front and the back, with
  // the bottom plate's edge over it.
  p.add('vent', boxG(w - 2 * t.legM, t.baseM, d - 0.08), { at: [0, y0 + t.baseM / 2, 0] });
  p.add('seam', boxG(w, 0.006, d), { at: [0, b + 0.003, 0] });
  // The enclosure: the box from the base to under the top cover.
  const top = y0 + size.heightM;
  const coverH = 0.03;
  const boxTop = top - coverH;
  const boxH = boxTop - b;
  const midY = (b + boxTop) / 2;
  p.add('body', roundBoxG(w, boxH, d, 0.008), { at: [0, midY, 0] });
  // The top cover with its drip edge out over the front and the sides.
  p.add('body', roundBoxG(w + 2 * t.dripM, coverH, d + 2 * t.dripM, 0.006), {
    at: [0, top - coverH / 2, 0],
  });
  p.add('seam', boxG(w + 2 * t.dripM - 0.01, 0.006, d + 2 * t.dripM - 0.01), {
    at: [0, top - coverH - 0.003, 0],
  });
  // The removable front panel: a seam around it, its screws and two handles.
  const front = hd;
  const panelB = b + 0.02;
  const panelT = boxTop - 0.03;
  const panelH = panelT - panelB;
  const panelW = w - 0.06;
  p.add('body', roundBoxG(panelW, panelH, 0.008, 0.003), {
    at: [0, (panelB + panelT) / 2, front + 0.004],
  });
  for (const [sx, sy, sw, sh] of [
    [0, panelT + 0.004, panelW + 0.01, 0.006],
    [0, panelB - 0.004, panelW + 0.01, 0.006],
    [-panelW / 2 - 0.004, (panelB + panelT) / 2, 0.006, panelH],
    [panelW / 2 + 0.004, (panelB + panelT) / 2, 0.006, panelH],
  ] as const) {
    p.add('seam', boxG(sw, sh, 0.004), { at: [sx, sy, front + 0.002] });
  }
  const screwXs = [-panelW / 2 + 0.03, 0, panelW / 2 - 0.03];
  for (const x of screwXs) {
    for (const y of [panelT - 0.025, panelB + 0.025]) {
      p.add('metal', cylG(0.008, 0.008, 0.006, 8), {
        at: [x, y, front + 0.011],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  for (const side of [-1, 1]) {
    const hx = side * (panelW / 2 - 0.09);
    const hy = (panelB + panelT) / 2 + 0.05;
    // A U handle: two standoffs and a grip.
    for (const dy of [-0.05, 0.05]) {
      p.add('metal', cylG(0.007, 0.007, 0.035, 8), {
        at: [hx, hy + dy, front + 0.025],
        rot: [Math.PI / 2, 0, 0],
      });
    }
    p.add('metal', cylG(0.008, 0.008, 0.12, 8), { at: [hx, hy, front + 0.04] });
  }
  // The bolted back panel: its seam and screws.
  for (const [sx, sy, sw, sh] of [
    [0, panelT + 0.004, panelW + 0.01, 0.006],
    [0, panelB - 0.004, panelW + 0.01, 0.006],
    [-panelW / 2 - 0.004, (panelB + panelT) / 2, 0.006, panelH],
    [panelW / 2 + 0.004, (panelB + panelT) / 2, 0.006, panelH],
  ] as const) {
    p.add('seam', boxG(sw, sh, 0.004), { at: [sx, sy, -hd - 0.002] });
  }
  for (const x of screwXs) {
    for (const y of [panelT - 0.025, panelB + 0.025]) {
      p.add('metal', cylG(0.008, 0.008, 0.006, 8), {
        at: [x, y, -hd - 0.003],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  // The exhaust louvers high on each side, under their hoods (the drip shield).
  const ventH = t.hood.heightM - 0.03;
  const ventY = boxTop - 0.06 - ventH / 2;
  const ventD = d - 0.16;
  for (const side of [-1, 1]) {
    const x = side * hw;
    p.add('vent', boxG(0.004, ventH + 0.02, ventD + 0.02), {
      at: [x + side * 0.002, ventY, 0],
    });
    for (const g of louversG(ventD, ventH, 8, 0.014)) {
      p.add('seam', g, { at: [x + side * 0.008, ventY, 0], rot: [0, side * (Math.PI / 2), 0] });
    }
    // The hood: a sheet sloping out and down from the side over the louvers,
    // with a drip lip at its edge and a cheek at each end, open at the bottom.
    const out = t.hood.outM;
    const hoodLen = ventD + 0.06;
    const hoodBase = ventY + ventH / 2;
    const hood = sideProfileG(
      [
        [0, 0.035],
        [out, 0.005],
        [out, 0.011],
        [0, 0.045],
      ],
      hoodLen,
    );
    p.add('body', hood, { at: [x, hoodBase, 0], rot: [0, side * (Math.PI / 2), 0] });
    p.add('body', boxG(0.003, 0.03, hoodLen), {
      at: [x + side * (out - 0.0015), hoodBase - 0.007, 0],
    });
    for (const z of [-hoodLen / 2, hoodLen / 2]) {
      const cheek = sideProfileG(
        [
          [0, -ventH - 0.01],
          [out, -0.02],
          [out, 0.011],
          [0, 0.045],
        ],
        0.003,
      );
      p.add('body', cheek, { at: [x, hoodBase, z], rot: [0, side * (Math.PI / 2), 0] });
    }
  }
  // The nameplate high on the front panel, its engraved lines, and the
  // warning label beside it (NEMA 260, ANSI Z535.4 layout).
  const plateY = panelT - 0.12;
  p.add('plate', boxG(0.16, 0.1, 0.003), { at: [-0.12, plateY, front + 0.0095] });
  for (let i = 0; i < 4; i++) {
    p.add('ink', boxG(0.12 - (i % 2) * 0.03, 0.006, 0.002), {
      at: [-0.125 - (i % 2) * 0.015, plateY + 0.03 - i * 0.02, front + 0.0115],
    });
  }
  addWarningSign(p, 'sign', 'ink', 0.13, { at: [0.15, plateY - 0.01, front + 0.008] });
  // The grounding pad low on the left side.
  p.add('metal', boxG(0.006, 0.05, 0.08), { at: [-hw - 0.003, b + 0.1, hd - 0.15] });
  // The conduits: out of the pad and into the lower right side of the
  // wiring compartment, with their hubs.
  t.conduits.forEach((od, i) => {
    const z = hd - 0.12 - i * 0.14;
    const y = b + 0.14;
    const x = hw + 0.03 + od;
    // Up out of the pad, a 90 degree sweep elbow, and into the side.
    const r = od * 1.2;
    const elbow = Array.from({ length: 7 }, (_, k) => {
      const a = (k / 6) * (Math.PI / 2);
      return [x - r + r * Math.cos(a), y + od / 2 - r + r * Math.sin(a), z] as const;
    });
    p.add(
      'conduit',
      polyTubeG([[x, y0 - 0.02, z], ...elbow, [hw + 0.005, y + od / 2, z]], od / 2, 12),
    );
    p.add('metal', cylG(od / 2 + 0.01, od / 2 + 0.01, 0.02, 12), {
      at: [hw + 0.01, y + od / 2, z],
      rot: [0, 0, Math.PI / 2],
    });
  });
  return p.kit();
}
