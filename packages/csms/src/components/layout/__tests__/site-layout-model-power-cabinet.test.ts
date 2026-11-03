// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { POWER_SLOTS, type PowerKit, type PowerSlot } from '../site-layout-model-power-slots';
import { POWER_CABINET, createPowerCabinetKit } from '../site-layout-model-power-cabinet';

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

describe('split system power cabinet', () => {
  it('builds the Kempower double cabinet (1250 x 2195 x 841 mm) on its pad under 6000 triangles', () => {
    const { kit, padTopM, frontZ } = createPowerCabinetKit();
    expect(kit.triangles).toBeLessThan(6000);
    const body = slotBounds(kit, 'body');
    expect(body.max.x - body.min.x).toBeCloseTo(POWER_CABINET.widthM, 3);
    expect(body.max.z - body.min.z).toBeCloseTo(POWER_CABINET.depthM, 3);
    const all = new THREE.Box3().setFromObject(kit.build(materials()));
    // The roof top; only the lifting eyes stand above it.
    expect(slotBounds(kit, 'trim').max.y - padTopM).toBeCloseTo(POWER_CABINET.heightM, 3);
    expect(all.max.y - padTopM).toBeLessThan(POWER_CABINET.heightM + 0.03);
    expect(frontZ).toBeCloseTo(POWER_CABINET.depthM / 2 + POWER_CABINET.doorThickM, 6);
    // Nothing reaches past the pad.
    const pad = slotBounds(kit, 'concrete');
    expect(all.max.x).toBeLessThanOrEqual(pad.max.x + 1e-6);
    expect(all.max.z).toBeLessThanOrEqual(pad.max.z + 1e-6);
  });

  it('has the doors, hinges, grilles and the roof overhang', () => {
    const { kit } = createPowerCabinetKit();
    for (const slot of ['door', 'metal', 'trim', 'label'] as const) {
      expect(kit.slotTriangles[slot], slot).toBeGreaterThan(0);
    }
    const roof = slotBounds(kit, 'trim');
    expect(roof.max.x - roof.min.x).toBeGreaterThan(POWER_CABINET.widthM + 0.04);
  });
});
