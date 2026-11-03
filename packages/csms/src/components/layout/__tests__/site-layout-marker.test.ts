// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FACADE_LAYOUT } from '../site-layout-facade-openings';
import { MARKER_GAP_M, WALL_BOX_BOTTOM_M, chargerModelTopM, markerY } from '../site-layout-marker';
import { createAcPedestalKit } from '../site-layout-model-ac-pedestal';
import { createDcDispenserKit } from '../site-layout-model-dc-dispenser';
import type { ModelKit } from '../site-layout-model-kit';
import { createAcWallBoxKit } from '../site-layout-model-wall-box';

function top(kit: ModelKit<string>): number {
  const m = new THREE.MeshBasicMaterial();
  const g = kit.build(new Proxy({}, { get: () => m }));
  return new THREE.Box3().setFromObject(g).max.y;
}

describe('status marker height', () => {
  it('floats each marker its gap above the real top of its own model', () => {
    const kits = {
      dc: createDcDispenserKit([{ side: -1, backM: 0, cableDiameterM: 0.0353 }]),
      ac: createAcPedestalKit(2),
      wall: createAcWallBoxKit(WALL_BOX_BOTTOM_M),
    } as const;
    for (const [model, kit] of Object.entries(kits) as Array<
      [keyof typeof kits, ModelKit<string>]
    >) {
      const modelTop = top(kit);
      expect(Math.abs(chargerModelTopM(model) - modelTop), model).toBeLessThan(0.05);
      expect(markerY(chargerModelTopM(model)) - modelTop, model).toBeCloseTo(MARKER_GAP_M, 1);
    }
  });

  it('keeps the wall box marker in front of the solid wall, under the window strip', () => {
    expect(markerY(chargerModelTopM('wall'))).toBeLessThan(
      FACADE_LAYOUT.strip.bottomM - FACADE_LAYOUT.sillM,
    );
  });
});
