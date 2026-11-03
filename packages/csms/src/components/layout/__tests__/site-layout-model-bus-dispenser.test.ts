// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  BUS_DISPENSER,
  cableArmElbow,
  cableArmOutlet,
  createBusDispenserKit,
} from '../site-layout-model-bus-dispenser';
import { boundsOf, depotMaterials } from './depot-model-helpers';

const TIPS = [
  { x: -0.9, z: 1.3 },
  { x: 0.9, z: 1.3 },
];

describe('bus dispenser with cable arm', () => {
  it('builds the cabinet and two arms at 4.5 m, under 5000 triangles', () => {
    const kit = createBusDispenserKit(TIPS);
    expect(kit.triangles).toBeLessThan(5000);
    const b = boundsOf(kit.build(depotMaterials()));
    expect(b.max.y).toBeGreaterThan(BUS_DISPENSER.armY);
    expect(b.max.y).toBeLessThan(BUS_DISPENSER.armY + 0.3);
    expect(b.min.y).toBeCloseTo(0, 3);
  });

  it('keeps both arm segments equal and bends the elbow outward', () => {
    for (const tip of TIPS) {
      const e = cableArmElbow(tip);
      const a = Math.hypot(e[0], e[2] - BUS_DISPENSER.mast.z);
      const c = Math.hypot(tip.x - e[0], tip.z - e[2]);
      expect(a).toBeCloseTo(c, 6);
      expect(Math.sign(e[0])).toBe(Math.sign(tip.x));
    }
  });

  it('lets the cable leave above a 3.4 m bus roof', () => {
    expect(cableArmOutlet({ x: -0.9, z: 1.3 })[1]).toBeGreaterThan(3.4 + 0.5);
  });
});
