// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FACADE_SLOTS, type FacadeSlot } from '../site-layout-model-facade-parts';
import {
  FACADE_CANOPY,
  canopyFasciaM,
  createFacadeCanopyKit,
} from '../site-layout-model-facade-canopy';

function materials(): Record<FacadeSlot, THREE.Material> {
  return Object.fromEntries(
    FACADE_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<FacadeSlot, THREE.Material>;
}

function slotBox(group: THREE.Group, slot: FacadeSlot): THREE.Box3 {
  const mesh = group.getObjectByName(slot);
  expect(mesh, slot).toBeDefined();
  return new THREE.Box3().setFromObject(mesh as THREE.Object3D);
}

describe('facade entrance canopy', () => {
  const kit = createFacadeCanopyKit({ widthM: 4.6, depthM: 2.4 });
  const g = kit.build(materials());

  it('stays under 1200 triangles', () => {
    expect(kit.triangles).toBeLessThan(1200);
  });

  it('projects its depth from the wall with a fascia across the front and both ends', () => {
    const fascia = slotBox(g, 'fascia');
    expect(fascia.max.z).toBeCloseTo(2.4, 2);
    expect(fascia.min.x).toBeCloseTo(0, 2);
    expect(fascia.max.x).toBeCloseTo(4.6, 2);
    expect(fascia.min.z).toBeLessThan(0.05);
    expect(canopyFasciaM(2.4)).toBeCloseTo(FACADE_CANOPY.minFasciaM, 6);
    expect(canopyFasciaM(6)).toBeCloseTo(0.5, 6);
  });

  it('hangs from tie rods that rise to the wall above the canopy', () => {
    const metal = slotBox(g, 'metal');
    expect(metal.max.y).toBeGreaterThan(canopyFasciaM(2.4) + 2.4 * FACADE_CANOPY.rodAtDepth * 0.7);
    expect(metal.min.z).toBeLessThan(0.02);
  });

  it('sets the downlights in the soffit at its underside', () => {
    const light = slotBox(g, 'light');
    expect(light.max.y).toBeLessThanOrEqual(0);
    const two = createFacadeCanopyKit({ widthM: 4.6, depthM: 2.4, lights: 2 });
    const four = createFacadeCanopyKit({ widthM: 4.6, depthM: 2.4, lights: 4 });
    expect((four.slotTriangles.light ?? 0) / (two.slotTriangles.light ?? 1)).toBeCloseTo(2, 6);
  });
});
