// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A tie-rod entrance canopy: an aluminum deck with a soffit, a J-shaped
// fascia on the front and both ends, a wall channel, two tie rods with
// clevises and wall plates, and recessed downlights in the soffit.
//
// Facade frame: see `site-layout-model-facade-parts.ts` (wall face z = 0,
// x from the canopy's left end, y = 0 at the underside of the soffit; the
// rods rise above it to the wall).

import {
  ModelParts,
  boxG,
  cylG,
  frontProfileG,
  polyTubeG,
  sideProfileG,
} from './site-layout-model-kit';
import type { FacadeKit, FacadeSlot } from './site-layout-model-facade-parts';

/**
 * Derived (no source gives these for a generic canopy): the fascia height is
 * a twelfth of the projection, at least 0.2 m (8 in, the common extruded
 * fascia), so a 2.4 m canopy has a 0.2 m fascia; the deck is 60 percent of
 * the fascia; the tie rods rise 37 degrees (3 up for 4 out) from the fascia
 * top at 85 percent of the projection to the wall, set in from each end by
 * an eighth of the width; rods 3/4 in (19 mm), wall plates 0.15 m square.
 * The integrator keeps the soffit at least 7 ft (2134 mm) above the walk,
 * the IBC 3105.3 awning clearance.
 */
export const FACADE_CANOPY = {
  minFasciaM: 0.2,
  deckOfFascia: 0.6,
  rodRise: 0.75,
  rodAtDepth: 0.85,
  rodRadiusM: 0.0095,
  wallPlateM: 0.15,
  lightRadiusM: 0.06,
} as const;

export interface FacadeCanopyOptions {
  widthM: number;
  depthM: number;
  /** Downlights in the soffit (default: one per 1.5 m of width). */
  lights?: number;
}

/** The fascia height of a canopy `depthM` deep. */
export function canopyFasciaM(depthM: number): number {
  return Math.max(FACADE_CANOPY.minFasciaM, depthM / 12);
}

/** A canopy `widthM` along the facade, projecting `depthM` from the wall. */
export function createFacadeCanopyKit(o: FacadeCanopyOptions): FacadeKit {
  const c = FACADE_CANOPY;
  const p = new ModelParts<FacadeSlot>();
  const fh = canopyFasciaM(o.depthM);
  const deck = fh * c.deckOfFascia;
  const t = 0.004;
  // The deck and soffit.
  p.add('frame', boxG(o.widthM - 2 * t, deck, o.depthM - t), {
    at: [o.widthM / 2, deck / 2, (o.depthM - t) / 2],
  });
  // The J fascia: a section [z, y] with a lip turned in at the top and a drip at the bottom.
  const j = (len: number): ReturnType<typeof sideProfileG> =>
    sideProfileG(
      [
        [0, -0.02],
        [t, -0.02],
        [t, fh - 0.02 - t],
        [-0.03, fh - 0.02 - t],
        [-0.03, fh - 0.02],
        [0, fh - 0.02],
      ].map(([z, y]) => [(z ?? 0) + o.depthM - t, y ?? 0] as const),
      len,
      0.001,
    );
  p.add('fascia', j(o.widthM), { at: [o.widthM / 2, 0, 0] });
  // The end fascias: the same J section, its lip turned inward, running back to the wall.
  for (const [x, inward] of [
    [0, 1],
    [o.widthM, -1],
  ] as const) {
    const section = [
      [0, -0.02],
      [inward * t, -0.02],
      [inward * t, fh - 0.02 - t],
      [inward * 0.03, fh - 0.02 - t],
      [inward * 0.03, fh - 0.02],
      [0, fh - 0.02],
    ].map(([sx, sy]) => [x + (sx ?? 0), sy ?? 0] as const);
    p.add('fascia', frontProfileG(section, o.depthM - t, 0.001), {
      at: [0, 0, (o.depthM - t) / 2],
    });
  }
  // The wall channel the deck hangs from.
  p.add('frame', boxG(o.widthM, deck + 0.04, 0.03), { at: [o.widthM / 2, deck / 2, 0.015] });
  // The tie rods: from a clevis on the fascia top to a wall plate above.
  const rz = o.depthM * c.rodAtDepth;
  const rise = rz * c.rodRise;
  const top = fh - 0.02;
  for (const rx of [o.widthM / 8, (o.widthM * 7) / 8]) {
    p.add(
      'metal',
      polyTubeG(
        [
          [rx, top, rz],
          [rx, top + rise, 0.02],
        ],
        c.rodRadiusM,
        8,
      ),
    );
    p.add('metal', boxG(0.03, 0.05, 0.04), { at: [rx, top + 0.02, rz] });
    p.add('metal', boxG(c.wallPlateM, c.wallPlateM, 0.012), { at: [rx, top + rise, 0.006] });
    p.add('metal', boxG(0.03, 0.06, 0.05), { at: [rx, top + rise, 0.035] });
  }
  // Downlights in the soffit.
  const n = Math.max(1, o.lights ?? Math.round(o.widthM / 1.5));
  for (let i = 0; i < n; i += 1) {
    const x = (o.widthM * (i + 0.5)) / n;
    p.add('metal', cylG(c.lightRadiusM + 0.01, c.lightRadiusM + 0.01, 0.006, 16), {
      at: [x, -0.003, o.depthM / 2],
    });
    p.add('light', cylG(c.lightRadiusM, c.lightRadiusM, 0.002, 16), {
      at: [x, -0.007, o.depthM / 2],
    });
  }
  return p.kit();
}
