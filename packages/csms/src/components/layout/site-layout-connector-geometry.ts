// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The connector handles and holsters of the 3D site layout, built in code from
// the specs of site-layout-connectors.ts: a shroud of the plug's real face
// outline around a dark insert with the contact openings at their layout, a
// metal contact in each, a shaped head that tapers into a curved pistol grip,
// the latch, lever, ring or button of the type, and a ribbed strain relief
// boot where the cable leaves. A holster is a cup of the same outline on a
// mounting plate, so each handle seats in its own type's holster.
//
// The handle's frame: the plug face at the origin facing +z, the head toward
// -z, the grip down and back to the cable end (`handleCableEndLocal`). The
// holster's frame: the cup mouth at the origin facing +z, its plate behind it.
// The parts are merged into one geometry per material slot, so a handle is at
// most five meshes; a kit is built once per type and shared by every clone.

import * as THREE from 'three';
import { concat, extrudeProfile } from './site-layout-car-geometry';
import {
  CONNECTOR_SPECS,
  HOLSTER,
  faceOutline,
  gripAxis,
  insertOutlines,
  type ConnectorKind,
  type ConnectorSpec,
} from './site-layout-connectors';

export interface ConnectorMaterials {
  /** The handle or holster housing plastic. */
  shell: THREE.Material;
  /** The dark face insert and the cup bottom. */
  insert: THREE.Material;
  /** The metal contacts and fixing screws. */
  contact: THREE.Material;
  /** The latch, lever, locking ring or button. */
  trim: THREE.Material;
  /** The rubber strain relief boot. */
  boot: THREE.Material;
}

export const CONNECTOR_MATERIAL_SLOTS = ['shell', 'insert', 'contact', 'trim', 'boot'] as const;
type Slot = (typeof CONNECTOR_MATERIAL_SLOTS)[number];

export interface ConnectorKit {
  build: (materials: ConnectorMaterials) => THREE.Group;
  geometries: THREE.BufferGeometry[];
  triangles: number;
}

type Part = { slot: Slot; geometry: THREE.BufferGeometry };

function shapeOf(points: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

function pathOf(points: ReadonlyArray<readonly [number, number]>): THREE.Path {
  const p = new THREE.Path();
  points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  p.closePath();
  return p;
}

/** Segments of a contact opening: more for a power contact than a signal one. */
function contactSegments(d: number): number {
  return d > 0.009 ? 12 : d > 0.006 ? 10 : 6;
}

function circle(x: number, y: number, r: number, segments: number): Array<[number, number]> {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r] as [number, number];
  });
}

function insidePolygon(
  poly: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i] ?? [0, 0];
    const [xj, yj] = poly[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The convex hull of a closed outline, counter clockwise (monotone chain). */
function convexHull(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (
    o: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
  ): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<readonly [number, number]>): Array<[number, number]> => {
    const out: Array<readonly [number, number]> = [];
    for (const p of list) {
      for (;;) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (a == null || b == null || cross(a, b, p) > 0) break;
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out.map((p) => [p[0], p[1]]);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Turns a geometry's faces inward (the wall of an opening, seen from inside). */
function insideOut(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.getIndex();
  if (index != null) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
  }
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normal.count; i += 1) {
    normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  }
  return g;
}

/** A face-plane extrusion from z = z0 back to z = z0 - depth. */
function extrudeFace(
  shape: THREE.Shape,
  depth: number,
  z0: number,
  bevel = 0,
): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, z0 - depth);
  return g;
}

/** Narrows the head toward its back, so the barrel blends into the body. */
function taperHead(g: THREE.BufferGeometry, spec: ConnectorSpec, cy: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const from = spec.headLengthM * 0.35;
  for (let i = 0; i < pos.count; i += 1) {
    const back = -pos.getZ(i);
    const t = Math.min(1, Math.max(0, (back - from) / (spec.headLengthM - from)));
    const k = 1 - 0.18 * t * t;
    pos.setX(i, pos.getX(i) * k);
    pos.setY(i, cy + (pos.getY(i) - cy) * k);
  }
  pos.needsUpdate = true;
}

/** A body of revolution along +y (radius, height pairs), turned onto `axis` at `at`. */
function lathe(
  profile: ReadonlyArray<readonly [number, number]>,
  segments: number,
  at: THREE.Vector3,
  axis: THREE.Vector3,
): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, h]) => new THREE.Vector2(r, h)),
    segments,
  );
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis));
  g.translate(at.x, at.y, at.z);
  return g;
}

/** A side profile (u along +z, v up) extruded `width` across x, centered, rounded by `bevel`. */
function side(shape: THREE.Shape, width: number, bevel: number, x = 0): THREE.BufferGeometry {
  const g = extrudeProfile(shape, width, bevel, 3, 2);
  g.translate(x, 0, 0);
  return g;
}

