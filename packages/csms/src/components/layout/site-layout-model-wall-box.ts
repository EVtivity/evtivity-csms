// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An AC Level 2 wall box typical of the class (for example the ABB Terra AC (UL) and the Wallbox
// Pulsar Plus), with one port or two side by side (a dual-port wall unit
// such as the ChargePoint CT4023 wall mount): a body with a curved
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
import { HOLSTER_DEPTH_M } from './site-layout-connectors';

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
  /**
   * The box bottom above grade: 0.68 m, under 27 in (0.686 m), the most a
   * leading edge may stand for an object deeper than 4 in over a circulation
   * path (2010 ADA Standards 307.2, https://www.access-board.gov/ada/chapter/ch03/).
   */
  bottomM: 0.68,
  plate: { marginM: 0.01, thicknessM: 0.006 },
  frontPlate: { edgeM: 0.01, thicknessM: 0.003 },
  display: { widthM: 0.06, heightM: 0.034, centerFromTopM: 0.06 },
  ring: { radiusM: 0.038, tubeM: 0.005, centerFromBottomM: 0.25 },
  /**
   * The connector dock in the front middle: 0.12 m up, below the ring (its
   * bottom 0.207 m up). The handle docks angled down along the box face
   * (owner decision 2026-11-10): the dock cup opens down and out, its axis
   * `noseUpDeg` below level, so the handle's face points that much up into
   * the box and its grip hangs down the fascia. Derived: 60 degrees, so the
   * grips of the J1772 handle (58 degrees from vertical, `CONNECTOR_SPECS`)
   * and the Type 2 handle (55 degrees) hang within 5 degrees of plumb and the
   * NACS grip (74 degrees) leans 14 degrees out; the cup mouth stands
   * `lipM` proud of the fascia, the rest of the cup recessed in the body.
   * Docked, no part of the handle or the dock 27 in (0.685 m) above the sidewalk stands
   * more than 0.1 m (4 in) proud of the box's leading edge (`WALL_BOX_ADA`).
   */
  dock: { centerFromBottomM: 0.12, noseUpDeg: 60, lipM: 0.004 },
  conduit: { radiusM: 0.0234 / 2, x: -0.07, strapBelowBoxM: 0.3, couplingAboveGradeM: 0.15 },
  gland: { x: 0.06 },
  /**
   * The two-port box (owner decision 2026-11-10: two docks side by side, each
   * with its own EVSE number plate and status light, each cable from its own
   * dock), typical of dual-port wall units (the ChargePoint CT4023 wall mount
   * puts its two J1772 holsters side by side on the front, CT4000 data sheet,
   * https://docs.chargepoint.com/ref-docs/content/pdfs/2-ac/ct4000/ct4000-ds.pdf).
   * Derived: the docks one holster pitch apart (`HOLSTER_PITCH_M`, 0.25 m),
   * so the body is the one-port width plus that pitch (0.48 m), same height
   * and depth; per dock, bottom to top: the dock 0.11 m up, its status ring
   * at 0.235 m, its number plate at 0.335 m (`wallBoxEvsePlate`); the
   * display at the top middle between the plates, each ring its port's RFID
   * reader (`wallBoxRingReaders`), each gland 0.19 m out under its dock, the
   * conduit in the middle.
   */
  dual: {
    widthM: 0.48,
    dockX: 0.125,
    dockFromBottomM: 0.11,
    ringFromBottomM: 0.235,
    plateFromBottomM: 0.335,
    glandX: 0.19,
    conduitX: 0,
  },
} as const;

/** Ports of a wall box: one, or two side by side. */
export type WallBoxPorts = 1 | 2;

/** The body width of a wall box with `ports` ports. */
export function wallBoxWidth(ports: WallBoxPorts = 1): number {
  return ports === 2 ? AC_WALL_BOX.dual.widthM : AC_WALL_BOX.widthM;
}

