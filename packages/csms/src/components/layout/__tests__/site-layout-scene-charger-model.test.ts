// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildIdleChargerModel, type IdleChargerModel } from '../site-layout-scene-charger-model';

const MODELS: IdleChargerModel[] = [
  'dc-dispenser',
  'ac-pedestal',
  'ac-pedestal-dual',
  'curb-post',
  'wall-box',
  'split-satellite',
  'bus-dispenser',
  'mcs-dispenser',
  'pantograph',
];

const HANGER_MODELS: IdleChargerModel[] = [
  'dc-dispenser',
  'ac-pedestal',
  'ac-pedestal-dual',
  'curb-post',
  'wall-box',
  'split-satellite',
];

function models(g: THREE.Object3D): string[] {
  const out: string[] = [];
  g.traverse((o) => {
    const m: unknown = o.userData['model'];
    if (typeof m === 'string') out.push(m);
  });
  return out;
}

describe('idle charger model', () => {
  it('builds every model with its body, holsters and idle cables, and frees it all', () => {
    for (const model of MODELS) {
      const built = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      const b = new THREE.Box3().setFromObject(built.group);
      expect(b.isEmpty(), model).toBe(false);
      expect(b.max.y, model).toBeGreaterThan(1);
      const names = models(built.group);
      // The standard chargers loop their idle cables over a hanger, the MCS dispenser over its arm.
      if (model === 'mcs-dispenser') expect(names, model).toContain('mcs-arm');
      if (HANGER_MODELS.includes(model)) expect(names, model).toContain('cable-hanger');
      // The plate color is the operator's own.
      let plate = false;
      built.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of mats) {
            if (mat instanceof THREE.MeshStandardMaterial && mat.color.getHexString() === '336699')
              plate = true;
          }
        }
      });
      expect(plate, model).toBe(true);
      expect(() => built.dispose(), model).not.toThrow();
    }
  });

  it('leaves out the pad, signs, bollards, logo and glow', () => {
    const built = buildIdleChargerModel('dc-dispenser', { plateColor: '#336699', dark: true });
    const names = models(built.group);
    expect(names.filter((n) => /bollard|sign|logo|wheel-stop/.test(n))).toEqual([]);
    let additive = 0;
    built.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
        if (o.material.blending === THREE.AdditiveBlending) additive += 1;
      }
    });
    expect(additive).toBe(0);
    built.dispose();
  });
});
