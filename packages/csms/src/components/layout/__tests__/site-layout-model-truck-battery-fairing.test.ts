// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  createTruckBatteryFairingKit,
  fairingOutline,
} from '../site-layout-model-truck-battery-fairing';
import { kitBounds } from './vehicle-detail-bounds';

describe('truck battery fairing', () => {
  it('rounds the front and tapers the rear bottom of the outline', () => {
    const pts = fairingOutline(1.4, 0.72);
    const zs = pts.map(([z]) => z);
    expect(Math.min(...zs)).toBeCloseTo(-0.7, 3);
    expect(Math.max(...zs)).toBeCloseTo(0.7, 3);
    const bottom = pts.filter(([, y]) => y <= -0.36 + 1e-6).map(([z]) => z);
    expect(Math.max(...bottom)).toBeLessThan(0.7 - 0.2);
  });

  it('covers both packs with painted skins inside the given width', () => {
    const kit = createTruckBatteryFairingKit({
      outerX: 1.33,
      packDepth: 0.7,
      centerY: 0.95,
      centerZ: 4.3,
      length: 1.4,
      height: 0.85,
    });
    const b = kitBounds(kit);
    expect(b.max.x).toBeLessThan(1.35);
    expect(b.min.x).toBeGreaterThan(-1.35);
    expect(b.max.z - b.min.z).toBeLessThan(1.42);
    expect(kit.slotTriangles.paint).toBeGreaterThan(0);
    expect(kit.triangles).toBeLessThan(700);
  });
});
