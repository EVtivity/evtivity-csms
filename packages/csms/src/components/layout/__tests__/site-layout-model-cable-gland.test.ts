// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { acGland } from '../site-layout-model-ac-pedestal';
import {
  CABLE_GLAND_SLOTS,
  CABLE_MIN_BEND_RATIO,
  cableGlandSize,
  cableOutOfGland,
  createCableGlandKit,
} from '../site-layout-model-cable-gland';
import { dcGland } from '../site-layout-model-dc-dispenser';
import { CONNECTOR_SPECS } from '../site-layout-connectors';
import type { Vec3 } from '../site-layout-model-kit';

const DIAMETERS = Object.values(CONNECTOR_SPECS).map((c) => c.cableDiameterM);

// Every gland a charger body carries: both DC side walls at both holster rows,
// and the AC pedestal and curb post glands under the head.
const GLANDS: Array<{ name: string; at: Vec3; axis: Vec3 }> = [
  ...([-1, 1] as const).flatMap((side) =>
    [0, 0.25].map((drop) => ({
      name: `dc ${String(side)} ${String(drop)}`,
      ...dcGland(side, drop),
    })),
  ),
  ...[-0.075, 0, 0.075].map((x) => ({ name: `ac ${String(x)}`, ...acGland(x) })),
];

function distanceToAxis(p: THREE.Vector3, at: Vec3, axis: Vec3): number {
  const o = new THREE.Vector3(...at);
  const a = new THREE.Vector3(...axis).normalize();
  const v = p.clone().sub(o);
  return v.sub(a.clone().multiplyScalar(v.dot(a))).length();
}

describe('cable gland model', () => {
  it('sizes the gland from the cable and stays small (under 400 triangles)', () => {
    for (const d of DIAMETERS) {
      const g = cableGlandSize(d);
      expect(g.threadM).toBeGreaterThan(d);
      const kit = createCableGlandKit(d);
      expect(kit.triangles).toBeLessThan(400);
      const b = new THREE.Box3().setFromObject(
        kit.build(
          Object.fromEntries(
            CABLE_GLAND_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
          ) as unknown as Record<(typeof CABLE_GLAND_SLOTS)[number], THREE.Material>,
        ),
      );
      expect(b.max.y).toBeCloseTo(g.lengthM, 3);
      expect(b.min.y).toBeCloseTo(0, 3);
    }
  });

  it('runs every cable out of its gland along the axis, within 3 mm, past the tip', () => {
    for (const gland of GLANDS) {
      for (const d of DIAMETERS) {
        const pts = cableOutOfGland(
          gland.at,
          gland.axis,
          d,
          [0, -1, 0].every((v, i) => v === gland.axis[i]) ? [1, 0, 0] : [0, -1, 0],
        );
        const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
        const tip = cableGlandSize(d).lengthM;
        // The first point is inside the gland, on its axis.
        const first = new THREE.Vector3(...(pts[0] ?? [0, 0, 0]));
        expect(distanceToAxis(first, gland.at, gland.axis), gland.name).toBeLessThan(0.001);
        const a = new THREE.Vector3(...gland.axis);
        expect(
          first
            .clone()
            .sub(new THREE.Vector3(...gland.at))
            .dot(a),
        ).toBeLessThan(0);
        // From inside to past the strain relief tip the cable keeps on the axis.
        for (let t = 0; t <= 1; t += 0.01) {
          const p = curve.getPoint(t);
          const along = p
            .clone()
            .sub(new THREE.Vector3(...gland.at))
            .dot(a);
          if (along > tip) break;
          expect(
            distanceToAxis(p, gland.at, gland.axis),
            `${gland.name} ${String(d)}`,
          ).toBeLessThan(0.003);
        }
      }
    }
  });

  it('bends no tighter than 6 cable diameters', () => {
    expect(CABLE_MIN_BEND_RATIO).toBeGreaterThanOrEqual(6);
    const d = 0.0353;
    const pts = cableOutOfGland([0, 0, 0], [1, 0, 0], d, [0, -1, 0]);
    const end = pts[pts.length - 1] ?? [0, 0, 0];
    // A quarter bend of radius 6 d: the cable ends 6 d below the axis.
    expect(-end[1]).toBeCloseTo(CABLE_MIN_BEND_RATIO * d, 4);
  });
});
