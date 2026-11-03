// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A parapet cornice: a frieze band, a cove (quarter circle), the corona with
// a drip groove under its nose, a bed molding, and the metal coping cap over
// the parapet with its sloped top and front leg.
//
// Facade frame: see `site-layout-model-facade-parts.ts` (wall face z = 0,
// x from the cornice's left end, y = 0 at the bottom of the frieze; the
// integrator puts the coping top at the top of the parapet).

import { ModelParts, sideProfileG } from './site-layout-model-kit';
import type { Pt } from './site-layout-model-kit';
import type { FacadeKit, FacadeSlot } from './site-layout-model-facade-parts';

/**
 * Derived from the building height H (8 m, `BUILDING_HEIGHT_M`): a cornice
 * projects about a twentieth of the height, 0.4 m; its height, 0.34 m to the
 * corona top, splits into frieze 0.12, cove radius 0.1 and corona 0.12 (the
 * cove a quarter circle, so its rise equals its run). The coping top slopes back toward the roof at
 * 1:12 (the SMACNA coping minimum) and its front leg laps 50 mm down the
 * corona (the 2 in minimum face leg of ANSI/SPRI ES-1 copings).
 */
export const FACADE_CORNICE = {
  heightM: 0.34,
  projectM: 0.4,
  friezeM: 0.12,
  friezeProjectM: 0.04,
  coveRadiusM: 0.1,
  coronaM: 0.12,
  dripM: 0.012,
  coping: { legM: 0.05, slope: 1 / 12, thicknessM: 0.004 },
  /** How far the coping runs back over the parapet (the wall thickness behind the face). */
  parapetM: 0.3,
} as const;

/** The cornice section [z, y], counter clockwise, from the wall face out. */
export function corniceSection(): Pt[] {
  const c = FACADE_CORNICE;
  const coveY = c.friezeM;
  const coronaY = coveY + c.coveRadiusM;
  const top = coronaY + c.coronaM;
  const pts: Pt[] = [
    [0, 0],
    [c.friezeProjectM, 0],
    [c.friezeProjectM, coveY],
  ];
  // The cove: a quarter circle from the frieze out to the corona soffit.
  const cx = c.friezeProjectM + c.coveRadiusM;
  for (let i = 1; i <= 6; i += 1) {
    const a = Math.PI - (i / 6) * (Math.PI / 2);
    pts.push([cx + c.coveRadiusM * Math.cos(a), coveY + c.coveRadiusM * Math.sin(a)]);
  }
  // The corona soffit with its drip groove, the nose, the bed molding fillet.
  const nose = c.projectM;
  pts.push(
    [nose - 0.04, coronaY],
    [nose - 0.04, coronaY + c.dripM],
    [nose - 0.04 + c.dripM, coronaY + c.dripM],
    [nose - 0.04 + c.dripM, coronaY],
    [nose, coronaY],
    [nose, top - 0.02],
    [nose - 0.02, top],
    [-c.parapetM, top - (nose + c.parapetM) * c.coping.slope],
    [-c.parapetM, 0],
  );
  return pts.filter((pt, i, a) => i === 0 || pt[0] !== a[i - 1]?.[0] || pt[1] !== a[i - 1]?.[1]);
}

/** A cornice `lengthM` long along the facade. */
export function createFacadeCorniceKit(lengthM: number): FacadeKit {
  const c = FACADE_CORNICE;
  const p = new ModelParts<FacadeSlot>();
  p.add('sill', sideProfileG(corniceSection(), lengthM, 0.003), { at: [lengthM / 2, 0, 0] });
  // The coping cap over the corona top and the parapet.
  const top = c.friezeM + c.coveRadiusM + c.coronaM;
  const k = c.coping;
  const front = c.projectM + 0.015;
  const back = -c.parapetM - 0.02;
  const backY = top - (front - back) * k.slope;
  // The cap rests on the sloped top: its underside follows it, its leg laps down the nose.
  const cap: Pt[] = [
    [front, top - k.legM],
    [front, top + k.thicknessM],
    [back, backY + k.thicknessM],
    [back, backY - 0.03],
    [back + k.thicknessM, backY - 0.03],
    [back + k.thicknessM, backY],
    [front - k.thicknessM, top],
    [front - k.thicknessM, top - k.legM],
  ];
  p.add('metal', sideProfileG(cap, lengthM + 0.02), { at: [lengthM / 2, 0, 0] });
  return p.kit();
}
