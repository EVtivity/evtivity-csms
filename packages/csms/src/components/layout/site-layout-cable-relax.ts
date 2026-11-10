// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The natural bend of a charging cable (owner decision 2026-11-09): a cable
// is stiff, so it never folds at a point. A route built from arcs, lines and
// catenaries meets itself at corners where the pieces join; between the
// points that hold the cable (the gland, a hook, the boot of the handle)
// every corner tighter than the cable's bend radius relaxes until it bends
// no tighter: each such point moves toward its neighbors' middle, the way a
// stiff cable straightens a kink while gravity keeps its spans hanging.
// Pure: no three.js.

import type { Vec3 } from './site-layout-model-kit';

/** The radius of the circle through three points (Infinity for points on a line). */
export function circumradius(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  if (cross < 1e-12) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

/** The tightest bend of a route between its points `from` and `to` (indices, inclusive of the corners between). */
export function tightestBend(points: readonly Vec3[], from = 1, to = points.length - 2): number {
  let min = Infinity;
  for (let i = Math.max(1, from); i <= Math.min(points.length - 2, to); i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    if (a == null || b == null || c == null) continue;
    min = Math.min(min, circumradius(a, b, c));
  }
  return min;
}

/**
 * The route with its corners relaxed: every point not `fixed` whose bend
 * (the circle through it and its neighbors) is tighter than `minRadiusM`
 * moves halfway toward its neighbors' middle, pass after pass, until none is
 * or `passes` ran. The first and last points never move.
 */
export function relaxCableBends(
  points: readonly Vec3[],
  o: { minRadiusM: number; fixed?: (index: number) => boolean; passes?: number },
): Vec3[] {
  let pts: Vec3[] = points.map((p) => [p[0], p[1], p[2]] as const);
  const passes = o.passes ?? 24;
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    const next = pts.slice();
    for (let i = 1; i < pts.length - 1; i += 1) {
      if (o.fixed?.(i) === true) continue;
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      if (a == null || b == null || c == null) continue;
      if (circumradius(a, b, c) >= o.minRadiusM) continue;
      next[i] = [
        (b[0] + (a[0] + c[0]) / 2) / 2,
        (b[1] + (a[1] + c[1]) / 2) / 2,
        (b[2] + (a[2] + c[2]) / 2) / 2,
      ];
      moved = true;
    }
    pts = next;
    if (!moved) break;
  }
  return pts;
}

/**
 * A smooth join from `p0`, leaving along `t0`, to `p1`, arriving along `t1`
 * (unit vectors): a cubic Bezier whose handles are 0.4 of the distance long
 * and no shorter than `bendM` (a cable that must turn round to enter the
 * next piece turns on a radius of about its bend, never a kink). `n` points
 * from p0 to p1 inclusive.
 */
export function smoothJoin(p0: Vec3, t0: Vec3, p1: Vec3, t1: Vec3, n = 12, bendM = 0): Vec3[] {
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  // A join that must turn round to enter the next piece (its arrival against
  // the way from p0) swings wider, so its turn keeps about the bend radius.
  const chord =
    dist < 1e-9
      ? 0
      : ((p1[0] - p0[0]) * t1[0] + (p1[1] - p0[1]) * t1[1] + (p1[2] - p0[2]) * t1[2]) / dist;
  const h = Math.max(dist * 0.4, bendM * (chord < 0 ? 1.5 : 1));
  const c0: Vec3 = [p0[0] + t0[0] * h, p0[1] + t0[1] * h, p0[2] + t0[2] * h];
  const c1: Vec3 = [p1[0] - t1[0] * h, p1[1] - t1[1] * h, p1[2] - t1[2] * h];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const e = t * t * t;
    return [
      a * p0[0] + b * c0[0] + c * c1[0] + e * p1[0],
      a * p0[1] + b * c0[1] + c * c1[1] + e * p1[1],
      a * p0[2] + b * c0[2] + c * c1[2] + e * p1[2],
    ] as const;
  });
}

/**
 * A polyline with each inner corner replaced by a circular arc of
 * `radiusM` (a fillet, tangent to both segments), the way a stiff cable
 * turns round a corner; a corner whose segments are too short for that
 * radius turns on the largest radius they allow (half of a segment between
 * two corners, all of one that ends the polyline).
 * `arcPoints` points per arc.
 */
