// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ROOF_PANTOGRAPH,
  ROOF_PANTOGRAPH_RISE,
  createRoofPantographKit,
} from '../site-layout-model-roof-pantograph';
import { boundsOf, depotMaterials } from './depot-model-helpers';

describe('bus roof pantograph (Schunk SLS 102)', () => {
  it('reaches the 1.5 to 1.8 m working range and folds below 0.5 m', () => {
    expect(ROOF_PANTOGRAPH_RISE.maxM).toBeGreaterThan(ROOF_PANTOGRAPH.workingM.maxM);
    expect(ROOF_PANTOGRAPH_RISE.minM).toBeLessThan(0.5);
  });

  it('puts the shoe tops at the rise asked for, under 3000 triangles', () => {
    for (const rise of [ROOF_PANTOGRAPH_RISE.minM, 1.5, 1.8]) {
      const kit = createRoofPantographKit(rise);
      expect(kit.triangles, String(rise)).toBeLessThan(3000);
      const b = boundsOf(kit.build(depotMaterials()));
      expect(b.max.y, String(rise)).toBeCloseTo(rise, 2);
      expect(b.min.y).toBeCloseTo(0, 3);
      expect(b.max.x - b.min.x).toBeLessThan(ROOF_PANTOGRAPH.head.widthM + 0.3);
    }
  });
});