function smoothShape(points: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const s = new THREE.Shape();
  const [first, ...rest] = points.map(([u, w]) => new THREE.Vector2(u, w));
  if (first == null) return s;
  s.moveTo(first.x, first.y);
  s.splineThru([...rest, first]);
  return s;
}

/** Shape points to a smooth closed polyline with a fixed number of points (keeps the triangle count known). */
function smoothPoints(
  points: ReadonlyArray<readonly [number, number]>,
  n: number,
): Array<[number, number]> {
  return smoothShape(points)
    .getSpacedPoints(n)
    .slice(0, n)
    .map((p) => [p.x, p.y] as [number, number]);
}

function handleParts(kind: ConnectorKind): Part[] {
  const spec = CONNECTOR_SPECS[kind];
  const parts: Part[] = [];
  const outer = faceOutline(spec, 0);
  const inserts = insertOutlines(spec);
  const ys = outer.map((p) => p[1]);
  const top = Math.max(...ys);
  const bottom = Math.min(...ys);
  const cy = (top + bottom) / 2;
  const h = spec.headLengthM;

  // The shroud: the face outline as a wall around the recessed insert, tapering back.
  const shroud = shapeOf(outer);
  for (const inner of inserts) shroud.holes.push(pathOf(inner));
  if (spec.dcBlockHeightM > 0) {
    // A combo plug: the figure-eight nose, then one housing around both parts.
    const nose = Math.min(h * 0.4, 0.035);
    parts.push({ slot: 'shell', geometry: extrudeFace(shroud, nose, 0, 0.0025) });
    const housing = extrudeFace(shapeOf(convexHull(outer)), h - nose, -nose);
    taperHead(housing, spec, cy);
    parts.push({ slot: 'shell', geometry: housing });
  } else {
    const head = extrudeFace(shroud, h, 0, 0.0025);
    taperHead(head, spec, cy);
    parts.push({ slot: 'shell', geometry: head });
  }

  // The face insert, recessed in the shroud, with an opening per contact.
  const recess = 0.006;
  const insertDepth = 0.012;
  for (const inner of inserts) {
    const face = shapeOf(inner);
    for (const c of spec.contacts) {
      if (!insidePolygon(inner, c.x, c.y)) continue;
      face.holes.push(pathOf(circle(c.x, c.y, c.d / 2, contactSegments(c.d)).reverse()));
    }
    // Only its front shows (the shroud closes the sides), and each opening has its own wall.
    const front = new THREE.ShapeGeometry(face, 1);
    front.translate(0, 0, -recess);
    parts.push({ slot: 'insert', geometry: front });
  }
  for (const c of spec.contacts) {
    const n = contactSegments(c.d);
    // thetaStart lines its edge up with the opening in the insert.
    const wall = new THREE.CylinderGeometry(c.d / 2, c.d / 2, insertDepth, n, 1, true, Math.PI / 2);
    wall.rotateX(Math.PI / 2);
    wall.translate(c.x, c.y, -recess - insertDepth / 2);
    // The socket sleeve: a metal tube lining the opening.
    parts.push({ slot: 'contact', geometry: insideOut(wall) });
  }
  // The contact at the bottom of each opening, with its dark center bore that takes the inlet's pin.
  for (const c of spec.contacts) {
    const segments = contactSegments(c.d);
    const sleeve = new THREE.CircleGeometry(c.d / 2, segments);
    sleeve.translate(c.x, c.y, -recess - insertDepth + 0.0005);
    parts.push({ slot: 'contact', geometry: sleeve });
    const bore = new THREE.CircleGeometry(c.d * 0.24, 6);
    bore.translate(c.x, c.y, -recess - insertDepth + 0.001);
    parts.push({ slot: 'insert', geometry: bore });
  }

  // The body: a side profile from inside the head back over the thumb rest and
  // down the grip to the boot, with a finger rest under the head.
  const axis = gripAxis(kind);
  const gw = spec.gripDiameterM;
  const n = { u: axis.dir.v, v: -axis.dir.u }; // the top (back) edge side of the grip
  const grip = axis.start;
  const end = axis.end;
  const gl = spec.gripLengthM;
  // A point along the grip, `t` of its length, `k` grip widths off its axis toward the top edge.
  const at = (t: number, k: number): [number, number] => [
    grip.u + axis.dir.u * gl * t + n.u * gw * k,
    grip.v + axis.dir.v * gl * t + n.v * gw * k,
  ];
  const profile: Array<[number, number]> = [
    [-h * 0.4, cy + (top - cy) * 0.55],
    [-h * 0.85, top - (top - cy) * 0.08],
    at(0.22, 0.5),
    at(1, 0.48),
    [end.u + axis.dir.u * gw * 0.12, end.v + axis.dir.v * gw * 0.12],
    at(1, -0.48),
    at(0.58, -0.4),
    at(0.2, -0.56),
    [-h * 0.5, bottom + (cy - bottom) * 0.35],
  ];
  const body = shapeOf(smoothPoints(profile, 22));
  const bodyWidth = Math.min(spec.faceWidthM * 0.82, gw * 1.1);
  parts.push({ slot: 'shell', geometry: side(body, bodyWidth, bodyWidth * 0.3) });

  // The strain relief boot: a ribbed cone from the grip end to the cable.
  const cr = spec.cableDiameterM / 2;
  const r0 = Math.max(cr * 1.3, gw * 0.36);
  const bl = spec.bootLengthM;
  const ribs: Array<[number, number]> = [
    [0.001, -0.005],
    [r0, -0.005],
    [r0 * 0.96, bl * 0.18],
    [r0 * 0.84, bl * 0.26],
    [r0 * 0.88, bl * 0.42],
    [r0 * 0.72, bl * 0.5],
    [r0 * 0.74, bl * 0.66],
    [cr + 0.004, bl * 0.85],
    [cr + 0.0015, bl],
    [0.001, bl],
  ];
  const dir3 = new THREE.Vector3(0, axis.dir.v, axis.dir.u);
  parts.push({
    slot: 'boot',
    geometry: lathe(ribs, 8, new THREE.Vector3(0, end.v, end.u), dir3),
  });

  // Grip pad on the front of the grip (a softer overmold for the fingers).
  const pad = shapeOf(
    smoothPoints(
      [at(0.24, -0.58), at(0.6, -0.46), at(0.97, -0.52), at(0.97, -0.18), at(0.58, -0.12)],
      10,
    ),
  );
  parts.push({ slot: 'boot', geometry: side(pad, bodyWidth * 1.06, bodyWidth * 0.2) });

  const trim = latchParts(kind, spec, top, cy, at);
  for (const g of trim) parts.push({ slot: 'trim', geometry: g });
  return parts;
}

