// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CABLE_HANGER_SLOTS,
  buildCableHanger,
  cableHangerSaddleCenter,
  cableHangerSpec,
  createCableHangerKit,
  type CableHangerSlot,
} from '../site-layout-model-cable-hanger';

function materials(): Record<CableHangerSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(CABLE_HANGER_SLOTS.map((s) => [s, m])) as unknown as Record<
    CableHangerSlot,
    THREE.Material
  >;
}

describe('cable hanger model', () => {
  it('sizes the saddle by the bend rule and the turns it holds', () => {
    const spec = cableHangerSpec(0.0125, 4, 'out');
    expect(spec.radiusM).toBeCloseTo(0.075, 9);
    expect(spec.widthM).toBeCloseTo(4 * 0.0125 * 1.15 + 0.04, 9);
  });

  it('builds a peg and a bar under 1500 triangles, standing out from the face to the saddle', () => {
    for (const axis of ['out', 'along'] as const) {
      for (const d of [0.0125, 0.025, 0.032]) {
        const spec = cableHangerSpec(d, axis === 'out' ? 4 : 2, axis);
        const kit = createCableHangerKit(spec);
        expect(kit.triangles, `${axis} ${String(d)}`).toBeLessThan(1500);
        const b = new THREE.Box3().setFromObject(buildCableHanger(spec, materials()));
        // Mounted on the face (z = 0), nothing behind it.
        expect(b.min.z, axis).toBeGreaterThanOrEqual(-1e-6);
        const c = cableHangerSaddleCenter(spec);
        // The saddle top: its radius and the channel above the arc center, no higher than the lips.
        expect(b.max.y, axis).toBeGreaterThan(c[1] + spec.radiusM);
        expect(b.max.y, axis).toBeLessThan(c[1] + spec.radiusM + 0.05);
        expect(b.max.z, axis).toBeGreaterThan(c[2]);
      }
    }
  });
});