export function filletPolyline(points: readonly Vec3[], radiusM: number, arcPoints = 8): Vec3[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1], p[2]] as const);
  const out: Vec3[] = [points[0] ?? [0, 0, 0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    if (a == null || b == null || c == null) continue;
    const u = directionOf(b, a);
    const v = directionOf(b, c);
    const cos = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
    const half = Math.acos(cos) / 2;
    // Straight on (or folded back on itself): no arc.
    if (half > Math.PI / 2 - 1e-4 || half < 1e-4) {
      out.push([b[0], b[1], b[2]]);
      continue;
    }
    const lenA = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const lenC = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    // A segment ending at an end of the polyline has no other corner to share it with.
    const roomA = i === 1 ? lenA : lenA / 2;
    const roomC = i === points.length - 2 ? lenC : lenC / 2;
    const tangent = Math.min(radiusM / Math.tan(half), roomA, roomC);
    const r = tangent * Math.tan(half);
    const p0: Vec3 = [b[0] + u[0] * tangent, b[1] + u[1] * tangent, b[2] + u[2] * tangent];
    const p1: Vec3 = [b[0] + v[0] * tangent, b[1] + v[1] * tangent, b[2] + v[2] * tangent];
    // The arc's center on the bisector, `r / sin(half)` from the corner.
    const bis = directionOf([0, 0, 0], [u[0] + v[0], u[1] + v[1], u[2] + v[2]]);
    const dist = r / Math.sin(half);
    const center: Vec3 = [b[0] + bis[0] * dist, b[1] + bis[1] * dist, b[2] + bis[2] * dist];
    const e0 = directionOf(center, p0);
    const e1 = directionOf(center, p1);
    const sweep = Math.PI - 2 * half;
    // Slerp from e0 to e1 round the center.
    for (let k = 0; k <= arcPoints; k += 1) {
      const t = k / arcPoints;
      const w0 = Math.sin((1 - t) * sweep) / Math.sin(sweep);
      const w1 = Math.sin(t * sweep) / Math.sin(sweep);
      out.push([
        center[0] + r * (e0[0] * w0 + e1[0] * w1),
        center[1] + r * (e0[1] * w0 + e1[1] * w1),
        center[2] + r * (e0[2] * w0 + e1[2] * w1),
      ]);
    }
  }
  const last = points[points.length - 1];
  if (last != null) out.push([last[0], last[1], last[2]]);
  return out;
}

type P2 = { x: number; y: number };

/**
 * How far a free span of cable sags at its middle, as a share of its length:
 * 5 percent, a stiff charging cable's shallow hang between two of its bends.
 * Derived (no maker publishes a sag; a catenary of a heavy cable sags more,
 * its stiffness keeps the span this straight).
 */
export const SPAN_SAG = 0.05;

/**
 * The shortest way from `p0` heading `h0` to `p1` heading `h1` that never
 * bends tighter than `radiusM`, in the vertical (or horizontal) plane
 * through the two points (a Dubins path, L. E. Dubins, American Journal of
 * Mathematics 79, 1957: an arc, a straight run and an arc), the way a stiff
 * cable runs between two fixed directions. Headings are taken in that plane;
 * an offset of `p1` out of it is spread along the way, level at both ends. Points every `stepM` from p0 to p1 inclusive.
 */
