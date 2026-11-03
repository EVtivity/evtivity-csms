// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  BUS_ROOF_POD,
  createBusBatteryPodKit,
  createBusHvacKit,
} from '../site-layout-model-bus-roof-pods';
import { kitBounds } from './vehicle-detail-bounds';

describe('bus roof pods', () => {
  it('builds the battery pack to its size on the roof', () => {
    const kit = createBusBatteryPodKit();
    const b = kitBounds(kit);
    const s = BUS_ROOF_POD.battery;
    expect(b.min.y).toBeCloseTo(0, 2);
    expect(b.max.y).toBeLessThan(s.heightM + 0.02);
    expect(b.max.z - b.min.z).toBeCloseTo(s.lengthM, 1);
    expect(b.max.x).toBeLessThan(s.widthM / 2 + 0.03);
    expect(kit.slotTriangles.panel).toBeGreaterThan(0);
    expect(kit.slotTriangles.trim).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(900);
  });

  it('puts two fan grilles on the air conditioner, within the 3.4 m bus height', () => {
    const kit = createBusHvacKit();
    const b = kitBounds(kit);
    expect(b.max.y).toBeLessThan(BUS_ROOF_POD.hvac.heightM + 0.03);
    expect(kit.slotTriangles.rim).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(1200);
  });
});
