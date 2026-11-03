// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SOLAR_MODULE,
  SOLAR_MODULE_SLOTS,
  createSolarModuleKit,
  type SolarModuleSlot,
} from '../site-layout-model-solar-module';

function materials(): Record<SolarModuleSlot, THREE.Material> {
  return Object.fromEntries(
    SOLAR_MODULE_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<SolarModuleSlot, THREE.Material>;
}

describe('solar module', () => {
  it('measures 2278 by 1134 by 35 mm and stays under 400 triangles', () => {
    const kit = createSolarModuleKit();
    expect(kit.triangles).toBeLessThan(400);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.max.x - b.min.x).toBeCloseTo(SOLAR_MODULE.widthM, 3);
    expect(b.max.z - b.min.z).toBeCloseTo(SOLAR_MODULE.lengthM, 3);
    expect(b.min.y).toBeCloseTo(0, 4);
    expect(b.max.y).toBeCloseTo(SOLAR_MODULE.thicknessM, 4);
  });

  it('keeps the cells under the frame lip and takes another size', () => {
    const kit = createSolarModuleKit(2.0, 1.0);
    for (const s of SOLAR_MODULE_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const cell = kit.build(materials()).getObjectByName('cell');
    if (cell == null) throw new Error('no cell mesh');
    const c = new THREE.Box3().setFromObject(cell);
    expect(c.max.y).toBeLessThan(SOLAR_MODULE.thicknessM);
    expect(c.max.x).toBeLessThan(0.5 - SOLAR_MODULE.frame.lipM);
    expect(c.max.z).toBeLessThan(1.0 - SOLAR_MODULE.frame.lipM);
    // Six columns of two half-cell strips, one quad each.
    expect(kit.slotTriangles.cell).toBe(SOLAR_MODULE.columns * 2 * 2);
  });
});
