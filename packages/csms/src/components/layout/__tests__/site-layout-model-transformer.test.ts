// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PAD_MOUNT_TRANSFORMER,
  TRANSFORMER_SLOTS,
  createPadMountTransformerKit,
  type TransformerSlot,
} from '../site-layout-model-transformer';

function materials(): Record<TransformerSlot, THREE.Material> {
  return Object.fromEntries(
    TRANSFORMER_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<TransformerSlot, THREE.Material>;
}

function boxOf(g: THREE.Object3D, slot: string): THREE.Box3 {
  const o = g.getObjectByName(slot);
  if (o == null) throw new Error(`no ${slot} mesh`);
  return new THREE.Box3().setFromObject(o);
}

describe('pad-mounted transformer', () => {
  it('keeps the scene envelope and stays under 7000 triangles', () => {
    const kit = createPadMountTransformerKit();
    expect(kit.triangles).toBeLessThan(7000);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeGreaterThan(1.75);
    expect(b.max.y).toBeLessThan(1.85);
    expect(b.max.x - b.min.x).toBeCloseTo(PAD_MOUNT_TRANSFORMER.pad.widthM, 2);
    expect(b.max.z - b.min.z).toBeCloseTo(PAD_MOUNT_TRANSFORMER.pad.depthM, 2);
  });

  it('keeps the radiators within 1.2 m of the center and uses every slot', () => {
    const kit = createPadMountTransformerKit();
    for (const s of TRANSFORMER_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const fins = boxOf(kit.build(materials()), 'fin');
    expect(fins.max.x).toBeLessThan(1.2);
    expect(fins.min.x).toBeGreaterThan(-1.2);
    expect(fins.min.z).toBeGreaterThan(-0.9);
  });
});
