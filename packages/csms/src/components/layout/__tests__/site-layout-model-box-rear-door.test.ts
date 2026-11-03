// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { createBoxRearDoorKit } from '../site-layout-model-box-rear-door';
import { kitBounds } from './vehicle-detail-bounds';

describe('box truck rear door', () => {
  it('frames the roll-up door at the back of the box', () => {
    const kit = createBoxRearDoorKit({ width: 2.6, deck: 1.2, height: 3.96, rearZ: 9.93 });
    const b = kitBounds(kit);
    expect(b.min.z).toBeGreaterThan(9.93 - 0.02);
    expect(b.max.z).toBeLessThan(9.93 + 0.15);
    expect(b.max.x).toBeCloseTo(1.3, 2);
    expect(b.max.y).toBeCloseTo(3.96, 2);
    expect(kit.slotTriangles.rim).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(500);
  });
});
