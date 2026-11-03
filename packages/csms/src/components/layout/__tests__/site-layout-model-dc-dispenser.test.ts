// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHARGER_SLOTS, type ChargerSlot } from '../site-layout-model-charger-parts';
import { cableGlandSize } from '../site-layout-model-cable-gland';
import { DC_DISPENSER, createDcDispenserKit } from '../site-layout-model-dc-dispenser';

function materials(): Record<ChargerSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(CHARGER_SLOTS.map((s) => [s, m])) as unknown as Record<
    ChargerSlot,
    THREE.Material
  >;
}

describe('DC dispenser model', () => {
  it('builds the Terra 184 envelope (1900 x 565 x 880 mm) under 4000 triangles', () => {
    const kit = createDcDispenserKit([
      { side: -1, backM: 0, cableDiameterM: 0.0353 },
      { side: 1, backM: 0, cableDiameterM: 0.0353 },
    ]);
    expect(kit.triangles).toBeLessThan(4000);
    const g = kit.build(materials());
    const b = new THREE.Box3().setFromObject(g);
    expect(b.max.y).toBeCloseTo(DC_DISPENSER.heightM, 2);
    // The body is 880 mm deep from its front back; only the back plate stands 6 mm proud.
    expect(Math.abs(b.min.z - (DC_DISPENSER.frontZ - DC_DISPENSER.depthM))).toBeLessThan(0.01);
    // The cable glands stand out of the side walls; nothing else does.
    expect(b.max.x - b.min.x).toBeLessThan(
      DC_DISPENSER.widthM + 2 * cableGlandSize(0.0353).lengthM + 0.01,
    );
    expect(g.children.length).toBeLessThanOrEqual(CHARGER_SLOTS.length);
  });

  it('adds a cable gland per holster, so more holsters add parts', () => {
    const one = createDcDispenserKit([{ side: -1, backM: 0, cableDiameterM: 0.0353 }]);
    const four = createDcDispenserKit([
      { side: -1, backM: 0, cableDiameterM: 0.0353 },
      { side: 1, backM: 0, cableDiameterM: 0.0353 },
      { side: -1, backM: 0.25, cableDiameterM: 0.0353 },
      { side: 1, backM: 0.25, cableDiameterM: 0.0353 },
    ]);
    expect(four.triangles).toBeGreaterThan(one.triangles);
  });
});