/** The x of the dock (and its ring) of the port on `side` (-1 left, EVSE 1; 1 right); one port: 0. */
export function wallBoxPortX(ports: WallBoxPorts, side: -1 | 1): number {
  return ports === 2 ? side * AC_WALL_BOX.dual.dockX : 0;
}

/**
 * The status rings of a wall box with its bottom `bottomM` above grade, one
 * per port (EVSE order: left, right), on the fascia, tilted with it.
 */
export function wallBoxRings(
  bottomM: number = AC_WALL_BOX.bottomM,
  ports: WallBoxPorts = 1,
): Array<{ at: Vec3; tiltX: number }> {
  const t = ports === 2 ? AC_WALL_BOX.dual.ringFromBottomM : AC_WALL_BOX.ring.centerFromBottomM;
  const xs = ports === 2 ? [wallBoxPortX(2, -1), wallBoxPortX(2, 1)] : [0];
  return xs.map((x) => ({
    at: [x, bottomM + t, wallBoxFrontZ(t) + AC_WALL_BOX.frontPlate.thicknessM + 0.003] as const,
    tiltX: frontTilt(t),
  }));
}

/** The status ring torus, centered on its own origin, facing +z (the light the scene colors). */
export function wallBoxRingGeometry(): THREE.BufferGeometry {
  return torusG(AC_WALL_BOX.ring.radiusM, AC_WALL_BOX.ring.tubeM, 6, 32);
}

/**
 * The connector dock in the front middle of the box with its bottom
 * `bottomM` above grade (two ports: the dock of the port on `side`): the
 * point on the fascia where the dock's cup opens, down and out
 * (`wallBoxHolsterMount`). At the 0.68 m box bottom it
 * is 0.80 m up (two ports 0.79 m), inside the 15 to 48 in (0.38 to 1.22 m)
 * reach range of the 2010 ADA Standards 308.2 and 308.3.
 */
export function wallBoxDock(
  bottomM: number = AC_WALL_BOX.bottomM,
  ports: WallBoxPorts = 1,
  side: -1 | 1 = -1,
): {
  x: number;
  y: number;
  z: number;
} {
  const t = ports === 2 ? AC_WALL_BOX.dual.dockFromBottomM : AC_WALL_BOX.dock.centerFromBottomM;
  return {
    x: wallBoxPortX(ports, side),
    y: bottomM + t,
    z: wallBoxFrontZ(t) + AC_WALL_BOX.frontPlate.thicknessM,
  };
}

/**
 * The 2010 ADA Standards 307.2 protrusion limit as it applies to a wall box
 * (owner decision 2026-11-10): objects with leading edges more than 27 in
 * (0.686 m, taken as 0.685 m) above the floor "shall protrude 4 inches
 * maximum horizontally into the circulation path"
 * (https://www.access-board.gov/ada/chapter/ch03/). The box itself has its
 * leading edge (its bottom) under 27 in, so a cane finds it; the docked
 * handle and its dock above 27 in stand at most 4 in (0.1 m, the owner's
 * rounding down of 101.6 mm) proud of that leading edge, the fascia's bottom
 * edge (`edgeZ`, from the wall face). The Access Board Guide to the ADA
 * Standards, Chapter 3: Protruding objects, Location Above Detectable
 * Elements: "Objects located above elements that are within cane sweep can
 * protrude 4 [in] maximum from the leading edge of such elements provided
 * that any required reach or clear floor space is not obstructed"
 * (https://www.access-board.gov/ada/guides/chapter-3-protruding-objects/).
 * Heights count from the walking surface, the sidewalk slab the box hangs
 * over (`walkingSurfaceM`, `SURFACE_M.sidewalk`),
 * so the 27 in line stands at `leadingEdgeMaxM` above grade.
 */
export const WALL_BOX_ADA = {
  walkingSurfaceM: 0.12,
  leadingEdgeMaxM: 0.12 + 0.685,
  protrusionMaxM: 0.1,
  edgeZ: AC_WALL_BOX.plate.thicknessM + AC_WALL_BOX.edgeDepthM,
} as const;

