// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { BUS_DOOR, createBusDoorKit } from '../site-layout-model-bus-door';
import { kitBounds } from './vehicle-detail-bounds';

describe('bus door', () => {
  it('builds two glazed leaves in frames, the seal and the shut line, to the door size', () => {
    const kit = createBusDoorKit();
    const b = kitBounds(kit);
    expect(b.max.z - b.min.z).toBeCloseTo(BUS_DOOR.widthM + 2 * BUS_DOOR.shutLineOffsetM + 0.01, 2);
    expect(b.min.x).toBeGreaterThan(-0.01);
    expect(b.max.x).toBeLessThan(0.05);
    // Two leaves of glass and one rubber seal, 12 triangles a box.
    expect(kit.slotTriangles.glass).toBe(24);
    expect(kit.slotTriangles.tire).toBe(12);
    expect(kit.triangles).toBeLessThan(300);
  });
});
