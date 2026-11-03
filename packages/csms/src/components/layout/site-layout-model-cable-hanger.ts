// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cable hanger every charger loops its idle cable over (owner rule
// 2026-11-02: every holstered cable hangs looped on a hanger on the charger
// body), typical of the cable saddles and hooks sold with chargers and for
// them: a powder coated steel base plate on the body face, a bent arm, a
// curved saddle (a half round channel the cable bends over, never tighter
// than six cable diameters), a raised lip at each end of the saddle so the
// loops cannot slide off, and a rubber cushion on its top.
//
// Frame: the mounting face is z = 0, the hanger stands out along +z, y up.
// The saddle's axis runs along `axis`: 'out' (a peg: the loops hang parallel
// to the face) or 'along' (a bar along x: the loops hang in a plane at right
// angles to the face). The saddle's arc center is at `saddleCenter`.

import * as THREE from 'three';
import { ModelParts, boxG, cylG, frontProfileG } from './site-layout-model-kit';
import type { ModelKit, Pt, Vec3 } from './site-layout-model-kit';

/** The material slots of the hanger. */
export const CABLE_HANGER_SLOTS = [
  /** The powder coated steel plate, arm, saddle and lips. */
  'body',
  /** Steel: the screws. */
  'metal',
  /** The rubber cushion on the saddle top. */
  'rubber',
] as const;
export type CableHangerSlot = (typeof CABLE_HANGER_SLOTS)[number];
export type CableHangerKit = ModelKit<CableHangerSlot>;

export interface CableHangerSpec {
  /** The saddle's radius (the cable's bend radius over it less the cable radius). */
  radiusM: number;
  /** The saddle's width along its axis (room for the turns side by side). */
  widthM: number;
  /** How far out from the face the saddle's near edge stands. */
  standoffM: number;
  axis: 'out' | 'along';
}

/**
 * The hanger for a cable of `cableDiameterM` holding `turns` turns:
 * saddle radius six cable diameters (the bend rule of the cable glands), the
 * saddle as wide as the turns side by side with 15 percent play and 20 mm to
 * each lip, standing 30 mm out from the face. Derived.
 */
export function cableHangerSpec(
  cableDiameterM: number,
  turns: number,
  axis: 'out' | 'along',
): CableHangerSpec {
  return {
    radiusM: 6 * cableDiameterM,
    widthM: turns * cableDiameterM * 1.15 + 0.04,
    standoffM: 0.03,
    axis,
  };
}

/** The saddle's arc center in the hanger frame: above the arm, out from the face. */
export function cableHangerSaddleCenter(spec: CableHangerSpec): Vec3 {
  // A peg: its axis out of the face, the arc center on that axis.
  // A bar: its arc center out past the standoff by the radius, the channel,
  // its cushion and 20 mm, so the near side of the loops clears the face.
  return spec.axis === 'out'
    ? [0, 0, spec.standoffM + spec.widthM / 2]
    : [0, 0, spec.standoffM + spec.radiusM + 0.033];
}

/** The half round saddle channel [u, v] about its center line, counter clockwise: the top half of a ring 10 mm thick. */
function channel(r: number): Pt[] {
  const n = 14;
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (Math.PI * i) / n;
    outer.push([(r + 0.005) * Math.cos(a), (r + 0.005) * Math.sin(a)]);
    inner.push([(r - 0.005) * Math.cos(a), (r - 0.005) * Math.sin(a)]);
  }
  return [...outer, ...inner.reverse()];
}

/** A lip: a half disc a little larger than the saddle, closing one end. */
function lip(r: number): Pt[] {
  const n = 14;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (Math.PI * i) / n;
    pts.push([(r + 0.025) * Math.cos(a), (r + 0.025) * Math.sin(a)]);
  }
  pts.push([-(r + 0.025), -0.02], [r + 0.025, -0.02]);
  return pts;
}

/**
 * The hanger, its saddle top `spec.radiusM + 0.005` above the frame origin's
 * height plus the saddle center: place the group so `cableHangerSaddleCenter`
 * lands where the coil's saddle arc center is.
 */
export function createCableHangerKit(spec: CableHangerSpec): CableHangerKit {
  const p = new ModelParts<CableHangerSlot>();
  const r = spec.radiusM;
  const c = cableHangerSaddleCenter(spec);
  const t = 0.006;
  // The base plate with four screws, behind the saddle.
  const plateW = spec.axis === 'along' ? spec.widthM + 0.06 : 0.1;
  const plateH = 0.12 + r;
  p.add('body', boxG(plateW, plateH, t), { at: [0, -plateH / 2 + 0.02, t / 2] });
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      p.add('metal', cylG(0.006, 0.006, 0.004, 10), {
        at: [sx * (plateW / 2 - 0.02), -plateH / 2 + 0.02 + sy * (plateH / 2 - 0.02), t + 0.002],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  if (spec.axis === 'out') {
    // A peg: the channel runs out along z from the plate, a lip at its tip.
    p.add('body', frontProfileG(channel(r), spec.widthM, 0.002), {
      at: [c[0], c[1], c[2]],
    });
    p.add('rubber', frontProfileG(channel(r + 0.008).slice(0), spec.widthM - 0.01), {
      at: [c[0], c[1] + 0.0005, c[2]],
      scale: [1, 1, 1],
    });
    p.add('body', frontProfileG(lip(r), 0.008), {
      at: [c[0], c[1], spec.standoffM + spec.widthM + 0.004],
    });
    // The arm: a bent bracket from the plate under the saddle.
    p.add('body', boxG(0.04, 0.01, spec.standoffM + spec.widthM * 0.6), {
      at: [0, c[1] - 0.012, (spec.standoffM + spec.widthM * 0.6) / 2],
    });
    p.add('body', boxG(0.04, 0.06, 0.01), { at: [0, c[1] - 0.04, t + 0.005] });
  } else {
    // A bar: the channel runs along x, its arc in the y-z plane, a lip at each end.
    const rot: [number, number, number] = [0, Math.PI / 2, 0];
    p.add('body', frontProfileG(channel(r), spec.widthM, 0.002), { at: c, rot });
    p.add('rubber', frontProfileG(channel(r + 0.008), spec.widthM - 0.01), {
      at: [c[0], c[1] + 0.0005, c[2]],
      rot,
    });
    for (const sx of [-1, 1]) {
      p.add('body', frontProfileG(lip(r), 0.008), {
        at: [sx * (spec.widthM / 2 + 0.004), c[1], c[2]],
        rot,
      });
    }
    // Two arms from the plate out to the saddle's near edge, under its ends.
    for (const sx of [-1, 1]) {
      p.add('body', boxG(0.012, 0.03, spec.standoffM + 0.02), {
        at: [sx * (spec.widthM / 2 - 0.01), c[1] - 0.01, (spec.standoffM + 0.02) / 2],
      });
    }
  }
  return p.kit();
}

/** The hanger group built with `materials` (tests and renders). */
export function buildCableHanger(
  spec: CableHangerSpec,
  materials: Readonly<Record<CableHangerSlot, THREE.Material>>,
): THREE.Group {
  return createCableHangerKit(spec).build(materials);
}
