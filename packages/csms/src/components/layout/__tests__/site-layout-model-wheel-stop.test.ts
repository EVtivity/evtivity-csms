// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WHEEL_STOP } from '@evtivity/lib/site-layout';
import {
  SITE_WHEEL_STOP_SLOTS,
  createSiteWheelStopKit,
  type SiteWheelStopSlot,
} from '../site-layout-model-wheel-stop';

function materials(): Record<SiteWheelStopSlot, THREE.Material> {
  return Object.fromEntries(
    SITE_WHEEL_STOP_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<SiteWheelStopSlot, THREE.Material>;
}

describe('precast wheel stop', () => {
  it('fills the WHEEL_STOP envelope (1.83 x 0.23 x 0.15 m) under 800 triangles', () => {
    const kit = createSiteWheelStopKit();
    expect(kit.triangles).toBeLessThan(800);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.max.x - b.min.x).toBeCloseTo(WHEEL_STOP.lengthM, 2);
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeGreaterThan(WHEEL_STOP.heightM - 0.001);
    expect(b.max.y - WHEEL_STOP.heightM).toBeLessThan(0.002);
    // The stripe stands 2 mm proud of the car-side face; nothing else does.
    expect(b.max.z - WHEEL_STOP.depthM / 2).toBeLessThan(0.003);
    expect(b.min.z).toBeCloseTo(-WHEEL_STOP.depthM / 2, 3);
  });

  it('uses every material slot', () => {
    const kit = createSiteWheelStopKit();
    for (const s of SITE_WHEEL_STOP_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
  });
});
