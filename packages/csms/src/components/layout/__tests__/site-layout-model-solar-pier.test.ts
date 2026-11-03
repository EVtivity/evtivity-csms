// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SOLAR_CARPORT } from '../site-layout-solar';
import {
  SOLAR_PIER_SLOTS,
  createSolarPierKit,
  type SolarPierSlot,
} from '../site-layout-model-solar-pier';

function materials(): Record<SolarPierSlot, THREE.Material> {
  return Object.fromEntries(
    SOLAR_PIER_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<SolarPierSlot, THREE.Material>;
}

function boxOf(g: THREE.Object3D, slot: string): THREE.Box3 {
  const o = g.getObjectByName(slot);
  if (o == null) throw new Error(`no ${slot} mesh`);
  return new THREE.Box3().setFromObject(o);
}

describe('solar carport pier', () => {
  it('is a 36 in pier with its grout top at the frame pier top, under 1000 triangles', () => {
    const kit = createSolarPierKit();
    expect(kit.triangles).toBeLessThan(1000);
    const g = kit.build(materials());
    const concrete = boxOf(g, 'concrete');
    expect(concrete.max.x - concrete.min.x).toBeCloseTo(SOLAR_CARPORT.pierDiameterM, 2);
    expect(concrete.min.y).toBeCloseTo(0, 4);
    expect(boxOf(g, 'grout').max.y).toBeCloseTo(SOLAR_CARPORT.pierTopM, 4);
  });

  it('puts the plate on the grout and the rods above it, every slot used', () => {
    const kit = createSolarPierKit();
    for (const s of SOLAR_PIER_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const metal = boxOf(kit.build(materials()), 'metal');
    expect(metal.min.y).toBeCloseTo(SOLAR_CARPORT.pierTopM, 4);
    expect(metal.max.x - metal.min.x).toBeCloseTo(SOLAR_CARPORT.basePlateM, 3);
    expect(metal.max.y).toBeGreaterThan(
      SOLAR_CARPORT.pierTopM + SOLAR_CARPORT.basePlateThickM + 0.05,
    );
  });
});