/**
 * The holster of the dock of the port on `side` (`wallBoxDock`), for
 * `holsterPose`: its plate inside the body, so the cup mouth stands
 * `AC_WALL_BOX.dock.lipM` proud of the fascia, its axis facing out (+z)
 * tipped `noseUp` down (`AC_WALL_BOX.dock.noseUpDeg`).
 */
export function wallBoxHolsterMount(
  bottomM: number = AC_WALL_BOX.bottomM,
  ports: WallBoxPorts = 1,
  side: -1 | 1 = -1,
): {
  mount: { x: number; y: number; z: number };
  facing: { x: number; z: number };
  noseUp: number;
} {
  const dock = wallBoxDock(bottomM, ports, side);
  const noseUp = (AC_WALL_BOX.dock.noseUpDeg * Math.PI) / 180;
  const back = HOLSTER_DEPTH_M - AC_WALL_BOX.dock.lipM;
  return {
    mount: { x: dock.x, y: dock.y + Math.sin(noseUp) * back, z: dock.z - Math.cos(noseUp) * back },
    facing: { x: 0, z: 1 },
    noseUp,
  };
}

/**
 * The ring is the reader (owner decision 2026-11-10): each port's lit status
 * ring holds its RFID reader, the way compact wall boxes put the reader
 * behind their status light, so no separate pad sits on the fascia. ABL
 * Wallbox eM4 Twin installation manual 0301501_EN_d: "Status display with
 * RFID reader", "The RFID reader module for authorising the charging process
 * is located centrally behind the status indicator", its "multi-coloured LED
 * ring" (https://www.ablmobility.de/global/downloads/anleitungen/em4/0301501_EN_d.pdf);
 * Smappee EV Wall Lite: the reader and the LED on one front plate board, the
 * card swiped "along the blue indicator" (research 2026-11-10). Generic, no
 * brand: inside the ring a dark disc with the card-and-waves tap pictogram
 * (`drawRfidPictogram`), the ring's status colors and pulse unchanged, and
 * just below the ring the short tap line (`drawRfidCaption`, six locales),
 * everything on the port's center line: the display at the top, then the
 * ring, the line and the angled dock. Derived: the disc fills the ring's
 * opening less 2 mm (radius 0.031 m), the line 0.068 by 0.012 m, its center
 * 0.014 m under the ring's outer edge. At the 0.68 m box bottom the reader's
 * center stands 0.93 m above grade, 0.81 m above the 0.12 m sidewalk (two
 * ports 0.915 m and 0.795 m), inside the 15 to 48 in reach range of the 2010
 * ADA Standards 308.2 and 308.3; the disc and the line lie flat on the
 * fascia and the ring's dark disc, behind the ring's front, so nothing protrudes past the box's
 * leading edge (2010 ADA 307.2, `WALL_BOX_ADA`).
 */
export const WALL_BOX_READER = {
  discInsetM: 0.002,
  caption: { widthM: 0.068, heightM: 0.012, belowRingM: 0.014 },
} as const;

/** One port's ring reader: the pictogram disc in its ring and the tap line under it, in the box frame. */
export interface WallBoxRingReader {
  disc: { at: Vec3; tiltX: number; radiusM: number };
  caption: { at: Vec3; tiltX: number; widthM: number; heightM: number };
}

/** The ring readers of a wall box with its bottom `bottomM` above grade, EVSE order (`wallBoxRings`). */
export function wallBoxRingReaders(
  bottomM: number = AC_WALL_BOX.bottomM,
  ports: WallBoxPorts = 1,
): WallBoxRingReader[] {
  const w = AC_WALL_BOX;
  const r = WALL_BOX_READER;
  const t = ports === 2 ? w.dual.ringFromBottomM : w.ring.centerFromBottomM;
  const tc = t - (w.ring.radiusM + w.ring.tubeM) - r.caption.belowRingM;
  return wallBoxRings(bottomM, ports).map((ring) => ({
    disc: {
      // On the face of the dark disc the ring surrounds (`createWallBoxKit`), behind the ring's front.
      at: [ring.at[0], ring.at[1], ring.at[2] + 0.0004],
      tiltX: 0,
      radiusM: w.ring.radiusM - w.ring.tubeM - r.discInsetM,
    },
    caption: {
      at: [ring.at[0], bottomM + tc, wallBoxFrontZ(tc) + w.frontPlate.thicknessM + 0.0015],
      tiltX: frontTilt(tc),
      widthM: r.caption.widthM,
      heightM: r.caption.heightM,
    },
  }));
}

