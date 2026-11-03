// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The concrete pier of a solar carport column with the column's anchor
// plate: a 36 in drilled pier formed in a Sonotube (SOLAR_CARPORT), its top
// edge chamfered 3/4 in as formwork chamfer strips leave it, a 1 in
// non-shrink grout bed, the steel base plate and four anchor rods with
// washers and heavy hex nuts (AISC Design Guide 1, Base Plate and Anchor Rod
// Design: grout bed under the plate, rods at the plate corners). Derived:
// 1 in rods set 60 mm in from the plate edges, 75 mm above the plate.
//
// Frame: the pier axis is y, standing on y = 0 (the paving), centered. The
// grout top is `heightM` (the carport frame's pier top), the plate on it, so
// the column starts at `heightM + plateThickM` as the canopy frame expects.

import { SOLAR_CARPORT } from './site-layout-solar';
import {
  ModelParts,
  boxG,
  cylG,
  latheG,
  sideProfileG,
  type ModelKit,
} from './site-layout-model-kit';

const IN = 0.0254;

export const SOLAR_PIER_SLOTS = ['concrete', 'grout', 'metal'] as const;
export type SolarPierSlot = (typeof SOLAR_PIER_SLOTS)[number];

export const SOLAR_PIER = {
  chamferM: 0.75 * IN,
  groutM: 1 * IN,
  rodRadiusM: 0.5 * IN,
  rodInsetM: 0.06,
  rodAboveM: 0.075,
  nutAcrossM: 1.625 * IN,
  washerRadiusM: 1.25 * IN,
} as const;

export type SolarPierKit = ModelKit<SolarPierSlot>;

export function createSolarPierKit(
  heightM: number = SOLAR_CARPORT.pierTopM,
  diameterM: number = SOLAR_CARPORT.pierDiameterM,
  plateM: number = SOLAR_CARPORT.basePlateM,
  plateThickM: number = SOLAR_CARPORT.basePlateThickM,
): SolarPierKit {
  const s = SOLAR_PIER;
  const p = new ModelParts<SolarPierSlot>();
  const r = diameterM / 2;
  const top = heightM - s.groutM;
  const c = s.chamferM;
  p.add(
    'concrete',
    latheG(
      [
        [r, 0],
        [r, top - c],
        [r - c, top],
        [0, top],
      ],
      28,
    ),
  );
  // The grout bed, a little larger than the plate, its edges sloped.
  const g = plateM / 2 + 0.03;
  p.add(
    'grout',
    sideProfileG(
      [
        [-g - 0.02, top],
        [g + 0.02, top],
        [g, heightM],
        [-g, heightM],
      ],
      2 * g + 0.02,
    ),
  );
  p.add('metal', boxG(plateM, plateThickM, plateM), {
    at: [0, heightM + plateThickM / 2, 0],
  });
  const plateTop = heightM + plateThickM;
  const a = plateM / 2 - s.rodInsetM;
  for (const x of [-a, a]) {
    for (const z of [-a, a]) {
      p.add('metal', cylG(s.rodRadiusM, s.rodRadiusM, s.rodAboveM, 8), {
        at: [x, plateTop + s.rodAboveM / 2, z],
      });
      p.add('metal', cylG(s.washerRadiusM, s.washerRadiusM, 0.005, 12), {
        at: [x, plateTop + 0.0025, z],
      });
      const nr = s.nutAcrossM / Math.sqrt(3);
      p.add('metal', cylG(nr, nr, 0.025, 6), { at: [x, plateTop + 0.005 + 0.0125, z] });
    }
  }
  return p.kit();
}
