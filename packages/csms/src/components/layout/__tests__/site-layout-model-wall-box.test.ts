// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AC_WALL_BOX,
  WALL_BOX_SLOTS,
  createAcWallBoxKit,
  wallBoxDisplay,
  wallBoxFrontZ,
  type WallBoxSlot,
} from '../site-layout-model-wall-box';

function materials(): Record<WallBoxSlot, THREE.Material> {
  return Object.fromEntries(
    WALL_BOX_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<WallBoxSlot, THREE.Material>;
}

function slotBox(group: THREE.Group, slot: WallBoxSlot): THREE.Box3 {
  const mesh = group.getObjectByName(slot);
  expect(mesh, slot).toBeDefined();
  return new THREE.Box3().setFromObject(mesh as THREE.Object3D);
}

describe('AC wall box model (ABB Terra AC UL)', () => {
  const kit = createAcWallBoxKit();
  const group = kit.build(materials());
  const w = AC_WALL_BOX;

  it('stays under 3000 triangles', () => {
    expect(kit.triangles).toBeLessThan(3000);
    expect(group.children.length).toBe(WALL_BOX_SLOTS.length);
  });

  it('has the datasheet envelope (400 x 230 x 125 mm) on its mounting plate', () => {
    const body = slotBox(group, 'body');
    expect(body.max.y - body.min.y).toBeCloseTo(w.heightM, 3);
    expect(body.max.x - body.min.x).toBeCloseTo(w.widthM, 3);
    expect(body.min.y).toBeCloseTo(w.bottomM, 3);
    expect(body.max.z - w.plate.thicknessM).toBeCloseTo(w.depthM, 3);
    expect(slotBox(group, 'metal').max.x * 2).toBeGreaterThan(w.widthM);
  });

  it('curves the fascia out from the edges to mid height', () => {
    expect(wallBoxFrontZ(w.heightM / 2) - wallBoxFrontZ(0)).toBeCloseTo(w.depthM - w.edgeDepthM, 6);
    expect(wallBoxFrontZ(0)).toBeCloseTo(wallBoxFrontZ(w.heightM), 6);
  });

  it('runs the conduit down to grade and puts the cable gland under the box', () => {
    expect(slotBox(group, 'metal').min.y).toBeLessThanOrEqual(0.0001);
    const gland = slotBox(group, 'rubber');
    expect(gland.max.y).toBeLessThanOrEqual(w.bottomM + 0.0001);
    expect(gland.min.y).toBeLessThan(w.bottomM - 0.02);
  });

  it('keeps the display and the light ring on the front, the ring low, and no logo', () => {
    const ring = slotBox(group, 'light');
    expect((ring.min.y + ring.max.y) / 2).toBeCloseTo(w.bottomM + w.ring.centerFromBottomM, 3);
    expect(ring.max.x - ring.min.x).toBeCloseTo(2 * (w.ring.radiusM + w.ring.tubeM), 3);
    expect(group.getObjectByName('logo')).toBeUndefined();
    const d = wallBoxDisplay();
    expect(d.center[1]).toBeGreaterThan(ring.max.y);
    expect(d.center[1]).toBeLessThan(w.bottomM + w.heightM);
    expect(slotBox(group, 'plate').max.z).toBeGreaterThan(slotBox(group, 'body').max.z);
  });

  it('follows the box height it is given', () => {
    const low = createAcWallBoxKit(0.5).build(materials());
    const body = new THREE.Box3().setFromObject(low.getObjectByName('body') as THREE.Object3D);
    expect(body.min.y).toBeCloseTo(0.5, 3);
  });
});