/**
 * Where the number plate of the port on `side` of a two-port box mounts: on
 * the fascia over its dock and ring (`AC_WALL_BOX.dual.plateFromBottomM`),
 * its back on the front plate where the fascia stands out most under it.
 */
export function wallBoxPlateAt(bottomM: number, side: -1 | 1): Vec3 {
  const d = AC_WALL_BOX.dual;
  // The fascia stands out most at mid height; the plate's back clears it over its 0.1 m.
  const half = 0.05;
  const t = d.plateFromBottomM;
  const mid = AC_WALL_BOX.heightM / 2;
  const deepest = t - half <= mid && t + half >= mid ? mid : t - half > mid ? t - half : t + half;
  return [
    wallBoxPortX(2, side),
    bottomM + t,
    wallBoxFrontZ(deepest) + AC_WALL_BOX.frontPlate.thicknessM,
  ];
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

/**
 * The cable gland under the box, pointing down: `AC_WALL_BOX.gland.x` right
 * of center (two ports: the gland of the port on `side`, under its dock).
 */
export function wallBoxGland(
  bottomM: number = AC_WALL_BOX.bottomM,
  ports: WallBoxPorts = 1,
  side: -1 | 1 = 1,
): { at: Vec3; axis: Vec3 } {
  const w = AC_WALL_BOX;
  const x = ports === 2 ? side * w.dual.glandX : w.gland.x;
  return { at: [x, bottomM, w.plate.thicknessM + w.edgeDepthM * 0.55], axis: [0, -1, 0] };
}

/**
 * The wall box with its bottom `bottomM` above grade, the conduit down to
 * grade, for a cable of `cableDiameterM` (SAE J1772 cable, 12.5 mm, by
 * default) and `ports` ports. A one-port box carries its status ring (the
 * `light` slot); a two-port box leaves its two rings to the scene, each lit
 * in its own EVSE's state (`wallBoxRings`).
 */
export function createAcWallBoxKit(
  bottomM: number = AC_WALL_BOX.bottomM,
  cableDiameterM = 0.0125,
  ports: WallBoxPorts = 1,
): WallBoxKit {
  const w = { ...AC_WALL_BOX, widthM: wallBoxWidth(ports) };
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
  // The status light ring of each port under the display, around a dark disc.
  for (const ring of wallBoxRings(bottomM, ports)) {
    const disc = w.ring.radiusM + w.ring.tubeM * 1.6;
    p.add('bezel', cylG(disc, disc, 0.003, 32), {
      at: [ring.at[0], ring.at[1], ring.at[2] - 0.0015],
      rot: [Math.PI / 2, 0, 0],
    });
    if (ports === 1) p.add('light', wallBoxRingGeometry(), { at: ring.at });
  }
  // The cable gland of each port in the bottom (the shared M-size gland for the cable, `wallBoxGland`).
  for (const side of ports === 2 ? ([-1, 1] as const) : ([1] as const)) {
    const gland = wallBoxGland(bottomM, ports, side);
    addCableGland(
      p,
      { nut: 'metal', dome: 'bezel', relief: 'rubber' },
      gland.at,
      gland.axis,
      cableDiameterM,
    );
  }
  // The supply conduit down the wall, its center one radius plus a strap off the wall.
  const c = { ...w.conduit, x: ports === 2 ? w.dual.conduitX : w.conduit.x };
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
