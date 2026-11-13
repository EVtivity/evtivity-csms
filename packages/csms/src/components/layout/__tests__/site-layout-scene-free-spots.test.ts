// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The custom site rotation handle and the alignment guides of the 3D site
// scene: where the handle stands and how it is grabbed, and the dashed guide
// strips laid along each alignment.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installFreeSpots } from '../site-layout-scene-free-spots';
import { installKit } from '../site-layout-scene-kit';

type Ctx = Parameters<typeof installFreeSpots>[0] & Parameters<typeof installKit>[0];

function scene(): Ctx {
  const scn = {
    theme: { primary: '#2563eb' },
    guideGroup: new THREE.Group(),
    layout: { lot: { depot: null } },
  } as unknown as Ctx;
  installKit(scn);
  installFreeSpots(scn);
  return scn;
}

describe('freeHandle', () => {
  it('puts the ring and knob at the handle point and a stem back to the spots, hidden at first', () => {
    const scn = scene();
    const g = scn.freeHandle('sta_f', 8, 5);
    expect(g.visible).toBe(false);
    const [ring, knob, stem, grab] = g.children as THREE.Mesh[];
    expect(ring?.position.toArray()).toEqual([0, 0.12, 8]);
    expect(ring?.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(knob?.position.z).toBe(8);
    // The stem runs from the spots' back edge (5 m) to the ring's inner edge (8 - 0.42 m).
    const stemGeo = stem?.geometry as THREE.BoxGeometry;
    expect(stemGeo.parameters.depth).toBeCloseTo(8 - 0.42 - 5);
    expect((stem?.position.z ?? 0) - stemGeo.parameters.depth / 2).toBeCloseTo(5);
    // An invisible 0.9 m disc to grab on a touch screen.
    expect((grab?.material as THREE.MeshBasicMaterial).visible).toBe(false);
    expect((grab?.geometry as THREE.CylinderGeometry).parameters.radiusTop).toBe(0.9);
    g.traverse((o) => {
      expect(o.userData['rotateHandle']).toBe('sta_f');
    });
    expect((ring?.material as THREE.MeshBasicMaterial).color.getHexString()).toBe('2563eb');
  });
});

describe('arrowGeometry', () => {
  it('builds one 3 m lane arrow pointing +x and shares it', () => {
    const scn = scene();
    const a = scn.arrowGeometry();
    expect(scn.arrowGeometry()).toBe(a);
    a.computeBoundingBox();
    expect(a.boundingBox?.min.x).toBeCloseTo(-1.5);
    expect(a.boundingBox?.max.x).toBeCloseTo(1.5);
    expect(a.boundingBox?.max.y).toBeCloseTo(0.5);
  });
});

describe('showGuides', () => {
  it('lays 0.6 m dashes every meter along a guide, the last one cut at its end', () => {
    const scn = scene();
    scn.showGuides([{ axis: 'x', from: { x: 2, z: 0 }, to: { x: 2, z: 2.3 } }]);
    const dashes = scn.guideGroup.children as THREE.Mesh[];
    expect(dashes).toHaveLength(3);
    expect(dashes.map((d) => Math.round(d.scale.z * 100) / 100)).toEqual([0.6, 0.6, 0.3]);
    expect(dashes.map((d) => Math.round(d.position.z * 100) / 100)).toEqual([0.3, 1.3, 2.15]);
    for (const d of dashes) {
      expect(d.position.x).toBeCloseTo(2);
      expect(d.position.y).toBe(0.06);
      expect(d.scale.x).toBe(0.15);
      expect(d.rotation.y).toBeCloseTo(0);
      expect(d.renderOrder).toBe(4);
      expect(d.geometry).toBe(scn.guideDash);
      expect(d.material).toBe(scn.guideMaterial);
    }
    // The pointer passes through the dashes.
    const hits: THREE.Intersection[] = [];
    dashes[0]?.raycast(
      new THREE.Raycaster(new THREE.Vector3(2, 5, 0.3), new THREE.Vector3(0, -1, 0)),
      hits,
    );
    expect(hits).toHaveLength(0);
  });

  it('turns the dashes along a guide in x and replaces the previous guides', () => {
    const scn = scene();
    scn.showGuides([{ axis: 'x', from: { x: 0, z: 0 }, to: { x: 0, z: 5 } }]);
    scn.showGuides([{ axis: 'z', from: { x: 0, z: 1 }, to: { x: 2, z: 1 } }]);
    const dashes = scn.guideGroup.children;
    expect(dashes).toHaveLength(2);
    for (const d of dashes) {
      expect(d.rotation.y).toBeCloseTo(Math.PI / 2);
      expect(d.position.z).toBeCloseTo(1);
    }
    scn.showGuides([]);
    expect(scn.guideGroup.children).toHaveLength(0);
  });
});
