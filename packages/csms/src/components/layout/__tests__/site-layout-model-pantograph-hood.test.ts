// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  PANTOGRAPH_HOOD,
  PANTOGRAPH_HOOD_HANGER_M,
  PANTOGRAPH_HOOD_RAIL_Y,
  createPantographHoodKit,
  pantographUpBoomY,
} from '../site-layout-model-pantograph-hood';
import { PANTOGRAPH_POLE, createPantographPoleKit } from '../site-layout-model-pantograph-pole';
import { boundsOf, depotMaterials } from './depot-model-helpers';

describe('pantograph hood', () => {
  it('is 1.4 by 0.7 m with the rails at the origin, under 4500 triangles', () => {
    const kit = createPantographHoodKit(0.2);
    expect(kit.triangles).toBeLessThan(4500);
    const b = boundsOf(kit.build(depotMaterials()));
    expect(b.max.x - b.min.x).toBeCloseTo(PANTOGRAPH_HOOD.widthM, 2);
    expect(b.max.z - b.min.z).toBeCloseTo(PANTOGRAPH_HOOD.depthM + 0.02, 2);
    expect(b.min.y).toBeCloseTo(PANTOGRAPH_HOOD.mouthM - 0.01, 2);
    expect(b.max.y).toBeCloseTo(PANTOGRAPH_HOOD.topM + 0.2, 2);
  });

  it('keeps every rail inside the trough mouth', () => {
    for (const z of PANTOGRAPH_HOOD.rail.zs) {
      expect(Math.abs(z)).toBeLessThan(PANTOGRAPH_HOOD.depthM / 2);
    }
    expect(PANTOGRAPH_HOOD.rail.lengthM).toBeLessThan(PANTOGRAPH_HOOD.widthM);
  });

  it('hangs below the boom of a hood pole, with the bus roof pantograph in its working range', () => {
    const boomY = pantographUpBoomY(PANTOGRAPH_POLE.boom.heightM);
    const boomBottom = boomY - PANTOGRAPH_POLE.boom.heightM / 2;
    expect(PANTOGRAPH_HOOD_RAIL_Y + PANTOGRAPH_HOOD.topM + PANTOGRAPH_HOOD_HANGER_M).toBeCloseTo(
      boomBottom,
      6,
    );
    // A 3.38 m bus roof: the shoes rise 1.5 to 1.8 m to the rails.
    const rise = PANTOGRAPH_HOOD_RAIL_Y - 3.38;
    expect(rise).toBeGreaterThanOrEqual(1.5);
    expect(rise).toBeLessThanOrEqual(1.8);
  });

  it('builds a hood pole without pantograph frames, its top 0.14 m above the boom', () => {
    const boomY = pantographUpBoomY(PANTOGRAPH_POLE.boom.heightM);
    const withFrames = createPantographPoleKit({ boomY });
    const hoods = createPantographPoleKit({ boomY, frames: false });
    expect(hoods.triangles).toBeLessThan(withFrames.triangles);
    const b = boundsOf(hoods.build(depotMaterials()));
    expect(b.max.y).toBeCloseTo(boomY + (PANTOGRAPH_POLE.heightM - PANTOGRAPH_POLE.boomY), 1);
  });
});
