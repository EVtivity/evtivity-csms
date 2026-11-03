// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ModelParts } from '../site-layout-model-kit';
import { WARNING_SIGN, addWarningSign } from '../site-layout-model-warning-sign';

describe('high voltage warning sign', () => {
  it('is widthM wide and 1.2 times as tall, its ink in front of the plate, under 150 triangles', () => {
    const p = new ModelParts<'sign' | 'ink'>();
    addWarningSign(p, 'sign', 'ink', 0.3);
    const kit = p.kit();
    expect(kit.triangles).toBeLessThan(150);
    const g = kit.build({
      sign: new THREE.MeshBasicMaterial(),
      ink: new THREE.MeshBasicMaterial(),
    });
    const sign = g.getObjectByName('sign');
    const ink = g.getObjectByName('ink');
    if (sign == null || ink == null) throw new Error('missing mesh');
    const plate = new THREE.Box3().setFromObject(sign);
    const marks = new THREE.Box3().setFromObject(ink);
    expect(plate.max.x - plate.min.x).toBeCloseTo(0.3, 4);
    expect(plate.max.y - plate.min.y).toBeCloseTo(0.3 * WARNING_SIGN.heightRatio, 4);
    expect(marks.min.z).toBeGreaterThanOrEqual(plate.max.z - 1e-6);
  });
});
