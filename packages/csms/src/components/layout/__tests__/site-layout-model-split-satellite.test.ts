// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { POWER_SLOTS, type PowerKit, type PowerSlot } from '../site-layout-model-power-slots';
import {
  SPLIT_SATELLITE,
  createSplitSatelliteKit,
  satelliteHolsterMount,
} from '../site-layout-model-split-satellite';

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

describe('split system satellite', () => {
  it('builds the Kempower S-Series envelope (300 x 1518 x 300 mm) under 2500 triangles', () => {
    const kit = createSplitSatelliteKit();
    expect(kit.triangles).toBeLessThan(2500);
    const all = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(all.max.y).toBeCloseTo(SPLIT_SATELLITE.heightM, 3);
    const body = slotBounds(kit, 'body');
    // The cap overhangs the column by 5 mm a side.
    expect(body.max.x - body.min.x).toBeCloseTo(SPLIT_SATELLITE.widthM + 0.01, 3);
    expect(body.max.z - body.min.z).toBeCloseTo(SPLIT_SATELLITE.depthM + 0.01, 3);
    // Above the base plate only the holster rails stand out of the side walls.
    expect(all.max.x).toBeCloseTo(SPLIT_SATELLITE.basePlate.sizeM / 2, 3);
    expect(slotBounds(kit, 'metal').max.y).toBeLessThan(SPLIT_SATELLITE.rail.topM + 0.001);
  });

  it('has a tintable front plate, a screen, a status light and a logo area', () => {
    const kit = createSplitSatelliteKit();
    for (const slot of [
      'plate',
      'glass',
      'light',
      'label',
      'door',
      'metal',
      'trim',
      'conduit',
    ] as const) {
      expect(kit.slotTriangles[slot], slot).toBeGreaterThan(0);
    }
    const glass = slotBounds(kit, 'glass');
    expect(glass.getCenter(new THREE.Vector3()).y).toBeCloseTo(SPLIT_SATELLITE.screen.yM, 3);
    expect(glass.min.z).toBeGreaterThan(SPLIT_SATELLITE.depthM / 2);
    expect(slotBounds(kit, 'label').max.z).toBeLessThanOrEqual(-SPLIT_SATELLITE.depthM / 2 + 0.001);
  });

  it('puts the holster mounts on the side walls within the ADA 308 reach range', () => {
    for (const side of [-1, 1] as const) {
      const m = satelliteHolsterMount(side, 0);
      expect(Math.abs(m.x)).toBeCloseTo(SPLIT_SATELLITE.widthM / 2 + 0.015, 6);
      expect(m.y).toBeGreaterThanOrEqual(0.38);
      expect(m.y).toBeLessThanOrEqual(1.22);
    }
  });
});
