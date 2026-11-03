// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ModelParts } from '../site-layout-model-kit';
import {
  addScissor,
  scissorHeight,
  scissorWidth,
  strutG,
  type DepotSlot,
} from '../site-layout-model-scissor';
import { boundsOf, depotMaterials } from './depot-model-helpers';

describe('scissor linkage', () => {
  it('keeps the arm length: width squared plus stage height squared', () => {
    const w = scissorWidth(0.75, 1.0, 2);
    expect(w * w + 0.5 * 0.5).toBeCloseTo(0.75 * 0.75, 6);
  });

  it('clamps the height to what the arms reach', () => {
    expect(scissorHeight(0.75, 2, 99)).toBeCloseTo(2 * 0.75 * 0.97, 6);
    expect(scissorHeight(0.75, 2, -1)).toBeCloseTo(2 * 0.75 * 0.05, 6);
  });

  it('places a strut between its two end points', () => {
    const g = strutG([0, 0, 0], [1, 1, 0], 0.1, 0.1);
    g.computeBoundingBox();
    const b = g.boundingBox ?? new THREE.Box3();
    expect(b.min.x).toBeLessThan(0.05);
    expect(b.max.x).toBeGreaterThan(0.95);
    expect(b.max.y).toBeGreaterThan(0.95);
  });

  it('spans the height it is asked for', () => {
    const p = new ModelParts<DepotSlot>();
    addScissor(p, {
      map: (u, y, s) => [u, y, s],
      startY: 0,
      dir: -1,
      heightM: 1,
      stages: 2,
      armM: 0.75,
      planes: [-0.3, 0.3],
      armW: 0.05,
      armD: 0.03,
      pinR: 0.01,
    });
    const b = boundsOf(p.kit().build(depotMaterials()));
    expect(b.max.y).toBeCloseTo(0, 1);
    expect(b.min.y).toBeCloseTo(-1, 1);
  });
});
