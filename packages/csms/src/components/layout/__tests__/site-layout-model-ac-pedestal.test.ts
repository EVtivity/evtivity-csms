// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AC_PEDESTAL,
  acGland,
  acGlandX,
  acHangerSides,
  createAcPedestalKit,
} from '../site-layout-model-ac-pedestal';
import { CHARGER_SLOTS, type ChargerSlot } from '../site-layout-model-charger-parts';

function materials(): Record<ChargerSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(CHARGER_SLOTS.map((s) => [s, m])) as unknown as Record<
    ChargerSlot,
    THREE.Material
  >;
}

describe('AC pedestal model', () => {
  it('builds the 346 mm wide head ending at its top, under 5000 triangles', () => {
    for (const ports of [1, 2] as const) {
      const kit = createAcPedestalKit(ports);
      expect(kit.triangles, String(ports)).toBeLessThan(5000);
      const b = new THREE.Box3().setFromObject(kit.build(materials()));
      // It ends at its head: no top sign (owner decision 2026-11-02).
      expect(b.max.y).toBeCloseTo(AC_PEDESTAL.head.topM, 2);
      // Nothing reaches past the 346 mm head: the hangers and cables are the scene's.
      expect(b.max.x).toBeCloseTo(AC_PEDESTAL.head.widthM / 2, 2);
      expect(b.min.x).toBeCloseTo(-AC_PEDESTAL.head.widthM / 2, 2);
    }
  });

  it('has a cable hanger under each holster, fed from the gland of its port', () => {
    expect(acHangerSides(1)).toEqual([-1]);
    expect(acHangerSides(2)).toEqual([-1, 1]);
    expect(acGlandX(1, -1)).toBe(0);
    expect(acGlandX(2, -1)).toBe(-AC_PEDESTAL.portX);
    expect(acGlandX(2, 1)).toBe(AC_PEDESTAL.portX);
  });

  it('puts the glands under the head in front of the column, so a cable never enters the body', () => {
    const g = acGland(0);
    expect(g.at[2]).toBeGreaterThan(AC_PEDESTAL.post.depthM / 2 + 0.012);
    expect(g.at[2]).toBeLessThan(AC_PEDESTAL.frontZ);
  });

  it('keeps the holsters within the 2010 ADA 308 reach range (15 to 48 in)', () => {
    expect(AC_PEDESTAL.holsterY).toBeGreaterThan(15 * 0.0254);
    expect(AC_PEDESTAL.holsterY).toBeLessThan(48 * 0.0254);
  });
});
