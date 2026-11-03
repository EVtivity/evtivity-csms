// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An AC Level 2 wall box typical of the class (for example the ABB Terra AC (UL) and the Wallbox
// Pulsar Plus): a body with a curved
// front fascia on a steel mounting plate, a front plate the scene tints, a
// small display, the status light ring (no logo: owner decision 2026-11-02),
// a cable gland in the bottom for the charging cable, and the supply conduit
// down the wall to grade with its connector, straps and coupling.
//
// Frame: the wall face is z = 0, the box stands out along +z and faces +z,
// x across it, y up from the ground (y = 0), the box centered on x = 0.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  latheG,
  sideProfileG,
  torusG,
} from './site-layout-model-kit';
import type { ModelKit, Pt, Vec3 } from './site-layout-model-kit';
import { addCableGland } from './site-layout-model-cable-gland';

/** The material slots of the wall box. */
export const WALL_BOX_SLOTS = [
  /** The housing. */
  'body',
  /** The front plate (tinted per station by the scene). */
  'plate',
  /** Dark trim: the ring surround and the display frame. */
  'bezel',
  /** The display glass (emissive when lit). */
  'screen',
  /** The status light ring (emissive, colored by the scene). */
  'light',
  /** Steel: the mounting plate, the conduit and its fittings. */
  'metal',
  /** The cable gland. */
  'rubber',
] as const;
export type WallBoxSlot = (typeof WALL_BOX_SLOTS)[number];
export type WallBoxKit = ModelKit<WallBoxSlot>;

/**
 * Typical of the class (for example the ABB Terra AC Wallbox UL datasheet,
 * 32/40/80 A, 2023, and the Wallbox Pulsar Plus): H x W x D 400 x 230
 * x 125 mm. Derived from that envelope: the fascia bulges 15 mm, a parabola
 * from 110 mm deep at the top and bottom edges to 125 mm at mid height; the
 * mounting plate is the body plus 10 mm a side, 6 mm steel; the front plate
 * leaves a 10 mm edge of the housing; the display 60 by 34 mm (16:9) at the
 * top of the front, the light ring (a third of the width across, 76 mm)
 * under it, and the connector dock in the middle of the lower front (owner
 * decision 2026-11-02: the handle docks into the front, face into the body,
 * as generic wall boxes with an integrated front dock do), clear of both. The supply is 3/4 in EMT, 23.4 mm outside diameter
 * (ANSI C80.3), entering the bottom 70 mm left of center, strapped within
 * 3 ft of the box and then at most every 10 ft (NEC 358.30(A)); the cable
 * gland is an M32 gland (32 mm thread, 45 mm nut) 60 mm right of center.
 */
export const AC_WALL_BOX = {
  heightM: 0.4,
  widthM: 0.23,
  depthM: 0.125,
  edgeDepthM: 0.11,
  /** The default height of the box bottom above grade. */
  bottomM: 0.75,
  plate: { marginM: 0.01, thicknessM: 0.006 },
  frontPlate: { edgeM: 0.01, thicknessM: 0.003 },
  display: { widthM: 0.06, heightM: 0.034, centerFromTopM: 0.06 },
  ring: { radiusM: 0.038, tubeM: 0.005, centerFromBottomM: 0.25 },
  /** The connector dock in the front middle: 0.12 m up, below the ring (its bottom 0.207 m up). */
  dock: { centerFromBottomM: 0.12 },
  conduit: { radiusM: 0.0234 / 2, x: -0.07, strapBelowBoxM: 0.3, couplingAboveGradeM: 0.15 },
  gland: { x: 0.06 },
} as const;

/**
 * The connector dock in the front middle of the box with its bottom
 * `bottomM` above grade: the holster mount on the fascia, facing out (+z).
 * At the 0.85 m box bottom it is 0.97 m up, inside the 15 to 48 in (0.38 to
 * 1.22 m) reach range of the 2010 ADA Standards 308.2 and 308.3.
 */
export function wallBoxDock(bottomM: number = AC_WALL_BOX.bottomM): {
  x: number;
  y: number;
  z: number;
} {
  const t = AC_WALL_BOX.dock.centerFromBottomM;
  return { x: 0, y: bottomM + t, z: wallBoxFrontZ(t) + AC_WALL_BOX.frontPlate.thicknessM };
}

/** The fascia depth (z of the front face) at height `t` from the box bottom. */
export function wallBoxFrontZ(t: number): number {
  const w = AC_WALL_BOX;
  const u = (t - w.heightM / 2) / (w.heightM / 2);
  return w.plate.thicknessM + w.edgeDepthM + (w.depthM - w.edgeDepthM) * (1 - u * u);
}

/** The tilt about x of the fascia at height `t` (radians; the upper face leans back toward the wall). */
function frontTilt(t: number): number {
  const w = AC_WALL_BOX;
  const slope = (-2 * (w.depthM - w.edgeDepthM) * (t - w.heightM / 2)) / (w.heightM / 2) ** 2;
  return Math.atan(slope);
}

/** Where the scene puts the display message: the display center and size, in the box frame. */
export function wallBoxDisplay(bottomM: number = AC_WALL_BOX.bottomM): {
  center: readonly [number, number, number];
  widthM: number;
  heightM: number;
} {
  const w = AC_WALL_BOX;
  const t = w.heightM - w.display.centerFromTopM;
  return {
    center: [0, bottomM + t, wallBoxFrontZ(t) + w.frontPlate.thicknessM + 0.002],
    widthM: w.display.widthM,
    heightM: w.display.heightM,
  };
}

