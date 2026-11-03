// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EQUIPMENT_BOLLARD } from '../site-layout-links';
import {
  SITE_BOLLARD,
  SITE_BOLLARD_SLOTS,
  createSiteBollardKit,
  type SiteBollardSlot,
} from '../site-layout-model-bollard';

function materials(): Record<SiteBollardSlot, THREE.Material> {
  return Object.fromEntries(
    SITE_BOLLARD_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<SiteBollardSlot, THREE.Material>;
}

describe('pipe bollard', () => {
  it('stands EQUIPMENT_BOLLARD.heightM high on a 6 in pipe and a 12 in footing, under 1200 triangles', () => {
    const kit = createSiteBollardKit();
    expect(kit.triangles).toBeLessThan(1200);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeCloseTo(EQUIPMENT_BOLLARD.heightM, 3);
    expect(b.max.x - b.min.x).toBeCloseTo(SITE_BOLLARD.footing.radiusM * 2, 2);
    expect(SITE_BOLLARD.radiusM * 2).toBeCloseTo(0.168, 3);
  });

  it('uses every material slot and takes a custom height', () => {
    const kit = createSiteBollardKit(1.2);
    for (const s of SITE_BOLLARD_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.max.y).toBeCloseTo(1.2, 3);
  });
});
