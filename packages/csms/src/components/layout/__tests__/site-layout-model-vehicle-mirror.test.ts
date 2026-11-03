// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BUS_MIRROR,
  MIRROR_ARM_EMBED_M,
  busMirrorArmPoints,
  busMirrorHead,
  carMirrorStalk,
  truckMirror,
} from '../site-layout-model-vehicle-mirror';
import { CAR_PROFILES, LARGE_VEHICLE_SPECS, type CarBodyType } from '../site-layout-car';
import { bodyTopAt, carMirrorParts, createCarKit } from '../site-layout-car-geometry';
import { createLargeVehicleKit } from '../site-layout-large-vehicle-geometry';
import type { Vec3 } from '../site-layout-model-kit';

const MATERIAL_NAMES = [
  'paint',
  'glass',
  'tire',
  'rim',
  'trim',
  'headlight',
  'taillight',
  'chargePort',
  'panel',
] as const;

function materials(): Record<(typeof MATERIAL_NAMES)[number], THREE.Material> {
  return Object.fromEntries(
    MATERIAL_NAMES.map((n) => [n, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<(typeof MATERIAL_NAMES)[number], THREE.Material>;
}

/** The distance from `p` to the nearest triangle of the painted body. */
function distanceToPaint(group: THREE.Group, p: Vec3): number {
  group.updateMatrixWorld(true);
  const point = new THREE.Vector3(...p);
  const tri = new THREE.Triangle();
  const closest = new THREE.Vector3();
  let best = Infinity;
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name !== 'paint') return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    const index = (o.geometry as THREE.BufferGeometry).getIndex();
    const count = index != null ? index.count : pos.count;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const at = index != null ? index.getX(i + k) : i + k;
        v[k]?.fromBufferAttribute(pos, at).applyMatrix4(o.matrixWorld);
      }
      const [a, b, c] = v;
      if (a == null || b == null || c == null) continue;
      tri.set(a, b, c);
      tri.closestPointToPoint(point, closest);
      best = Math.min(best, closest.distanceTo(point));
    }
  });
  return best;
}

function insideBox(p: Vec3, box: { center: Vec3; size: Vec3 }): boolean {
  return [0, 1, 2].every(
    (i) => Math.abs((p[i] ?? 0) - (box.center[i] ?? 0)) <= (box.size[i] ?? 0) / 2 + 1e-9,
  );
}

describe('vehicle mirrors', () => {
  it('holds each bus mirror on an arm that starts in the front face and ends in the head', () => {
    const spec = LARGE_VEHICLE_SPECS.bus;
    const group = createLargeVehicleKit('bus').build(materials());
    for (const side of [-1, 1] as const) {
      const arm = busMirrorArmPoints(side, spec.width, 3.1);
      const start = arm[0] as Vec3;
      const end = arm[arm.length - 1] as Vec3;
      // The arm's end disc is under the body surface: its center within radius plus a few mm.
      expect(distanceToPaint(group, start)).toBeLessThanOrEqual(
        BUS_MIRROR.arm.radiusM + MIRROR_ARM_EMBED_M + 0.003,
      );
      expect(insideBox(end, busMirrorHead(side, spec.width))).toBe(true);
    }
    // 2.95 m across the heads.
    const h = busMirrorHead(1, spec.width);
    expect(2 * (h.center[0] + h.size[0] / 2)).toBeCloseTo(2.95, 2);
  });

  it('holds each truck mirror on door frame tubes that start in the cab side and end in the head', () => {
    for (const [body, at] of [
      ['box_truck', { cab: 2.42 / 2, y: 2.2, z: 1.3 + 0.6, out: 0.24, head: [0.08, 0.45, 0.2] }],
      ['semi_truck', { cab: 2.5 / 2, y: 2.35, z: 1.5 + 0.5, out: 0.26, head: [0.08, 0.5, 0.22] }],
    ] as const) {
      const group = createLargeVehicleKit(body).build(materials());
      for (const side of [-1, 1] as const) {
        const m = truckMirror(side, at.cab, {
          y: at.y,
          z: at.z,
          headOutM: at.out,
          head: [...at.head],
        });
        expect(m.tubes).toHaveLength(2);
        for (const t of m.tubes) {
          expect(distanceToPaint(group, t.from), body).toBeLessThanOrEqual(0.008);
          expect(insideBox(t.to, m.head), body).toBe(true);
        }
      }
    }
  });

  it('holds each car mirror on a stalk from the door top into the head', () => {
    for (const body of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[body];
      const group = createCarKit(body).build(materials());
      for (const part of carMirrorParts(profile)) {
        const s = part.stalk;
        const bottom: Vec3 = [s.center[0], s.center[1] - s.size[1] / 2, s.center[2]];
        const top: Vec3 = [s.center[0], s.center[1] + s.size[1] / 2, s.center[2]];
        expect(bottom[1]).toBeLessThan(bodyTopAt(profile, s.center[2]));
        expect(distanceToPaint(group, bottom), body).toBeLessThanOrEqual(0.04);
        expect(insideBox(top, part.head), body).toBe(true);
      }
    }
    const stalk = carMirrorStalk(1, 1.8, 0.9, {
      center: [0.92, 1.0, 1.7],
      size: [0.2, 0.11, 0.09],
    });
    expect(stalk.size[1]).toBeGreaterThan(0);
  });
});
