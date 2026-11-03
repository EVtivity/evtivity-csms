// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Building blocks of the equipment models of the 3D site layout (chargers,
// bollards, readers, panels, power equipment): parts are added to a material
// slot at a placement, then merged into one geometry per slot. A kit is built
// once and every model of its kind shares the geometries; only the materials
// passed to `build` differ (a station's lit screen, its light color).

import * as THREE from 'three';
import { extrudeProfile } from './site-layout-car-geometry';

export type Vec3 = readonly [number, number, number];
export type Pt = readonly [number, number];

export interface Placement {
  at?: Vec3;
  /** Euler angles in radians, XYZ order. */
  rot?: Vec3;
  scale?: Vec3;
}

export interface ModelKit<S extends string> {
  /** A new model: one mesh per material slot that holds parts, geometries shared. */
  build: (materials: Readonly<Record<S, THREE.Material>>) => THREE.Group;
  geometries: THREE.BufferGeometry[];
  triangles: number;
  /** Triangles per slot, for budget tests. */
  slotTriangles: Readonly<Partial<Record<S, number>>>;
}

function flat(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = source.index != null ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.hasAttribute('normal')) g.computeVertexNormals();
  return g;
}

function join(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  for (const p of parts) count += p.getAttribute('position').count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let offset = 0;
  for (const p of parts) {
    position.set(p.getAttribute('position').array, offset * 3);
    normal.set(p.getAttribute('normal').array, offset * 3);
    offset += p.getAttribute('position').count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.computeBoundingSphere();
  return g;
}

/** Collects parts per material slot and merges them into a kit. */
export class ModelParts<S extends string> {
  private readonly bySlot = new Map<S, THREE.BufferGeometry[]>();

  /** Adds a part (the source geometry is disposed). */
  add(slot: S, geometry: THREE.BufferGeometry, p: Placement = {}): this {
    const part = flat(geometry);
    geometry.dispose();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(p.at ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot ?? [0, 0, 0]))),
      new THREE.Vector3(...(p.scale ?? [1, 1, 1])),
    );
    part.applyMatrix4(m);
    this.bySlot.set(slot, [...(this.bySlot.get(slot) ?? []), part]);
    return this;
  }

  /** Adds every part of another set, moved by a placement. */
  addAll(other: ModelParts<S>, p: Placement = {}): this {
    for (const [slot, list] of other.bySlot) {
      for (const g of list) this.add(slot, g.clone(), p);
    }
    return this;
  }

  kit(): ModelKit<S> {
    const merged = new Map<S, THREE.BufferGeometry>();
    const slotTriangles: Partial<Record<S, number>> = {};
    let triangles = 0;
    for (const [slot, list] of this.bySlot) {
      const g = join(list);
      for (const part of list) part.dispose();
      merged.set(slot, g);
      const n = g.getAttribute('position').count / 3;
      slotTriangles[slot] = n;
      triangles += n;
    }
    this.bySlot.clear();
    return {
      build(materials) {
        const group = new THREE.Group();
        for (const [slot, geometry] of merged) {
          const mesh = new THREE.Mesh(geometry, materials[slot]);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.name = slot;
          group.add(mesh);
        }
        return group;
      },
      geometries: [...merged.values()],
      triangles,
      slotTriangles,
    };
  }
}

export function boxG(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** A box with its edges rounded by `r`, centered on the origin. */
export function roundBoxG(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const c = Math.max(0.0005, Math.min(r, w / 2, h / 2, d / 2) * 0.95);
  const s = new THREE.Shape();
  const hw = w / 2 - c;
  const hh = h / 2 - c;
  s.moveTo(-hw, -hh);
  s.lineTo(hw, -hh);
  s.lineTo(hw, hh);
  s.lineTo(-hw, hh);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.0005, d - 2 * c),
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelSegments: 2,
    curveSegments: 1,
  });
  g.translate(0, 0, -(d - 2 * c) / 2);
  return g;
}

function shapeOf(points: readonly Pt[]): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([a, b], i) => (i === 0 ? s.moveTo(a, b) : s.lineTo(a, b)));
  s.closePath();
  return s;
}

/**
 * A side silhouette (points [z, y], counter clockwise seen from +x) extruded
 * across x from -width/2 to width/2, its edges rounded by `bevel`.
 */
export function sideProfileG(
  points: readonly Pt[],
  width: number,
  bevel = 0,
): THREE.BufferGeometry {
  const g = extrudeProfile(shapeOf(points), width, bevel, 1, bevel > 0 ? 2 : 1);
  g.computeVertexNormals();
  return g;
}

/**
 * A front outline (points [x, y], counter clockwise seen from +z) extruded
 * along z from -depth/2 to depth/2, its edges rounded by `bevel`, with
 * optional holes (clockwise).
 */
export function frontProfileG(
  points: readonly Pt[],
  depth: number,
  bevel = 0,
  holes: readonly (readonly Pt[])[] = [],
): THREE.BufferGeometry {
  const s = shapeOf(points);
  for (const h of holes) {
    const p = new THREE.Path();
    h.forEach(([a, b], i) => (i === 0 ? p.moveTo(a, b) : p.lineTo(a, b)));
    p.closePath();
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.0005, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  g.translate(0, 0, -(depth - 2 * bevel) / 2);
  return g;
}

/** A footprint (points [x, z]) extruded up from y = 0 to `height`. */
export function planPrismG(points: readonly Pt[], height: number, bevel = 0): THREE.BufferGeometry {
  const g = frontProfileG(
    points.map(([x, z]) => [x, -z] as const),
    height,
    bevel,
  );
  g.rotateX(-Math.PI / 2);
  g.translate(0, height / 2, 0);
  return g;
}

/** A cylinder standing on its axis (y), centered. */
export function cylG(rTop: number, rBottom: number, h: number, segments = 16, open = false) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, open);
}

/** A lathe of [radius, y] points around the y axis. */
export function latheG(points: readonly Pt[], segments = 16): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)),
    segments,
  );
}

/** A tube along a smooth path. */
export function tubeG(points: readonly Vec3[], radius: number, segments = 24, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, segments, radius, radial, false);
}

/** A tube along straight segments with mitred corners (a bent pipe or strut). */
export function polyTubeG(points: readonly Vec3[], radius: number, radial = 8) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    path.add(new THREE.LineCurve3(new THREE.Vector3(...a), new THREE.Vector3(...b)));
  }
  return new THREE.TubeGeometry(path, Math.max(1, points.length - 1) * 2, radius, radial, false);
}

export function torusG(r: number, tube: number, radial = 8, tubular = 24, arc = Math.PI * 2) {
  return new THREE.TorusGeometry(r, tube, radial, tubular, arc);
}

/**
 * Horizontal louver slats facing +z: `count` slats of `w` by `slat` meters,
 * each tilted down outward, filling `h` meters; the frame added by the caller.
 */
export function louversG(
  w: number,
  h: number,
  count: number,
  slat = 0.012,
): THREE.BufferGeometry[] {
  const pitch = h / count;
  return Array.from({ length: count }, (_, i) => {
    const g = new THREE.BoxGeometry(w, Math.min(slat, pitch * 0.8), 0.006);
    g.rotateX(-0.6);
    g.translate(0, -h / 2 + pitch * (i + 0.5), 0);
    return g;
  });
}

/** Triangles of a geometry (indexed or not). */
export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index?.count ?? g.getAttribute('position').count) / 3;
}
