// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The precast concrete wheel stop of the 3D site layout. `createSiteWheelStopKit`
// builds the geometry once, merged per material slot; `kit.build(materials)`
// returns a THREE.Group sharing it. Frame: centered on the origin, standing on
// y = 0, its length along x, the face toward the car +z.

import { WHEEL_STOP } from '@evtivity/lib/site-layout';
import {
  ModelParts,
  boxG,
  cylG,
  sideProfileG,
  type ModelKit,
  type Pt,
} from './site-layout-model-kit';

/** Material slots of the wheel stop. */
export const SITE_WHEEL_STOP_SLOTS = ['concrete', 'paint', 'hole', 'metal'] as const;
export type SiteWheelStopSlot = (typeof SITE_WHEEL_STOP_SLOTS)[number];

/**
 * A precast concrete wheel stop (`WHEEL_STOP`: 6 ft by 9 in by 6 in): a
 * section with chamfered top edges, two anchor holes through which rebar pins
 * are driven into the paving, and drain slots under it so water passes along
 * the stall; a yellow stripe painted on the car side. The overall size is
 * WHEEL_STOP's; the details are derived from it, no source gives them:
 * chamfer 1 in (1/6 of the height), holes 1 ft in from each end (1/6 of the
 * length) for 3/4 in pins (#6 rebar) in 1-1/2 in holes (twice the pin), slots
 * 4 in wide and 1-1/2 in high (1/4 of the height) centered between hole and
 * middle.
 */
export const SITE_WHEEL_STOP = {
  lengthM: WHEEL_STOP.lengthM,
  depthM: WHEEL_STOP.depthM,
  heightM: WHEEL_STOP.heightM,
  /** 1 in chamfer on both top edges. */
  chamferM: 0.0254,
  /** The ends are rounded in plan by this radius (formed edge). */
  endRoundM: 0.012,
  /** Anchor holes, 1 ft from each end, 1-1/2 in diameter; 3/4 in pins set in them. */
  holeFromEndM: 0.305,
  holeRadiusM: 0.019,
  pinRadiusM: 0.0095,
  /** Drain slots under it: 4 in wide, 1-1/2 in high, centers along x. */
  slot: { widthM: 0.1016, heightM: 0.038, xs: [-0.46, 0.46] },
  /** Painted stripe on the car-side face: a 3 in band below the chamfer, clear of the slots. */
  stripe: { heightM: 0.076, fromTopM: 0.03 },
} as const;

export type SiteWheelStopKit = ModelKit<SiteWheelStopSlot>;

export function createSiteWheelStopKit(): SiteWheelStopKit {
  const w = SITE_WHEEL_STOP;
  const p = new ModelParts<SiteWheelStopSlot>();
  const hz = w.depthM / 2;
  const c = w.chamferM;
  const top = w.heightM;
  // The section across the stop ([z, y]), counter clockwise seen from +x.
  const section = (bottom: number): Pt[] => [
    [-hz, bottom],
    [hz, bottom],
    [hz, top - c],
    [hz - c, top],
    [-hz + c, top],
    [-hz, top - c],
  ];
  const half = w.lengthM / 2;
  const span = (from: number, to: number, bottom: number, bevel: number): void => {
    const len = to - from;
    if (len <= 0.001) return;
    p.add('concrete', sideProfileG(section(bottom), len, Math.min(bevel, len / 4)), {
      at: [(from + to) / 2, 0, 0],
    });
  };
  // Solid runs between the drain slots, the slot bridges shallower; the outer
  // ends take the formed rounding.
  const cuts = [...w.slot.xs].sort((a, b) => a - b);
  let x0 = -half;
  cuts.forEach((cx) => {
    const a = cx - w.slot.widthM / 2;
    const b = cx + w.slot.widthM / 2;
    span(x0, a, 0, x0 === -half ? w.endRoundM : 0.003);
    span(a, b, w.slot.heightM, 0.003);
    x0 = b;
  });
  span(x0, half, 0, w.endRoundM);
  // The painted stripe on the car side (+z), just proud of the face.
  p.add('paint', boxG(w.lengthM - 0.1, w.stripe.heightM, 0.002), {
    at: [0, top - w.stripe.fromTopM - w.stripe.heightM / 2, hz + 0.001],
  });
  // The anchor holes (dark recess in the top) with the pin heads set in them.
  for (const side of [-1, 1]) {
    const x = side * (half - w.holeFromEndM);
    p.add('hole', cylG(w.holeRadiusM, w.holeRadiusM, 0.002, 14), { at: [x, top + 0.0006, 0] });
    p.add('metal', cylG(w.pinRadiusM, w.pinRadiusM * 0.9, 0.006, 10), {
      at: [x, top - 0.001, 0],
    });
  }
  return p.kit();
}
