// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  LINK_BEND_M,
  linkPolyline,
  linkTubeGeometry,
  polylineLength,
} from '../site-layout-link-curve';

const v = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 0.08, z);

describe('load management cable run', () => {
  it('bends each turn on a short radius tangent to both legs, passing both ends', () => {
    const line = linkPolyline([v(0, 0), v(4, 0), v(4, 3), v(9, 3)]);
    expect(line[0]?.toArray()).toEqual([0, 0.08, 0]);
    expect(line[line.length - 1]?.toArray()).toEqual([9, 0.08, 3]);
    // Every point stays within the corner square of its turn (no overshoot, no ball).
    for (const p of line) {
      expect(p.y).toBeCloseTo(0.08, 9);
      const onLeg = Math.abs(p.z) < 1e-9 || Math.abs(p.x - 4) < 1e-9 || Math.abs(p.z - 3) < 1e-9;
      const inBend =
        (p.x >= 4 - LINK_BEND_M - 1e-9 && p.x <= 4 + 1e-9 && p.z <= LINK_BEND_M + 1e-9) ||
        (p.x >= 4 - 1e-9 && p.x <= 4 + LINK_BEND_M + 1e-9 && p.z >= 3 - LINK_BEND_M - 1e-9);
      expect(onLeg || inBend, p.toArray().join(',')).toBe(true);
    }
    // No step between two points turns by more than 12 degrees.
    for (let i = 2; i < line.length; i += 1) {
      const a = (line[i - 1] ?? v(0, 0))
        .clone()
        .sub(line[i - 2] ?? v(0, 0))
        .normalize();
      const b = (line[i] ?? v(0, 0))
        .clone()
        .sub(line[i - 1] ?? v(0, 0))
        .normalize();
      expect(Math.acos(Math.min(1, a.dot(b))), String(i)).toBeLessThan((12 * Math.PI) / 180);
    }
    // A bend shortens the run a little, never lengthens it.
    expect(polylineLength(line)).toBeLessThan(12);
    expect(polylineLength(line)).toBeGreaterThan(12 - 4 * LINK_BEND_M);
  });

  it('keeps a short leg free of overlapping bends and drops straight-through points', () => {
    const line = linkPolyline([v(0, 0), v(1, 0), v(2, 0), v(2, 0.2), v(5, 0.2)]);
    expect(line.some((p) => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.z) < 1e-9)).toBe(false);
    for (let i = 1; i < line.length; i += 1) {
      expect((line[i] ?? v(0, 0)).x).toBeGreaterThanOrEqual((line[i - 1] ?? v(0, 0)).x - 1e-9);
    }
  });

  it('builds one tube a ring per point, its wall at the radius, u along the length', () => {
    const line = linkPolyline([v(0, 0), v(4, 0), v(4, 3)]);
    const g = linkTubeGeometry(line, 0.05, 8);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    expect(pos.count).toBe(line.length * 8);
    expect(g.index?.count).toBe((line.length - 1) * 8 * 6);
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i] ?? v(0, 0);
      for (let j = 0; j < 8; j += 1) {
        const k = i * 8 + j;
        const d = Math.hypot(pos.getX(k) - c.x, pos.getY(k) - c.y, pos.getZ(k) - c.z);
        expect(d).toBeCloseTo(0.05, 6);
      }
    }
    expect(uv.getX(0)).toBe(0);
    expect(uv.getX(pos.count - 1)).toBeCloseTo(1, 9);
    // A long straight run costs one segment.
    expect(linkTubeGeometry(linkPolyline([v(0, 0), v(100, 0)]), 0.05).index?.count).toBe(48);
  });
});
