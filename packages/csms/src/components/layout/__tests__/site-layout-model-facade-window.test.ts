// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FACADE_SLOTS, STOREFRONT, type FacadeSlot } from '../site-layout-model-facade-parts';
import { FACADE_WINDOW, createFacadeWindowKit } from '../site-layout-model-facade-window';

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

describe('facade window unit', () => {
  it('stays under 800 triangles for a 6.4 m unit with a transom rail', () => {
    const kit = createFacadeWindowKit({ widthM: 6.4, heightM: 2.1, railM: 1.6 });
    expect(kit.triangles).toBeLessThan(800);
  });

  it('frames the given opening, the frame proud of the wall and the glass behind its face', () => {
    const g = createFacadeWindowKit({ widthM: 3, heightM: 2 }).build(materials());
    const frame = slotBox(g, 'frame');
    // Only the head flashing runs 10 mm past each jamb.
    expect(frame.min.x).toBeCloseTo(-0.01, 3);
    expect(frame.min.y).toBeCloseTo(0, 3);
    expect(frame.min.z).toBeCloseTo(0, 3);
    const glass = slotBox(g, 'glass');
    expect(glass.max.z).toBeLessThan(STOREFRONT.proudM);
    expect(glass.min.z).toBeGreaterThan(0);
  });

  it('hangs a sill below the frame that projects past it', () => {
    const g = createFacadeWindowKit({ widthM: 3, heightM: 2 }).build(materials());
    const sill = slotBox(g, 'sill');
    expect(sill.max.y).toBeLessThanOrEqual(0.0001);
    expect(sill.max.z).toBeCloseTo(STOREFRONT.proudM + FACADE_WINDOW.sill.projectM, 3);
    expect(sill.max.x - sill.min.x).toBeGreaterThan(3);
  });

  it('adds a mullion for every 1.52 m of width', () => {
    const narrow = createFacadeWindowKit({ widthM: 1.4, heightM: 2 });
    const wide = createFacadeWindowKit({ widthM: 4.5, heightM: 2 });
    expect(wide.slotTriangles.frame ?? 0).toBeGreaterThan(narrow.slotTriangles.frame ?? 0);
  });
});
