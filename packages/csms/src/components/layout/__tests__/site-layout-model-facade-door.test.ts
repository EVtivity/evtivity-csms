// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FACADE_SLOTS, type FacadeSlot } from '../site-layout-model-facade-parts';
import { FACADE_DOOR, createFacadeDoorKit, facadeDoorSize } from '../site-layout-model-facade-door';

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

describe('facade storefront entrance', () => {
  it('stays under 1500 triangles for a pair of leaves', () => {
    expect(createFacadeDoorKit(2).triangles).toBeLessThan(1500);
  });

  it('builds 3070 leaves with a transom, the frame to the overall size', () => {
    for (const leaves of [1, 2] as const) {
      const g = createFacadeDoorKit(leaves).build(materials());
      const size = facadeDoorSize(leaves);
      const frame = slotBox(g, 'frame');
      expect(frame.max.x - frame.min.x).toBeCloseTo(size.widthM, 3);
      expect(frame.max.y).toBeCloseTo(size.heightM, 3);
      expect(size.widthM).toBeGreaterThan(leaves * FACADE_DOOR.leaf.widthM);
    }
    // The open leaf and its stop take about 2 in, leaving the 32 in clear width (2010 ADA 404.2.3).
    expect(FACADE_DOOR.leaf.widthM - 2 * 0.0254).toBeGreaterThanOrEqual(32 * 0.0254);
  });

  it('puts the push bar at 38 in, inside the 34 to 48 in reach of the operable parts', () => {
    const g = createFacadeDoorKit(1).build(materials());
    const metal = slotBox(g, 'metal');
    const bar = FACADE_DOOR.pushBar.heightM;
    expect(bar).toBeGreaterThanOrEqual(34 * 0.0254);
    expect(bar).toBeLessThanOrEqual(48 * 0.0254);
    expect(metal.max.z).toBeGreaterThan(FACADE_DOOR.pushBar.standoffM);
  });

  it('keeps the threshold at the 1/2 in maximum', () => {
    const g = createFacadeDoorKit(2).build(materials());
    const sill = slotBox(g, 'sill');
    expect(sill.max.y - sill.min.y).toBeLessThanOrEqual(0.0127 + 0.0005);
    expect(slotBox(g, 'glass').max.y).toBeGreaterThan(FACADE_DOOR.leaf.heightM);
  });
});
