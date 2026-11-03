// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { LARGE_VEHICLE_SPECS } from '../site-layout-car';
import { createBusDestinationSignKit } from '../site-layout-model-bus-destination-sign';
import { kitBounds } from './vehicle-detail-bounds';

describe('bus destination signs', () => {
  it('lights a front, a side and a rear sign in their housings', () => {
    const bus = LARGE_VEHICLE_SPECS.bus;
    const kit = createBusDestinationSignKit({
      length: bus.length,
      width: bus.width,
      frontFaceZ: 0.1,
    });
    // Three lit panels of 12 triangles each.
    expect(kit.slotTriangles.headlight).toBe(36);
    expect(kit.slotTriangles.trim).toBeGreaterThan(0);
    const b = kitBounds(kit);
    expect(b.min.z).toBeGreaterThan(0);
    expect(b.max.z).toBeLessThan(bus.length + 0.05);
    expect(b.max.x).toBeLessThan(bus.width / 2 + 0.05);
    expect(b.max.y).toBeLessThan(bus.height - 0.3);
  });
});
