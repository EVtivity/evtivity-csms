// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DRY_TRANSFORMER,
  DRY_TRANSFORMER_SIZES,
  DRY_TRANSFORMER_SLOTS,
  createDryTransformerKit,
  dryTransformerPad,
  dryTransformerSize,
  type DryTransformerSlot,
} from '../site-layout-model-dry-transformer';

function materials(): Record<DryTransformerSlot, THREE.Material> {
  return Object.fromEntries(
    DRY_TRANSFORMER_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<DryTransformerSlot, THREE.Material>;
}

function boxOf(g: THREE.Object3D, slot: string): THREE.Box3 {
  const o = g.getObjectByName(slot);
  if (o == null) throw new Error(`no ${slot} mesh`);
  return new THREE.Box3().setFromObject(o);
}

describe('dry-type step-down transformer', () => {
  it('takes the mean of the two catalog outlines for each rating', () => {
    // Square D 20D (37 x 30 x 20 in) and Hammond DH3 (36.0 x 28.3 x 27.0 in).
    const s75 = dryTransformerSize(75);
    expect(s75.heightM).toBeCloseTo(36.5 * 0.0254, 4);
    expect(s75.widthM).toBeCloseTo(29.15 * 0.0254, 4);
    expect(s75.depthM).toBeCloseTo(23.5 * 0.0254, 4);
    // Square D 24D (49.5 x 35 x 28.5 in) and Hammond DH5 (52.0 x 38.0 x 34.0 in).
    const s225 = dryTransformerSize(225);
    expect(s225.heightM).toBeCloseTo(50.75 * 0.0254, 4);
    expect(s225.widthM).toBeCloseTo(36.5 * 0.0254, 4);
  });

  it('draws a rating with the smallest class at or above it, and unrated as 75 kVA', () => {
    expect(dryTransformerSize(90).kva).toBe(112.5);
    expect(dryTransformerSize(112.5).kva).toBe(112.5);
    expect(dryTransformerSize(null).kva).toBe(75);
    expect(dryTransformerSize(30).kva).toBe(75);
    expect(dryTransformerSize(2000).kva).toBe(500);
    // Every listed class grows or keeps its outline with the rating.
    for (let i = 1; i < DRY_TRANSFORMER_SIZES.length; i++) {
      const a = DRY_TRANSFORMER_SIZES[i - 1];
      const b = DRY_TRANSFORMER_SIZES[i];
      expect(b?.heightIn ?? 0).toBeGreaterThanOrEqual(a?.heightIn ?? 0);
      expect(b?.widthIn ?? 0).toBeGreaterThanOrEqual(a?.widthIn ?? 0);
    }
  });

  it('stands on its pad at the size of its class, under 6000 triangles, every slot used', () => {
    for (const kva of [75, 150, 225, 500]) {
      const size = dryTransformerSize(kva);
      const kit = createDryTransformerKit(size);
      expect(kit.triangles).toBeLessThan(6000);
      for (const s of DRY_TRANSFORMER_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
      const g = kit.build(materials());
      const all = new THREE.Box3().setFromObject(g);
      // The pad bottom on y = 0; the conduits reach a little into it.
      expect(all.min.y).toBeGreaterThan(-0.03);
      expect(all.max.y).toBeCloseTo(DRY_TRANSFORMER.pad.heightM + size.heightM, 2);
      const pad = boxOf(g, 'concrete');
      const { w, d } = dryTransformerPad(size);
      expect(pad.max.x - pad.min.x).toBeCloseTo(w, 3);
      expect(pad.max.z - pad.min.z).toBeCloseTo(d, 3);
      // Everything but the conduits stays over the pad.
      const body = boxOf(g, 'body');
      expect(body.max.x).toBeLessThanOrEqual(w / 2);
      expect(body.max.z).toBeLessThanOrEqual(d / 2);
      const conduit = boxOf(g, 'conduit');
      expect(conduit.max.x).toBeLessThan(w / 2 + 0.05);
    }
  });

  it('takes its air in through the opening under the bottom plate between the legs', () => {
    // Hammond IOM DIM16: "the front ventilation area defined between the bottom
    // plate and the supporting legs". No intake louvers on the front or back panels.
    const size = dryTransformerSize(225);
    const g = createDryTransformerKit(size).build(materials());
    g.updateMatrixWorld(true);
    const y0 = DRY_TRANSFORMER.pad.heightM;
    const vent = boxOf(g, 'vent');
    // The lowest vent part is the base opening, from the pad up to the bottom plate.
    expect(vent.min.y).toBeCloseTo(y0, 3);
    const mesh = g.getObjectByName('vent') as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');
    const world = new THREE.Vector3();
    let below = 0;
    for (let i = 0; i < pos.count; i++) {
      world.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (world.y < y0 + DRY_TRANSFORMER.baseM + 1e-6) {
        below++;
        // Between the legs, and set back from the front and the back.
        expect(Math.abs(world.x)).toBeLessThanOrEqual(
          size.widthM / 2 - DRY_TRANSFORMER.legM + 1e-6,
        );
        expect(Math.abs(world.z)).toBeLessThan(size.depthM / 2);
      } else {
        // Every other vent part is a side exhaust, high on the box.
        expect(world.y).toBeGreaterThan(y0 + size.heightM / 2);
        expect(Math.abs(world.x)).toBeGreaterThan(size.widthM / 2 - 0.01);
      }
    }
    expect(below).toBeGreaterThan(0);
  });
});