function latchParts(
  kind: ConnectorKind,
  spec: ConnectorSpec,
  top: number,
  cy: number,
  at: (t: number, k: number) => [number, number],
): THREE.BufferGeometry[] {
  const h = spec.headLengthM;
  if (spec.latch === 'thumb') {
    // The J1772 latch: a lever along the top whose hook drops in front of the
    // face onto the inlet's latch pin, pressed down by the thumb at its back.
    const [pu, pv] = at(0.2, 0.5);
    const lever = smoothPoints(
      [
        [0.012, top + 0.002],
        [0.014, top - 0.007],
        [0.008, top - 0.007],
        [0.005, top + 0.0005],
        [-h * 0.5, top + 0.001],
        [-h * 0.85, top + 0.001],
        [pu, pv + 0.001],
        [pu - 0.004, pv + 0.01],
        [-h * 0.85, top + 0.0075],
        [-h * 0.5, top + 0.006],
        [0.004, top + 0.0055],
      ],
      14,
    );
    return [side(shapeOf(lever), 0.014, 0.002)];
  }
  if (spec.latch === 'lever') {
    // The locking lever over the top: hinged on the head, its grip end raised
    // at the back where the hand closes on it (CHAdeMO, MCS).
    const k = spec.faceWidthM / 0.086;
    const front = kind === 'mcs' ? -h * 0.45 : -0.012;
    const [ru, rv] = at(0.12, 0.5);
    const [eu, ev] = at(0.3, 0.5);
    const lever = smoothPoints(
      [
        [front, top + 0.002],
        [front, top + 0.012 * k],
        [-h * 0.6, top + 0.014 * k],
        [ru, rv + 0.03 * k],
        [eu, ev + 0.028 * k],
        [eu + 0.004, ev + 0.008 * k],
        [-h * 0.6, top + 0.004 * k],
      ],
      14,
    );
    const parts = [side(shapeOf(lever), 0.022 * k, 0.004 * k)];
    if (kind === 'chademo') {
      // The coupling sleeve around the front of the shroud.
      const ringR = spec.faceWidthM / 2 + 0.004;
      const ringFront = new THREE.RingGeometry(spec.faceWidthM / 2 - 0.001, ringR, 20, 1);
      ringFront.translate(0, cy, -0.012);
      const ringBand = new THREE.CylinderGeometry(ringR, ringR, 0.014, 20, 1, true);
      ringBand.rotateX(Math.PI / 2);
      ringBand.translate(0, cy, -0.019);
      parts.push(ringFront, ringBand);
    }
    return parts;
  }
  if (spec.latch === 'button') {
    // NACS: the button on top of the handle behind the head (it opens the car's charge port).
    const pill = smoothPoints(
      [
        [-h * 0.55, top - 0.002],
        [-h * 0.55, top + 0.003],
        [-h * 0.85, top + 0.003],
        [-h * 0.88, top - 0.002],
      ],
      12,
    );
    return [side(shapeOf(pill), 0.013, 0.0025)];
  }
  return [];
}

