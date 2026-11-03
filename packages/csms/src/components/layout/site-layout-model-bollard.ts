// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The pipe bollard of the 3D site layout. `createSiteBollardKit` builds the
// geometry once, merged per material slot; `kit.build(materials)` returns a
// THREE.Group sharing it. Frame: y up, standing on y = 0, round about y.

import { EQUIPMENT_BOLLARD } from './site-layout-links';
import { ModelParts, cylG, latheG, type ModelKit, type Pt } from './site-layout-model-kit';

/** Material slots of the pipe bollard. */
export const SITE_BOLLARD_SLOTS = ['paint', 'band', 'concrete', 'sleeve'] as const;
export type SiteBollardSlot = (typeof SITE_BOLLARD_SLOTS)[number];

/**
 * A pipe bollard after EWEB standard drawing ED5-1.0800 (equipment protection
 * posts): 6 in Schedule 40 steel pipe (6.625 in, 168.3 mm outside diameter,
 * 0.280 in wall, ASME B36.10M), filled with concrete and crowned with a
 * concrete dome, 3 ft above grade in a round concrete footing whose top is
 * crowned to shed water, painted safety yellow with a reflective band near the
 * top. Derived, no source gives them: footing 12 in across (about twice the
 * pipe), a 3 in band 3 in under the rim, a 40 mm dome (1/4 of the diameter). Height, radius and spacing stay those of `EQUIPMENT_BOLLARD`.
 */
export const SITE_BOLLARD = {
  radiusM: EQUIPMENT_BOLLARD.radiusM,
  heightM: EQUIPMENT_BOLLARD.heightM,
  /** Pipe wall, 0.280 in. */
  wallM: 0.0071,
  /** Rise of the concrete dome over the pipe rim. */
  domeM: 0.04,
  /** The 12 in footing at grade, crowned 25 mm at the pipe. */
  footing: { radiusM: 0.1524, crownM: 0.025 },
  /** The weathered sleeve (expansion joint) ring where the pipe enters the footing. */
  sleeve: { heightM: 0.03, thicknessM: 0.004 },
  /** 3 in (76 mm) reflective band, its top 3 in below the pipe rim. */
  band: { fromRimM: 0.076, heightM: 0.076 },
  segments: 24,
} as const;

export type SiteBollardKit = ModelKit<SiteBollardSlot>;

/** A pipe bollard `heightM` above grade (default `EQUIPMENT_BOLLARD.heightM`). */
export function createSiteBollardKit(heightM: number = SITE_BOLLARD.heightM): SiteBollardKit {
  const b = SITE_BOLLARD;
  const n = b.segments;
  const r = b.radiusM;
  const ri = r - b.wallM;
  const rimY = heightM - b.domeM;
  const p = new ModelParts<SiteBollardSlot>();
  const base = b.footing.crownM;
  // The painted pipe: outside wall, a rounded rim, and the inner wall down to the fill.
  p.add(
    'paint',
    latheG(
      [
        [r, base],
        [r, rimY - 0.004],
        [r - 0.0015, rimY - 0.001],
        [r - b.wallM / 2, rimY],
        [ri + 0.0015, rimY - 0.001],
        [ri, rimY - 0.006],
      ],
      n,
    ),
  );
  // The concrete fill crowned into a dome above the rim.
  const dome: Pt[] = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 6) * (Math.PI / 2);
    return [ri * Math.cos(a), rimY - 0.006 + (b.domeM + 0.006) * Math.sin(a)] as const;
  });
  p.add('concrete', latheG(dome, n));
  // The reflective band, wrapped just proud of the paint.
  p.add('band', cylG(r + 0.0012, r + 0.0012, b.band.heightM, n, true), {
    at: [0, rimY - b.band.fromRimM - b.band.heightM / 2, 0],
  });
  // The sleeve ring where the pipe enters the footing.
  p.add(
    'sleeve',
    latheG(
      [
        [r + b.sleeve.thicknessM, base - 0.002],
        [r + b.sleeve.thicknessM, base + b.sleeve.heightM],
        [r, base + b.sleeve.heightM],
      ],
      n,
    ),
  );
  // The footing top, crowned from the sleeve down to grade.
  const f = b.footing;
  p.add(
    'concrete',
    latheG(
      [
        [r + b.sleeve.thicknessM, f.crownM],
        [f.radiusM * 0.75, f.crownM * 0.55],
        [f.radiusM - 0.008, 0.006],
        [f.radiusM, 0],
      ],
      n,
    ),
  );
  return p.kit();
}
