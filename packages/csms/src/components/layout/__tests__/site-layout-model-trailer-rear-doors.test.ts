// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { createTrailerRearDoorsKit } from '../site-layout-model-trailer-rear-doors';
import { kitBounds } from './vehicle-detail-bounds';

describe('trailer rear doors', () => {
  it('hangs the two leaves at the back of the trailer, within its width and height', () => {
    const kit = createTrailerRearDoorsKit({ width: 2.6, floor: 1.25, height: 4.11, rearZ: 21.24 });
    const b = kitBounds(kit);
    expect(b.min.z).toBeGreaterThan(21.24 - 0.02);
    expect(b.max.x).toBeLessThan(1.31);
    expect(b.min.y).toBeGreaterThanOrEqual(1.25 - 0.001);
    expect(b.max.y).toBeCloseTo(4.11, 2);
    expect(kit.slotTriangles.rim).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(1200);
  });
});
