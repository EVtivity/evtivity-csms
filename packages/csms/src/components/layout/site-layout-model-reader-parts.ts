// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Parts shared by the card reader models of the 3D site layout (the screen
// reader and the contactless reader): the material slots, the mounting bracket, the EMVCo
// contactless indicator and a rounded outline.
//
// Reader frame: the host surface (dispenser front, pedestal front, wall) is
// the plane z = 0, the reader stands out along +z and faces +z, x across it,
// y up. The origin is the mount point `readerMount` returns; the card
// interface (screen or landing zone) is centered at x = 0, y =
// `READER_INTERFACE_Y_M`.

import { READER_INTERFACE_ABOVE_MOUNT_M } from './site-layout-grid';
import {
  ModelParts,
  boxG,
  frontProfileG,
  torusG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';

/** The material slots of a card reader. */
export const READER_SLOTS = [
  /** The housing. */
  'body',
  /** The black front bezel. */
  'bezel',
  /** The lit color touchscreen (the screen reader only): an emissive material. */
  'screen',
  /** The contactless landing zone face (the contactless reader), a light satin plastic. */
  'zone',
  /** The printed contactless indicator. */
  'mark',
  /** The status LEDs (emissive, colored by the scene). */
  'light',
  /** The steel bracket. */
  'metal',
  /** The chip slot throat (dark). */
  'slot',
] as const;
export type ReaderSlot = (typeof READER_SLOTS)[number];
export type ReaderKit = ModelKit<ReaderSlot>;

/** The scale the scene draws readers at, so they read at site scale. */
export const READER_SCENE_SCALE = 1.5;

/**
 * The height of the card interface center above the mount point in the
 * model's own (life size) units: scaled by `READER_SCENE_SCALE` it lands
 * `READER_INTERFACE_ABOVE_MOUNT_M` above the mount, as `readerMount` expects.
 */
export const READER_INTERFACE_Y_M = READER_INTERFACE_ABOVE_MOUNT_M / READER_SCENE_SCALE;

/**
 * The bracket: a 3 mm steel plate on the host and a boxed arm that stands
 * the reader 25 mm off the surface (a reader bezel needs room behind it for
 * its cable; ID TECH ships both models for panel or bracket mounting).
 */
export const READER_BRACKET = {
  plate: { widthM: 0.05, heightM: 0.07, thicknessM: 0.003 },
  arm: { widthM: 0.03, heightM: 0.04 },
  standoffM: 0.025,
} as const;

/** A centered rounded rectangle outline, counter clockwise. */
export function roundRectPts(w: number, h: number, r: number, n = 3): Pt[] {
  const c = Math.min(r, w / 2, h / 2);
  const corners: Array<readonly [number, number, number]> = [
    [w / 2 - c, -h / 2 + c, -Math.PI / 2],
    [w / 2 - c, h / 2 - c, 0],
    [-w / 2 + c, h / 2 - c, Math.PI / 2],
    [-w / 2 + c, -h / 2 + c, Math.PI],
  ];
  const pts: Pt[] = [];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i += 1) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cx + c * Math.cos(a), cy + c * Math.sin(a)]);
    }
  }
  return pts;
}

/** Adds the bracket (plate on the host, arm to the reader back at z = standoff), centered on (0, y). */
export function addReaderBracket(p: ModelParts<ReaderSlot>, y: number): void {
  const b = READER_BRACKET;
  p.add(
    'metal',
    frontProfileG(roundRectPts(b.plate.widthM, b.plate.heightM, 0.006), b.plate.thicknessM),
    {
      at: [0, y, b.plate.thicknessM / 2],
    },
  );
  p.add('metal', boxG(b.arm.widthM, b.arm.heightM, b.standoffM - b.plate.thicknessM), {
    at: [0, y, (b.standoffM + b.plate.thicknessM) / 2],
  });
}

/**
 * The EMVCo contactless indicator: four concentric arcs opening to +x,
 * `sizeM` across (the arc span), standing `tubeM` proud of the face at z.
 * EMVCo Contactless Indicator Reproduction Requirements: four arcs of
 * growing radius, at least 10 mm high on a reader.
 */
export function addContactlessMark(
  p: ModelParts<ReaderSlot>,
  at: readonly [number, number, number],
  sizeM: number,
  tubeM = 0.0008,
): void {
  const arc = Math.PI / 2.4;
  for (let i = 0; i < 4; i += 1) {
    const r = sizeM * (0.25 + i * 0.25);
    p.add('mark', torusG(r, tubeM, 3, 8, arc), {
      at: [at[0] - sizeM * 0.6, at[1], at[2]],
      rot: [0, 0, -arc / 2],
    });
  }
}

/** A row of `count` round status LEDs centered at `at`, `pitchM` apart, along x. */
export function addLedRow(
  p: ModelParts<ReaderSlot>,
  at: readonly [number, number, number],
  count: number,
  pitchM: number,
  radiusM = 0.0018,
): void {
  for (let i = 0; i < count; i += 1) {
    const x = at[0] + (i - (count - 1) / 2) * pitchM;
    p.add('light', frontProfileG(roundRectPts(radiusM * 2, radiusM * 2, radiusM, 2), 0.0012), {
      at: [x, at[1], at[2]],
    });
  }
}
