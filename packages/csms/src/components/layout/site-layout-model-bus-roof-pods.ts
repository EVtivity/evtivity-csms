// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The roof equipment of the 3D layout city bus: the battery packs and the
// air conditioner. Each is a low housing with sloped, radiused ends (a side
// profile extruded across the roof, its edges rounded), lid seams and side
// vents; the air conditioner has two condenser fan grilles on top. Frame of
// each kit: centered on the origin in x and z, standing on y = 0 (the roof),
// its length along z.

import type { CarMaterials } from './site-layout-car-geometry';
import {
  ModelParts,
  boxG,
  cylG,
  sideProfileG,
  torusG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Sizes of the eCitaro roof (Mercedes-Benz eCitaro technical brochure: roof
 * battery modules and the air conditioner reach the 3.40 m overall height
 * over a 3.10 m roof). Derived: the end slope runs over twice the housing
 * height (a 1:2 ramp, so the outline matches the brochure side view), the
 * edge radius is a third of the height, the lid seams follow the module pitch
 * (four modules a pack: length / 4), the fan grilles are 0.5 m across, two
 * on the 1.6 m unit at a quarter of its length from each end.
 */
export const BUS_ROOF_POD = {
  battery: { lengthM: 3.2, widthM: 1.75, heightM: 0.27, modules: 4 },
  hvac: { lengthM: 1.6, widthM: 1.65, heightM: 0.3, fanRadiusM: 0.25 },
  ventSlats: 4,
} as const;

/** A housing outline ([z, y]): flat base, sloped ends a 1:2 ramp, flat top. */
function housingOutline(length: number, height: number): Pt[] {
  const l = length / 2;
  const ramp = Math.min(length / 4, height * 2);
  return [
    [-l, 0],
    [l, 0],
    [l, height * 0.35],
    [l - ramp, height],
    [-l + ramp, height],
    [-l, height * 0.35],
  ];
}

/** Side vents: a frame and angled slats on both long sides at `z`. */
function addVents(
  parts: ModelParts<Slot>,
  width: number,
  height: number,
  z: number,
  length: number,
): void {
  const n = BUS_ROOF_POD.ventSlats;
  const h = height * 0.5;
  for (const side of [-1, 1]) {
    const x = side * (width / 2 + 0.004);
    parts.add('trim', boxG(0.006, h + 0.03, length + 0.03), { at: [x, height * 0.5, z] });
    for (let i = 0; i < n; i += 1) {
      parts.add('panel', boxG(0.012, 0.012, length), {
        at: [x + side * 0.004, height * 0.5 - h / 2 + (h / n) * (i + 0.5), z],
        rot: [0, 0, side * 0.6],
      });
    }
  }
}

/** A battery pack: the housing, a lid seam between each module, a vent pair per side. */
export function createBusBatteryPodKit(): ModelKit<Slot> {
  const b = BUS_ROOF_POD.battery;
  const parts = new ModelParts<Slot>();
  const r = b.heightM / 3;
  parts.add('panel', sideProfileG(housingOutline(b.lengthM, b.heightM), b.widthM, r));
  const pitch = b.lengthM / b.modules;
  for (let i = 1; i < b.modules; i += 1) {
    const z = -b.lengthM / 2 + pitch * i;
    parts.add('trim', boxG(b.widthM - 2 * r, 0.006, 0.014), { at: [0, b.heightM + 0.002, z] });
  }
  for (const z of [-pitch, pitch]) addVents(parts, b.widthM, b.heightM, z, pitch * 0.5);
  return parts.kit();
}

/** The air conditioner: the housing, two condenser fan grilles on top, intake vents on the sides. */
export function createBusHvacKit(): ModelKit<Slot> {
  const a = BUS_ROOF_POD.hvac;
  const parts = new ModelParts<Slot>();
  parts.add('panel', sideProfileG(housingOutline(a.lengthM, a.heightM), a.widthM, a.heightM / 3));
  const fr = a.fanRadiusM;
  for (const z of [-a.lengthM / 4, a.lengthM / 4]) {
    const y = a.heightM + 0.004;
    // A dark fan well, the grille ring, a hub and four guard bars.
    parts.add('trim', cylG(fr * 0.95, fr * 0.95, 0.008, 18), { at: [0, y, z] });
    parts.add('rim', torusG(fr, 0.014, 4, 18), { at: [0, y + 0.006, z], rot: [Math.PI / 2, 0, 0] });
    parts.add('rim', cylG(fr * 0.22, fr * 0.22, 0.02, 10), { at: [0, y + 0.006, z] });
    for (let i = 0; i < 4; i += 1) {
      parts.add('rim', boxG(fr * 1.9, 0.008, 0.012), {
        at: [0, y + 0.01, z],
        rot: [0, (i * Math.PI) / 4, 0],
      });
    }
  }
  addVents(parts, a.widthM, a.heightM, 0, a.lengthM * 0.3);
  return parts.kit();
}
