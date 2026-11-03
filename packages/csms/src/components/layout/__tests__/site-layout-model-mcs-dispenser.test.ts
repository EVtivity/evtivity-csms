// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  MCS_DISPENSER,
  MCS_DISPENSER_HOLSTER,
  createMcsDispenserKit,
} from '../site-layout-model-mcs-dispenser';
import { boundsOf, depotMaterials } from './depot-model-helpers';

describe('MCS dispenser (alpitronic HYC1000 MCS)', () => {
  it('builds the 2320 by 780 mm post, under 3500 triangles', () => {
    const kit = createMcsDispenserKit();
    expect(kit.triangles).toBeLessThan(3500);
    const b = boundsOf(kit.build(depotMaterials()));
    expect(b.max.y).toBeCloseTo(MCS_DISPENSER.heightM, 2);
    expect(b.min.y).toBeCloseTo(0, 3);
    // Only the cable hanger reaches past the +x side.
    expect(b.min.x).toBeCloseTo(-(MCS_DISPENSER.widthM / 2 + 0.02), 2);
    expect(b.max.z).toBeLessThan(MCS_DISPENSER.depthM / 2 + 0.1);
  });

  it('mounts the holster inside the ADA reach range (15 to 48 in)', () => {
    expect(MCS_DISPENSER_HOLSTER[1]).toBeGreaterThan(0.381);
    expect(MCS_DISPENSER_HOLSTER[1]).toBeLessThan(1.219);
  });
});
