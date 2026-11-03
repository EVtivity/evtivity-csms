// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FACADE_SLOTS, type FacadeSlot } from '../site-layout-model-facade-parts';
import {
  FACADE_CORNICE,
  corniceSection,
  createFacadeCorniceKit,
} from '../site-layout-model-facade-cornice';

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

describe('facade cornice', () => {
  const kit = createFacadeCorniceKit(30);
  const g = kit.build(materials());
  const c = FACADE_CORNICE;

  it('stays under 400 triangles at any length', () => {
    expect(kit.triangles).toBeLessThan(400);
    expect(createFacadeCorniceKit(80).triangles).toBe(kit.triangles);
  });

  it('projects 0.4 m and rises 0.34 m to the corona top, the coping above it', () => {
    const body = slotBox(g, 'sill');
    expect(body.max.z).toBeCloseTo(c.projectM, 3);
    expect(body.max.y).toBeCloseTo(c.heightM, 3);
    expect(body.max.x - body.min.x).toBeCloseTo(30, 3);
    const cap = slotBox(g, 'metal');
    expect(cap.max.z).toBeGreaterThan(c.projectM);
    // The front leg laps 50 mm down the nose; the back leg drops over the parapet.
    expect(cap.min.y).toBeLessThanOrEqual(c.heightM - c.coping.legM + 0.0005);
  });

  it('draws the cove as a hollow quarter circle and slopes the top back toward the roof', () => {
    const pts = corniceSection();
    const mid = pts[3 + 2];
    expect(mid).toBeDefined();
    const [z, y] = mid ?? [0, 0];
    // A hollow cove bulges toward the wall: it lies above the straight line from its start to its end.
    const along = (z - c.friezeProjectM) / c.coveRadiusM;
    expect(y - c.friezeM).toBeGreaterThan(along * c.coveRadiusM);
    const back = pts.at(-2);
    expect((back?.[1] ?? 0) < c.heightM).toBe(true);
  });
});