function holsterParts(kind: ConnectorKind): Part[] {
  const spec = CONNECTOR_SPECS[kind];
  const parts: Part[] = [];
  const wall = faceOutline(spec, HOLSTER.clearanceM + HOLSTER.wallM);
  const mouth = faceOutline(spec, HOLSTER.clearanceM);
  // The cup the plug's nose seats in, its rim chamfered.
  const cup = shapeOf(wall);
  cup.holes.push(pathOf(mouth));
  parts.push({ slot: 'shell', geometry: extrudeFace(cup, HOLSTER.cupDepthM, 0) });
  parts.push({
    slot: 'insert',
    geometry: extrudeFace(shapeOf(wall), 0.004, -HOLSTER.cupDepthM),
  });
  // The mounting plate behind the cup, taller below for the cable hook, and two screws.
  const xs = wall.map((p) => p[0]);
  const ys = wall.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs) + 0.02;
  const top = Math.max(...ys) + 0.012;
  const bottom = Math.min(...ys) - 0.045;
  const r = 0.012;
  const plate = new THREE.Shape();
  plate.moveTo(-w / 2 + r, bottom);
  plate.lineTo(w / 2 - r, bottom);
  plate.quadraticCurveTo(w / 2, bottom, w / 2, bottom + r);
  plate.lineTo(w / 2, top - r);
  plate.quadraticCurveTo(w / 2, top, w / 2 - r, top);
  plate.lineTo(-w / 2 + r, top);
  plate.quadraticCurveTo(-w / 2, top, -w / 2, top - r);
  plate.lineTo(-w / 2, bottom + r);
  plate.quadraticCurveTo(-w / 2, bottom, -w / 2 + r, bottom);
  const plateBack = -HOLSTER.cupDepthM - HOLSTER.plateM;
  parts.push({
    slot: 'shell',
    geometry: extrudeFace(plate, HOLSTER.plateM, -HOLSTER.cupDepthM, 0.002),
  });
  for (const y of [top - 0.008, bottom + 0.008]) {
    const screw = new THREE.CylinderGeometry(0.004, 0.004, 0.003, 6);
    screw.rotateX(Math.PI / 2);
    screw.translate(0, y, -HOLSTER.cupDepthM + 0.0015);
    parts.push({ slot: 'contact', geometry: screw });
  }
  // A web under the cup that carries it, from the plate to the rim.
  const lowest = Math.min(...ys);
  const web = new THREE.Shape();
  web.moveTo(plateBack + HOLSTER.plateM, bottom + 0.01);
  web.lineTo(-0.006, lowest + 0.002);
  web.lineTo(-0.012, lowest + 0.008);
  web.lineTo(plateBack + HOLSTER.plateM, lowest + 0.008);
  web.closePath();
  parts.push({ slot: 'shell', geometry: extrudeProfile(web, 0.008, 0, 1, 1) });
  return parts;
}

function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index?.count ?? g.getAttribute('position').count) / 3;
}

function kitOf(parts: Part[]): ConnectorKit {
  const bySlot = new Map<Slot, THREE.BufferGeometry[]>();
  for (const { slot, geometry } of parts) {
    const flat = geometry.index != null ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(flat.attributes)) {
      if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
    }
    if (!('normal' in flat.attributes)) flat.computeVertexNormals();
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), flat]);
    geometry.dispose();
  }
  const merged = new Map<Slot, THREE.BufferGeometry>();
  for (const slot of CONNECTOR_MATERIAL_SLOTS) {
    const list = bySlot.get(slot) ?? [];
    if (list.length === 0) continue;
    merged.set(slot, concat(list));
    for (const g of list) g.dispose();
  }
  const geometries = [...merged.values()];
  return {
    geometries,
    triangles: geometries.reduce((sum, g) => sum + triangleCount(g), 0),
    build(m: ConnectorMaterials): THREE.Group {
      const g = new THREE.Group();
      for (const [slot, geometry] of merged) {
        const mesh = new THREE.Mesh(geometry, m[slot]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = slot;
        g.add(mesh);
      }
      return g;
    },
  };
}

/** The handle of a connector type (its face at the origin facing +z). */
export function createConnectorHandleKit(kind: ConnectorKind): ConnectorKit {
  return kitOf(handleParts(kind));
}

/** The holster of a connector type (its cup mouth at the origin facing +z). */
export function createConnectorHolsterKit(kind: ConnectorKind): ConnectorKit {
  return kitOf(holsterParts(kind));
}
