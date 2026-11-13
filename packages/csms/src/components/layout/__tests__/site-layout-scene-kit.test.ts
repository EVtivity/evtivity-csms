// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The scene kit of the 3D site scene: kits built once and shared for the
// scene's life, everything else tracked per rebuild.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { installKit } from '../site-layout-scene-kit';
import type { ModelKit } from '../site-layout-model-kit';

type Ctx = Parameters<typeof installKit>[0];

function kit(): Ctx {
  const scn = {} as Ctx;
  installKit(scn);
  return scn;
}

describe('installKit', () => {
  it('builds one car kit per body type, port, inlet and plug, and shares it', () => {
    const scn = kit();
    const a = scn.carKit('sedan');
    expect(scn.carKit('sedan')).toBe(a);
    expect(scn.carKit('sedan', 'front_left')).toBe(a);
    const rear = scn.carKit('sedan', 'rear_right');
    expect(rear).not.toBe(a);
    // A closed port (null plug) is another kit than an unplugged default.
    expect(scn.carKit('sedan', 'front_left', undefined, null)).not.toBe(a);
    expect([...scn.carKits.keys()]).toEqual([
      'sedan:front_left::',
      'sedan:rear_right::',
      'sedan:front_left::closed',
    ]);
  });

  it('tracks every material and geometry of a rebuild', () => {
    const scn = kit();
    const m = scn.M('#ff0000', { roughness: 0.9 });
    expect(m.color.getHexString()).toBe('ff0000');
    expect(m.roughness).toBe(0.9);
    expect(m.metalness).toBe(0.1);
    const b = scn.box(1, 2, 3, m);
    const c = scn.cylinder(0.5, 2, 12, m);
    expect(b.castShadow && b.receiveShadow).toBe(true);
    expect(c.castShadow && c.receiveShadow).toBe(true);
    expect(b.geometry.parameters).toMatchObject({
      width: 1,
      height: 2,
      depth: 3,
    });
    expect(c.geometry.parameters).toMatchObject({
      radiusTop: 0.5,
      radiusBottom: 0.5,
      height: 2,
      radialSegments: 12,
    });
    expect(scn.built).toEqual([m, b.geometry, c.geometry]);
  });

  it('builds a rounded prism of the footprint standing on the ground', () => {
    const scn = kit();
    const mesh = scn.roundedPrism(2, 1, 0.5, 0.1, new THREE.MeshBasicMaterial());
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    // The bevel adds 15 mm on every side.
    expect(bb?.min.x).toBeCloseTo(-1.015, 3);
    expect(bb?.max.x).toBeCloseTo(1.015, 3);
    expect(bb?.min.z).toBeCloseTo(-0.515, 3);
    expect(bb?.max.z).toBeCloseTo(0.515, 3);
    expect(bb?.min.y).toBeCloseTo(-0.015, 3);
    expect(bb?.max.y).toBeCloseTo(0.515, 3);
    expect(mesh.castShadow).toBe(true);
    expect(scn.built).toContain(mesh.geometry);
  });

  it('builds each model kit once by key and tags its models', () => {
    const scn = kit();
    const build = vi.fn(() => new THREE.Group());
    const make = vi.fn((): ModelKit<'body'> => ({ build }) as unknown as ModelKit<'body'>);
    const k = scn.modelKit('pedestal', make);
    expect(scn.modelKit('pedestal', make)).toBe(k);
    expect(scn.chargerKit('pedestal', make as never)).toBe(k);
    expect(make).toHaveBeenCalledTimes(1);
    const materials = { body: new THREE.MeshBasicMaterial() };
    const model = scn.modelOf(k, 'ac-pedestal', materials);
    expect(build).toHaveBeenCalledWith(materials);
    expect(model.userData['model']).toBe('ac-pedestal');
  });

  it('marks a model feature with an empty point', () => {
    const scn = kit();
    const o = scn.marker('cable-coil', [1, 2, 3]);
    expect(o.position.toArray()).toEqual([1, 2, 3]);
    expect(o.userData['feature']).toBe('cable-coil');
    expect(o.children).toHaveLength(0);
  });
});
