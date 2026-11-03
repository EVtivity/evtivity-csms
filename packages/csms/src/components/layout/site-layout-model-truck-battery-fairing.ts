// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The side battery packs of the 3D layout trucks and their painted fairings,
// both sides: a dark pack enclosure on the frame rail, covered by a fairing
// skin with a radiused front, a tapered rear, two access panel shut lines and
// a cooling vent. Built in the vehicle frame (nose at z = 0, body along +z).

import type { CarMaterials } from './site-layout-car-geometry';
import {
  ModelParts,
  boxG,
  roundBoxG,
  sideProfileG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Freightliner eM2 and eCascadia carry the battery packs on the frame rails
 * between the cab and the drive axle behind side fairings (spec sheets). The
 * shape is derived from the pack size each kit gives: the fairing covers the
 * top 85 percent of the pack, its front edge radiused by a quarter of the
 * height, its rear bottom corner cut back by 40 percent of the height (a
 * fairing tapers toward the wheels to clear the tire spray), access panel
 * shut lines at a third and two thirds of the length, a vent of 4 slats in
 * the front 15 percent.
 */
export const TRUCK_BATTERY_FAIRING = {
  coverShare: 0.85,
  frontRadiusShare: 0.25,
  rearTaperShare: 0.4,
  skinM: 0.04,
  ventSlats: 4,
} as const;

export interface TruckBatteryFairingInput {
  /** The fairing's outer face, half the width across both sides. */
  outerX: number;
  /** How far the pack reaches inboard from the fairing. */
  packDepth: number;
  centerY: number;
  centerZ: number;
  length: number;
  height: number;
}

/** The fairing side outline ([z, y], centered): a quarter arc at the front top and bottom, a cut rear bottom. */
export function fairingOutline(length: number, height: number): Pt[] {
  const f = TRUCK_BATTERY_FAIRING;
  const l = length / 2;
  const h = height / 2;
  const r = height * f.frontRadiusShare;
  const taper = height * f.rearTaperShare;
  const arc = (cz: number, cy: number, from: number, to: number): Pt[] =>
    Array.from({ length: 5 }, (_, i) => {
      const a = from + ((to - from) * i) / 4;
      return [cz + r * Math.cos(a), cy + r * Math.sin(a)] as const;
    });
  return [
    ...arc(-l + r, -h + r, Math.PI, Math.PI * 1.5),
    [l - taper, -h],
    [l, -h + taper],
    [l, h],
    ...arc(-l + r, h - r, Math.PI / 2, Math.PI),
  ];
}

export function createTruckBatteryFairingKit(input: TruckBatteryFairingInput): ModelKit<Slot> {
  const f = TRUCK_BATTERY_FAIRING;
  const parts = new ModelParts<Slot>();
  const skinH = input.height * f.coverShare;
  const skinY = input.centerY + (input.height - skinH) / 2;
  const outline = fairingOutline(input.length, skinH);
  for (const side of [-1, 1]) {
    const skinX = side * (input.outerX - f.skinM / 2);
    parts.add('trim', roundBoxG(input.packDepth, input.height, input.length * 0.8, 0.04), {
      at: [side * (input.outerX - f.skinM - input.packDepth / 2), input.centerY, input.centerZ],
    });
    parts.add('paint', sideProfileG(outline, f.skinM, 0.012), {
      at: [skinX, skinY, input.centerZ],
    });
    const x = side * (input.outerX + 0.001);
    for (const share of [1 / 3, 2 / 3]) {
      parts.add('trim', boxG(0.006, skinH * 0.86, 0.01), {
        at: [x, skinY, input.centerZ - input.length / 2 + input.length * share],
      });
    }
    // The cooling vent near the front: a dark frame and slats.
    const ventZ = input.centerZ - input.length / 2 + input.length * 0.1;
    const ventH = skinH * 0.45;
    parts.add('trim', roundBoxG(0.008, ventH, input.length * 0.1, 0.01), {
      at: [x, skinY, ventZ],
    });
    for (let i = 0; i < f.ventSlats; i += 1) {
      parts.add('panel', boxG(0.014, 0.01, input.length * 0.085), {
        at: [x + side * 0.004, skinY - ventH / 2 + (ventH / f.ventSlats) * (i + 0.5), ventZ],
        rot: [0, 0, side * 0.6],
      });
    }
  }
  return parts.kit();
}
