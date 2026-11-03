// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NEMA3R_PANEL } from '../site-layout-model-nema3r-enclosure';
import { POWER_SLOTS, type PowerKit, type PowerSlot } from '../site-layout-model-power-slots';
import { WALL_PANELBOARD, createWallPanelboardKit } from '../site-layout-model-wall-panelboard';

function materials(): Record<PowerSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(POWER_SLOTS.map((s) => [s, m])) as unknown as Record<
    PowerSlot,
    THREE.Material
  >;
}

function slotBounds(kit: PowerKit, slot: PowerSlot): THREE.Box3 {
  const mesh = kit.build(materials()).getObjectByName(slot);
  if (mesh == null) throw new Error(slot);
  return new THREE.Box3().setFromObject(mesh);
}

describe('wall panelboard', () => {
  it('hangs the enclosure with its bottom at 0.68 m (2010 ADA 307.2) under 2500 triangles', () => {
    const { kit } = createWallPanelboardKit();
    expect(kit.triangles).toBeLessThan(2500);
    const body = slotBounds(kit, 'body');
    expect(body.min.y).toBeCloseTo(WALL_PANELBOARD.bottomM, 3);
    expect(body.min.y).toBeLessThan(0.686);
    expect(slotBounds(kit, 'door').max.z).toBeCloseTo(
      WALL_PANELBOARD.backZ + NEMA3R_PANEL.depthM,
      3,
    );
    // Nothing goes into the wall.
    const all = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(all.min.z).toBeGreaterThanOrEqual(-1e-6);
  });

  it('runs the conduit down the wall to grade', () => {
    const { kit } = createWallPanelboardKit();
    const conduit = slotBounds(kit, 'conduit');
    expect(conduit.min.y).toBeLessThanOrEqual(0.001);
    expect(conduit.max.y).toBeCloseTo(WALL_PANELBOARD.bottomM, 3);
    expect(conduit.min.z).toBeGreaterThan(0);
  });
});
