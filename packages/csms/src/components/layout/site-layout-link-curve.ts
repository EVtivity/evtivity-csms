// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The tube of a load management cable run: its straight legs joined at each
// turn by a short-radius bend of the same tube, the way conduit bends at a
// corner (owner request 2026-11-02: no ball at a turn). Straight legs take
// one tube segment each, bends several, so a long run costs few triangles.

import * as THREE from 'three';

/** The bend radius at a turn, kept under half of each leg so two bends never overlap. */
export const LINK_BEND_M = 0.3;

/** The points along each bend (both ends included). */
const BEND_STEPS = 10;

/**
 * The center line through `points`: each turn replaced by a quadratic bend
 * tangent to both legs, `bendM` from the corner along each leg (less where a
 * leg is short). Consecutive duplicate points and straight-through points
 * are dropped.
 */
export function linkPolyline(
  points: readonly THREE.Vector3[],
  bendM = LINK_BEND_M,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last == null || last.distanceTo(p) > 1e-6) pts.push(p.clone());
  }
  if (pts.length < 3) return pts;
  const out: THREE.Vector3[] = [pts[0] ?? new THREE.Vector3()];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const corner = pts[i];
    const next = pts[i + 1];
    if (prev == null || corner == null || next == null) continue;
    const inDir = corner.clone().sub(prev);
    const outDir = next.clone().sub(corner);
    const r = Math.min(bendM, inDir.length() / 2, outDir.length() / 2);
    inDir.normalize();
    outDir.normalize();
    if (inDir.dot(outDir) > 1 - 1e-6) continue;
    const a = corner.clone().addScaledVector(inDir, -r);
    const b = corner.clone().addScaledVector(outDir, r);
    const bend = new THREE.QuadraticBezierCurve3(a, corner, b);
    for (let k = 0; k <= BEND_STEPS; k += 1) out.push(bend.getPoint(k / BEND_STEPS));
  }
  out.push(pts[pts.length - 1] ?? new THREE.Vector3());
  return out;
}

/** The length of a polyline. */
export function polylineLength(points: readonly THREE.Vector3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a != null && b != null) len += a.distanceTo(b);
  }
  return len;
}

/**
 * A tube of `radius` along a polyline: a ring of `radial` vertices at each
 * point, square to the mean of its two legs and scaled so the wall keeps its
 * radius through a bend; u runs along the length (0 to 1), v around it, as
 * in a three.js TubeGeometry, so a flow texture moves the same way.
 */
export function linkTubeGeometry(
  points: readonly THREE.Vector3[],
  radius: number,
  radial = 8,
): THREE.BufferGeometry {
  const n = points.length;
  const total = Math.max(1e-6, polylineLength(points));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let along = 0;
  let normal: THREE.Vector3 | null = null;
  let prevTangent: THREE.Vector3 | null = null;
  for (let i = 0; i < n; i += 1) {
    const p = points[i] ?? new THREE.Vector3();
    const before = i > 0 ? p.clone().sub(points[i - 1] ?? p) : null;
    const after = i < n - 1 ? (points[i + 1] ?? p).clone().sub(p) : null;
    if (before != null) along += before.length();
    const t1 = (before ?? after ?? new THREE.Vector3(1, 0, 0)).clone().normalize();
    const t2 = (after ?? before ?? new THREE.Vector3(1, 0, 0)).clone().normalize();
    const tangent = t1.clone().add(t2);
    if (tangent.lengthSq() < 1e-12) tangent.copy(t2);
    tangent.normalize();
    // Parallel transport of the ring's normal, so the tube never twists.
    if (normal == null || prevTangent == null) {
      const helper =
        Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      normal = helper.sub(tangent.clone().multiplyScalar(helper.dot(tangent))).normalize();
    } else {
      const axis = prevTangent.clone().cross(tangent);
      if (axis.lengthSq() > 1e-12) {
        const angle = Math.acos(Math.min(1, Math.max(-1, prevTangent.dot(tangent))));
        normal.applyAxisAngle(axis.normalize(), angle);
      }
    }
    prevTangent = tangent;
    const binormal = tangent.clone().cross(normal).normalize();
    // A ring square to the mean tangent; a bend's points are close enough
    // (at most about 11 degrees apart) that the wall keeps its radius through it.
    for (let j = 0; j < radial; j += 1) {
      const v = (j / radial) * Math.PI * 2;
      const dir = normal.clone().multiplyScalar(Math.cos(v)).addScaledVector(binormal, Math.sin(v));
      const at = p.clone().addScaledVector(dir, radius);
      positions.push(at.x, at.y, at.z);
      normals.push(dir.x, dir.y, dir.z);
      uvs.push(along / total, j / radial);
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * radial + j;
      const b = (i + 1) * radial + j;
      const c = (i + 1) * radial + ((j + 1) % radial);
      const d = i * radial + ((j + 1) % radial);
      indices.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}
