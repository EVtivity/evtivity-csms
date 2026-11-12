// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VEHICLE_BODY_TYPES } from '@evtivity/lib/vehicle-appearance';
import { isLargeBodyType } from '../site-layout-car';
import { createVehicleKit } from '../site-layout-vehicle-kit';

function triangles(g: THREE.BufferGeometry): number {
  return (g.index?.count ?? g.getAttribute('position').count) / 3;
}

describe('car triangle budget', () => {
  // Builds every car and large vehicle model: under 1 s alone, past the 5 s default when the
  // whole package runs in parallel, so it gets the limit of the other full-model scans.
  it(
    'keeps every car under 9000 triangles (150 cars stay under 1.4 million) and every large vehicle under 16000',
    { timeout: 30_000 },
    () => {
      const m = new THREE.MeshBasicMaterial();
      const mats = {
        paint: m,
        glass: m,
        tire: m,
        rim: m,
        trim: m,
        headlight: m,
        taillight: m,
        chargePort: m,
        panel: m,
      };
      for (const bodyType of VEHICLE_BODY_TYPES) {
        const car = createVehicleKit(bodyType).build(mats);
        let total = 0;
        car.traverse((o) => {
          if (o instanceof THREE.Mesh) total += triangles(o.geometry as THREE.BufferGeometry);
        });
        expect(total, bodyType).toBeLessThan(isLargeBodyType(bodyType) ? 16000 : 9000);
      }
    },
  );
});