export function dubinsJoin(
  p0: Vec3,
  h0: Vec3,
  p1: Vec3,
  h1: Vec3,
  radiusM: number,
  stepM = 0.03,
  plane: 'vertical' | 'horizontal' = 'vertical',
): Vec3[] {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const dz = p1[2] - p0[2];
  // The plane's axes: the horizontal way from p0 to p1 (else h0's), and world
  // up (vertical) or the other horizontal (horizontal, the rise spread along).
  let hx = dx;
  let hz = dz;
  if (Math.hypot(hx, hz) < 1e-6) {
    hx = h0[0];
    hz = h0[2];
  }
  const hn = Math.hypot(hx, hz) || 1;
  const ex: Vec3 = [hx / hn, 0, hz / hn];
  const ey: Vec3 = plane === 'vertical' ? [0, 1, 0] : [-ex[2], 0, ex[0]];
  const ez: Vec3 = plane === 'vertical' ? [-ex[2], 0, ex[0]] : [0, 1, 0];
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const to2 = (v: Vec3): P2 => ({ x: dot(v, ex), y: dot(v, ey) });
  const end = to2([dx, dy, dz]);
  const side = dot([dx, dy, dz], ez);
  const a0 = Math.atan2(to2(h0).y, to2(h0).x);
  const a1 = Math.atan2(to2(h1).y, to2(h1).x);
  const R = Math.max(1e-4, radiusM);
  type Leg = { kind: 'arc'; c: P2; from: number; sweep: number } | { kind: 'line'; a: P2; b: P2 };
  const candidates: Leg[][] = [];
  for (const t0 of [1, -1]) {
    for (const t1 of [1, -1]) {
      // A left turn (t = 1) has its center to the left of the heading.
      const c0 = { x: -Math.sin(a0) * R * t0, y: Math.cos(a0) * R * t0 };
      const c1 = { x: end.x - Math.sin(a1) * R * t1, y: end.y + Math.cos(a1) * R * t1 };
      const vx = c1.x - c0.x;
      const vy = c1.y - c0.y;
      const dist = Math.hypot(vx, vy);
      let theta: number;
      if (t0 === t1) {
        // Outer tangent: the straight run parallel to the centers' line.
        theta = Math.atan2(vy, vx);
      } else {
        // Inner tangent: crossing between the circles.
        if (dist < 2 * R) continue;
        theta = Math.atan2(vy, vx) + t0 * Math.asin((2 * R) / dist);
      }
      // The straight run's heading theta: its tangent points on each circle.
      const n0 = { x: -Math.sin(theta) * R * t0, y: Math.cos(theta) * R * t0 };
      const n1 = { x: -Math.sin(theta) * R * t1, y: Math.cos(theta) * R * t1 };
      const q0 = { x: c0.x - n0.x, y: c0.y - n0.y };
      const q1 = { x: c1.x - n1.x, y: c1.y - n1.y };
      const turn = (from: number, to: number, t: number): number => {
        let s = (to - from) * t;
        s = ((s % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        return s * t;
      };
      const start0 = Math.atan2(-c0.y, -c0.x);
      const start1 = Math.atan2(q1.y - c1.y, q1.x - c1.x);
      candidates.push([
        { kind: 'arc', c: c0, from: start0, sweep: turn(a0, theta, t0) },
        { kind: 'line', a: q0, b: q1 },
        { kind: 'arc', c: c1, from: start1, sweep: turn(theta, a1, t1) },
      ]);
    }
  }
  const legLength = (l: Leg): number =>
    l.kind === 'arc' ? Math.abs(l.sweep) * R : Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
  const total = (legs: Leg[]): number => legs.reduce((n, l) => n + legLength(l), 0);
  const best = candidates.sort((p, q) => total(p) - total(q))[0];
  if (best == null) return [p0, p1].map((p) => [p[0], p[1], p[2]] as const);
  const length = total(best) || 1;
  const pts: P2[] = [];
  const along: number[] = [];
  let run = 0;
  for (const l of best) {
    const len = legLength(l);
    // A leg of no length (an arc that does not turn) adds no point.
    if (len < 1e-9) continue;
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let k = pts.length === 0 ? 0 : 1; k <= n; k += 1) {
      const t = k / n;
      if (l.kind === 'arc') {
        const ang = l.from + l.sweep * t;
        pts.push({ x: l.c.x + R * Math.cos(ang), y: l.c.y + R * Math.sin(ang) });
      } else {
        // A free span in a vertical plane sags under its weight between the
        // two arcs it joins: by `SPAN_SAG` of its length at the middle, along
        // the span's downward normal, level with the span at both ends (a
        // smooth bump, 16 t^2 (1 - t)^2), so the arcs stay tangent to it.
        // A steep span (near vertical) hangs straight.
        const ux = l.b.x - l.a.x;
        const uy = l.b.y - l.a.y;
        const ul = Math.hypot(ux, uy) || 1;
        const steep = Math.abs(uy / ul) > 0.8;
        const sag =
          plane === 'vertical' && !steep ? SPAN_SAG * ul * 16 * t * t * (1 - t) * (1 - t) : 0;
        // The in-plane normal pointing down.
        let nx = -uy / ul;
        let ny = ux / ul;
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        pts.push({ x: l.a.x + ux * t + nx * sag, y: l.a.y + uy * t + ny * sag });
      }
      along.push(run + len * t);
    }
    run += len;
  }
  return pts.map((q, i) => {
    // Spread with a smooth step (no slope at either end), so the join stays
    // tangent to the pieces it joins.
    const t = (along[i] ?? 0) / length;
    const w = side * t * t * (3 - 2 * t);
    return [
      p0[0] + ex[0] * q.x + ey[0] * q.y + ez[0] * w,
      p0[1] + ex[1] * q.x + ey[1] * q.y + ez[1] * w,
      p0[2] + ex[2] * q.x + ey[2] * q.y + ez[2] * w,
    ] as const;
  });
}

/** The unit direction from `a` to `b` (straight up for two equal points). */
export function directionOf(a: Vec3, b: Vec3): Vec3 {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const n = Math.hypot(d[0], d[1], d[2]);
  return n < 1e-9 ? [0, 1, 0] : [d[0] / n, d[1] / n, d[2] / n];
}
