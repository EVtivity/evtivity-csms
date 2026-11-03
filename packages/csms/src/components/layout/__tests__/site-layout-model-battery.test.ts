// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BATTERY_CABINET,
  BATTERY_SLOTS,
  createBatteryCabinetKit,
  type BatterySlot,
} from '../site-layout-model-battery';

function materials(): Record<BatterySlot, THREE.Material> {
  return Object.fromEntries(
    BATTERY_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<BatterySlot, THREE.Material>;
}

describe('battery storage cabinet', () => {
  it('keeps the scene envelope and stays under 8000 triangles', () => {
    const kit = createBatteryCabinetKit();
    expect(kit.triangles).toBeLessThan(8000);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeCloseTo(BATTERY_CABINET.roofTopY, 2);
    expect(b.min.x).toBeCloseTo(-BATTERY_CABINET.pad.widthM / 2, 2);
    expect(b.max.x).toBeLessThan(2.15);
    expect(b.max.z - b.min.z).toBeCloseTo(BATTERY_CABINET.pad.depthM, 2);
  });

  it('puts the HVAC fan guard on the +x end and uses every slot', () => {
    const kit = createBatteryCabinetKit();
    for (const s of BATTERY_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const metal = kit.build(materials()).getObjectByName('metal');
    if (metal == null) throw new Error('no metal mesh');
    const m = new THREE.Box3().setFromObject(metal);
    expect(m.max.x).toBeGreaterThan(BATTERY_CABINET.lengthM / 2 + BATTERY_CABINET.hvac.outM);
  });
});