/** The wall box with its box bottom `bottomM` above grade and the conduit down to grade. */
/** The cable gland under the box: `AC_WALL_BOX.gland.x` right of center, pointing down. */
export function wallBoxGland(bottomM: number = AC_WALL_BOX.bottomM): { at: Vec3; axis: Vec3 } {
  const w = AC_WALL_BOX;
  return { at: [w.gland.x, bottomM, w.plate.thicknessM + w.edgeDepthM * 0.55], axis: [0, -1, 0] };
}

/** The wall box for a cable of `cableDiameterM` (SAE J1772 cable, 12.5 mm, by default). */
export function createAcWallBoxKit(
  bottomM: number = AC_WALL_BOX.bottomM,
  cableDiameterM = 0.0125,
): WallBoxKit {
  const w = AC_WALL_BOX;
  const p = new ModelParts<WallBoxSlot>();
  const back = w.plate.thicknessM;
  const steps = 10;
  const curve = (inset: number, from: number, to: number): Pt[] =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = from + ((to - from) * i) / steps;
      return [wallBoxFrontZ(t) + inset, bottomM + t] as const;
    });
  // The mounting plate.
  p.add('metal', boxG(w.widthM + 2 * w.plate.marginM, w.heightM + 2 * w.plate.marginM, back), {
    at: [0, bottomM + w.heightM / 2, back / 2],
  });
  // The body: its side outline with the curved front, rounded edges.
  const body: Pt[] = [[back, bottomM], ...curve(0, 0, w.heightM), [back, bottomM + w.heightM]];
  p.add('body', sideProfileG(body, w.widthM, 0.012));
  // The front plate: a shell following the fascia, inset from the housing edge.
  const e = w.frontPlate.edgeM;
  const outer = curve(w.frontPlate.thicknessM, e, w.heightM - e);
  const inner = curve(-0.002, e, w.heightM - e).reverse();
  p.add('plate', sideProfileG([...outer, ...inner], w.widthM - 2 * e, 0.001));
  const onFace = (t: number, lift: number): readonly [number, number, number] => [
    0,
    bottomM + t,
    wallBoxFrontZ(t) + w.frontPlate.thicknessM + lift,
  ];
  // The display in its dark frame.
  const dt = w.heightM - w.display.centerFromTopM;
  p.add(
    'bezel',
    frontProfileG(roundRect(w.display.widthM + 0.012, w.display.heightM + 0.012, 0.004), 0.002),
    {
      at: onFace(dt, 0.001),
      rot: [frontTilt(dt), 0, 0],
    },
  );
  p.add('screen', boxG(w.display.widthM, w.display.heightM, 0.001), {
    at: onFace(dt, 0.0022),
    rot: [frontTilt(dt), 0, 0],
  });
  // The status light ring under the display, around a dark disc.
  const rt = w.ring.centerFromBottomM;
  p.add(
    'bezel',
    cylG(w.ring.radiusM + w.ring.tubeM * 1.6, w.ring.radiusM + w.ring.tubeM * 1.6, 0.003, 32),
    {
      at: onFace(rt, 0.0015),
      rot: [Math.PI / 2, 0, 0],
    },
  );
  p.add('light', torusG(w.ring.radiusM, w.ring.tubeM, 6, 32), { at: onFace(rt, 0.003) });
  // The cable gland in the bottom (the shared M-size gland for the cable, `wallBoxGland`).
  const gland = wallBoxGland(bottomM);
  addCableGland(
    p,
    { nut: 'metal', dome: 'bezel', relief: 'rubber' },
    gland.at,
    gland.axis,
    cableDiameterM,
  );
  // The supply conduit down the wall, its center one radius plus a strap off the wall.
  const c = w.conduit;
  const cz = c.radiusM + 0.003;
  p.add('metal', cylG(c.radiusM, c.radiusM, bottomM, 12, true), { at: [c.x, bottomM / 2, cz] });
  // The compression connector into the box bottom.
  p.add(
    'metal',
    latheG(
      [
        [c.radiusM, -0.03],
        [c.radiusM + 0.004, -0.028],
        [c.radiusM + 0.004, -0.012],
        [c.radiusM + 0.007, -0.01],
        [c.radiusM + 0.007, 0],
      ],
      6,
    ),
    { at: [c.x, bottomM, cz] },
  );
  // One-hole straps: a band over the conduit and its foot screwed to the wall.
  for (const y of [bottomM - c.strapBelowBoxM, Math.max(0.05, c.couplingAboveGradeM - 0.08)]) {
    if (y <= 0) continue;
    p.add('metal', torusG(c.radiusM + 0.0015, 0.0015, 4, 12, Math.PI), {
      at: [c.x, y, cz],
      rot: [Math.PI / 2, 0, 0],
    });
    p.add('metal', boxG(0.02, 0.018, 0.003), { at: [c.x + c.radiusM + 0.012, y, 0.0015] });
  }
  // The compression coupling where the conduit meets the run from below grade.
  if (bottomM > c.couplingAboveGradeM + 0.05) {
    p.add('metal', cylG(c.radiusM + 0.004, c.radiusM + 0.004, 0.045, 12), {
      at: [c.x, c.couplingAboveGradeM, cz],
    });
  }
  return p.kit();
}

function roundRect(w: number, h: number, r: number): Pt[] {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s.getPoints(3).map((v) => [v.x, v.y] as const);
}
