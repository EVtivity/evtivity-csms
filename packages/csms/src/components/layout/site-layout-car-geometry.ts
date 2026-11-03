// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cars of the 3D site layout, built in code from the side profiles of
// site-layout-car.ts: a smooth painted lower body with rounded edges and wheel
// arches, a tinted greenhouse with a painted roof and pillars, tires with
// spoked rims, head and tail lights, mirrors, a grille and the charge port.
//
// A kit holds the geometries of one body type; every car of that type (any
// color) shares them, so a site of 150 stations builds five kits at most. The
// car's frame: the nose at z = 0 facing -z, the body along +z, centered on
// x = 0, standing on y = 0. Only the materials passed in differ per car.

import * as THREE from 'three';
import { carPortLocal, type CarPort } from './site-layout-cable';
import {
  CAR_PROFILES,
  ROOF_THICKNESS_M,
  type CarBodyType,
  type CarProfile,
  type ProfilePoint,
} from './site-layout-car';
import { createCarDoorDetailKit } from './site-layout-model-car-doors';
import type { Vec3 } from './site-layout-model-kit';
import { carMirrorStalk } from './site-layout-model-vehicle-mirror';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';

export interface CarMaterials {
  /** The body paint, tinted to the vehicle color. */
  paint: THREE.Material;
  glass: THREE.Material;
  tire: THREE.Material;
  rim: THREE.Material;
  /** Grille, B pillars, bumper trim, mirror caps' arms, bed liner. */
  trim: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  chargePort: THREE.Material;
  /**
   * Unpainted white panels of a large vehicle: a semi trailer's van body and
   * the roof equipment pods of a bus. Cars have none.
   */
  panel: THREE.Material;
}

/** The material slots of a car, one merged geometry each. */
export const CAR_MATERIAL_SLOTS = [
  'paint',
  'glass',
  'tire',
  'rim',
  'trim',
  'headlight',
  'taillight',
  'chargePort',
  'panel',
] as const satisfies readonly (keyof CarMaterials)[];

export interface CarKit {
  bodyType: VehicleBodyType;
  /** A new car of this type: one mesh per material slot, geometries shared by every car of the type. */
  build: (materials: CarMaterials) => THREE.Group;
  /** Where the charge port is, in the car's frame (the cable ends there). */
  port: THREE.Vector3;
  /** A bus: the middle of the contact rails on its roof, where a pantograph comes down. */
  roofContact?: THREE.Vector3 | undefined;
  /** Every geometry of the kit, to dispose with the scene. */
  geometries: readonly THREE.BufferGeometry[];
}

export const TIRE_WIDTH_M = 0.24;
const BODY_BEVEL_M = 0.1;

/**
 * An extruded side profile across the car's width: the profile's u runs along
 * +z, v up, and the extrusion spans x from -width/2 to width/2, its edges
 * rounded by the bevel.
 */
export function extrudeProfile(
  shape: THREE.Shape,
  width: number,
  bevel: number,
  curveSegments = 6,
  bevelSegments = 3,
): THREE.BufferGeometry {
  const depth = Math.max(0.01, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments,
    curveSegments,
  });
  // Shape (u, v) and extrusion w to (x, y, z) = (depth/2 - w, v, u): a rotation,
  // so the faces keep their winding.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, depth / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g;
}

/**
 * Pulls the vertices of an extruded profile toward the middle by `inset(v)`
 * meters at height v: the greenhouse narrowing toward the roof.
 */
function taper(g: THREE.BufferGeometry, inset: (v: number) => number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const d = inset(pos.getY(i));
    pos.setX(i, Math.sign(x) * Math.max(0, Math.abs(x) - d));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function vec(points: readonly ProfilePoint[]): THREE.Vector2[] {
  return points.map(([u, v]) => new THREE.Vector2(u, v));
}

/** The lower body: the profile over the top, then the bottom with an arch over each axle. */
function bodyShape(p: CarProfile): THREE.Shape {
  const shape = new THREE.Shape();
  const first = p.body[0];
  const last = p.body[p.body.length - 1];
  if (first == null || last == null) return shape;
  shape.moveTo(first[0] + 0.12, p.bottom);
  shape.lineTo(first[0], first[1]);
  shape.splineThru(vec(p.body.slice(1)));
  shape.lineTo(last[0] - 0.12, p.bottom);
  const r = p.wheelRadius;
  const arch = r + 0.07;
  // The arch meets the bottom line below the axle (the bottom is lower than the axle).
  const a0 = Math.asin(Math.max(-1, Math.min(1, (p.bottom - r) / arch)));
  for (const axle of [p.rearAxle, p.frontAxle]) {
    shape.lineTo(axle + arch * Math.cos(a0), p.bottom);
    shape.absarc(axle, r, arch, a0, Math.PI - a0, false);
  }
  shape.lineTo(first[0] + 0.12, p.bottom);
  return shape;
}

/** The greenhouse: windshield, side windows and rear window, closed along the beltline. */
function glassShape(p: CarProfile): THREE.Shape {
  const shape = new THREE.Shape();
  const pts = vec(p.glass);
  const start = pts[0];
  const end = pts[pts.length - 1];
  if (start == null || end == null) return shape;
  // Down into the body a little, so no gap shows at the beltline.
  shape.moveTo(start.x, start.y - 0.04);
  shape.lineTo(start.x, start.y);
  shape.splineThru(pts.slice(1));
  shape.lineTo(end.x, end.y - 0.04);
  shape.lineTo(start.x, start.y - 0.04);
  return shape;
}

/** The painted roof: the glass top between the windshield and the rear window, thickened upward. */
function roofShape(p: CarProfile): THREE.Shape {
  const top = vec(p.glass.slice(1, -1));
  const shape = new THREE.Shape();
  const lifted = top.map((pt) => new THREE.Vector2(pt.x, pt.y + ROOF_THICKNESS_M));
  const lowered = [...top].reverse().map((pt) => new THREE.Vector2(pt.x, pt.y - 0.02));
  const first = lifted[0];
  if (first == null) return shape;
  shape.moveTo(first.x, first.y);
  shape.splineThru(lifted.slice(1));
  const back = lowered[0];
  if (back != null) shape.lineTo(back.x, back.y);
  shape.splineThru(lowered.slice(1));
  shape.lineTo(first.x, first.y);
  return shape;
}

/** A tire: a lathed tread with rounded shoulders around the x axis. */
export function tireGeometry(r: number, width = TIRE_WIDTH_M, segments = 20): THREE.BufferGeometry {
  const w = width / 2;
  const inner = r * 0.66;
  const c = 0.04;
  const profile = [
    new THREE.Vector2(inner, -w),
    new THREE.Vector2(r - c, -w),
    new THREE.Vector2(r - c * 0.3, -w + c * 0.3),
    new THREE.Vector2(r, -w + c),
    new THREE.Vector2(r, w - c),
    new THREE.Vector2(r - c * 0.3, w - c * 0.3),
    new THREE.Vector2(r - c, w),
    new THREE.Vector2(inner, w),
  ];
  const g = new THREE.LatheGeometry(profile, segments);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** A box w (x) by h (y) by d (z) with rounded edges, centered on the origin. */
export function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const c = Math.min(r, h / 2, d / 2) * 0.9;
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2 + c, -h / 2);
  shape.lineTo(d / 2 - c, -h / 2);
  shape.quadraticCurveTo(d / 2, -h / 2, d / 2, -h / 2 + c);
  shape.lineTo(d / 2, h / 2 - c);
  shape.quadraticCurveTo(d / 2, h / 2, d / 2 - c, h / 2);
  shape.lineTo(-d / 2 + c, h / 2);
  shape.quadraticCurveTo(-d / 2, h / 2, -d / 2, h / 2 - c);
  shape.lineTo(-d / 2, -h / 2 + c);
  shape.quadraticCurveTo(-d / 2, -h / 2, -d / 2 + c, -h / 2);
  const g = extrudeProfile(shape, w, c * 0.6, 2, 1);
  g.computeVertexNormals();
  return g;
}

/** Non-indexed position and normal geometries joined into one. */
export function concat(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
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
  return g;
}

/**
 * The meshes of an assembled vehicle merged into one geometry per material
 * slot (the parts never move against each other), and a builder that gives
 * a new vehicle of those geometries with the materials passed. Disposes the
 * part geometries given.
 */
export function mergeAssembly(
  assemble: (materials: CarMaterials) => THREE.Group,
  parts: readonly THREE.BufferGeometry[],
): { build: (materials: CarMaterials) => THREE.Group; geometries: THREE.BufferGeometry[] } {
  const placeholders = Object.fromEntries(
    CAR_MATERIAL_SLOTS.map((slot) => [slot, new THREE.MeshBasicMaterial({ name: slot })]),
  ) as unknown as CarMaterials;
  const detailed = assemble(placeholders);
  detailed.updateMatrixWorld(true);
  const bySlot = new Map<string, THREE.BufferGeometry[]>();
  detailed.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const source = o.geometry as THREE.BufferGeometry;
    const flat = source.index != null ? source.toNonIndexed() : source.clone();
    for (const name of Object.keys(flat.attributes)) {
      if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
    }
    flat.applyMatrix4(o.matrixWorld);
    const slot = (o.material as THREE.Material).name;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), flat]);
  });
  const merged = new Map<keyof CarMaterials, THREE.BufferGeometry>();
  for (const slot of CAR_MATERIAL_SLOTS) {
    const list = bySlot.get(slot) ?? [];
    if (list.length === 0) continue;
    merged.set(slot, concat(list));
    for (const part of list) part.dispose();
  }
  for (const part of parts) part.dispose();
  for (const m of Object.values(placeholders) as THREE.Material[]) m.dispose();

  function build(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    for (const [slot, geometry] of merged) {
      const mesh = new THREE.Mesh(geometry, m[slot]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = slot;
      g.add(mesh);
    }
    return g;
  }
  return { build, geometries: [...merged.values()] };
}

/** The kit of one car body type (large vehicles: site-layout-large-vehicle-geometry.ts). */
/** The top of a body side outline at `z` (the highest crossing of its segments). */
export function bodyTopAt(profile: CarProfile, z: number): number {
  const pts = profile.body;
  let top = -Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a == null || b == null) continue;
    const [z0, y0] = a;
    const [z1, y1] = b;
    if ((z - z0) * (z - z1) > 0 || z0 === z1) continue;
    top = Math.max(top, y0 + ((z - z0) / (z1 - z0)) * (y1 - y0));
  }
  return Number.isFinite(top) ? top : profile.height * 0.6;
}

/** Each mirror head (0.2 by 0.11 by 0.09 m) and its stalk, left then right, in the car's own frame. */
export function carMirrorParts(
  profile: CarProfile,
): Array<{ head: { center: Vec3; size: Vec3 }; stalk: { center: Vec3; size: Vec3 } }> {
  const base = profile.glass[0] ?? [1.5, 1];
  const z = base[0] + 0.18;
  return ([-1, 1] as const).map((side) => {
    const head = {
      center: [side * (profile.width / 2 + 0.02), base[1] + 0.06, z] as Vec3,
      size: [0.2, 0.11, 0.09] as Vec3,
    };
    return { head, stalk: carMirrorStalk(side, profile.width, bodyTopAt(profile, z), head) };
  });
}

export function createCarKit(bodyType: CarBodyType, chargePort: CarPort = 'front_left'): CarKit {
  const p = CAR_PROFILES[bodyType];
  const W = p.width;
  const r = p.wheelRadius;
  const rimR = r * 0.66;
  const beltTop = Math.max(...p.body.map((pt) => pt[1]));
  const glassBase = Math.min(...p.glass.map((pt) => pt[1]));
  // Where the roof starts: the lowest roof point (the glass leans in up to it).
  const roofTop = Math.min(...p.glass.slice(1, -1).map((pt) => pt[1]));
  // Glass width at the beltline and at the roof (the greenhouse leans in).
  const glassW = W * 0.9;
  const roofLean = W * 0.11;
  const body = extrudeProfile(bodyShape(p), W, BODY_BEVEL_M);
  body.computeVertexNormals();
  const glass = taper(
    extrudeProfile(glassShape(p), glassW, 0.035),
    // Linear in height, so each side window stays one flat plane.
    (v) => roofLean * Math.min(1, Math.max(0, (v - glassBase) / (roofTop - glassBase))),
  );
  const roof = taper(extrudeProfile(roofShape(p), glassW - 2 * roofLean + 0.04, 0.03), () => 0);
  const tire = tireGeometry(r);
  const rimLip = new THREE.TorusGeometry(rimR * 0.94, 0.028, 6, 20).rotateY(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(rimR * 0.22, rimR * 0.26, 0.05, 10).rotateZ(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(0.035, rimR * 0.9, rimR * 0.16);
  const disc = new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.02, 14).rotateZ(Math.PI / 2);
  const lamp = roundedBox(0.36, 0.09, 0.08, 0.03);
  const mirror = roundedBox(0.2, 0.11, 0.09, 0.035);
  const grille = roundedBox(W * 0.5, 0.12, 0.06, 0.03);
  const pillar = new THREE.BoxGeometry(0.06, 1, 0.07);
  // The charge port door: on a side panel, or across the nose for a nose port.
  const nosePort = chargePort === 'front_center';
  const socket = nosePort
    ? new THREE.BoxGeometry(0.18, 0.14, 0.03)
    : new THREE.BoxGeometry(0.03, 0.14, 0.18);
  const socketLight = nosePort
    ? new THREE.BoxGeometry(0.12, 0.03, 0.035)
    : new THREE.BoxGeometry(0.035, 0.03, 0.12);
  const bedLength = p.bed != null ? p.bed[1] - p.bed[0] : 0;
  const bed = p.bed != null ? roundedBox(W - 0.22, 0.05, bedLength, 0.02) : null;
  const parts: THREE.BufferGeometry[] = [
    body,
    glass,
    roof,
    tire,
    rimLip,
    hub,
    spoke,
    disc,
    lamp,
    mirror,
    grille,
    pillar,
    socket,
    socketLight,
    ...(bed != null ? [bed] : []),
  ];
  // The mirror heads at the windshield base, each on a stalk from the door top
  // (site-layout-model-vehicle-mirror.ts).
  const mirrorParts = carMirrorParts(p);
  const stalk = new THREE.BoxGeometry(...(mirrorParts[0]?.stalk.size ?? [0.05, 0.08, 0.05]));
  parts.push(stalk);

  const glassPts = p.glass;
  const windshieldBase = glassPts[0] ?? [1.5, 1];
  const roofFront = glassPts[1] ?? [2.2, 1.4];
  const roofRear = glassPts[glassPts.length - 2] ?? [3.5, 1.4];
  const rearBase = glassPts[glassPts.length - 1] ?? [4.2, 1];
  const portAt = carPortLocal(p, chargePort);
  const port = new THREE.Vector3(portAt.x, portAt.y, portAt.z);
  // The greenhouse edge at height v (it leans in toward the roof).
  const edgeAt = (v: number): number =>
    glassW / 2 -
    roofLean * Math.min(1, Math.max(0, (v - glassBase) / (roofTop - glassBase))) +
    0.005;
  const bU = (windshieldBase[0] + rearBase[0]) / 2 - 0.1;
  const doors = createCarDoorDetailKit({
    bodyType,
    profile: p,
    edgeAt,
    bPillarU: bU,
    chargePort,
    port: portAt,
  });
  parts.push(...doors.geometries);

  function assemble(m: CarMaterials): THREE.Group {
    const g = new THREE.Group();
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    add(body, m.paint);
    add(glass, m.glass);
    add(roof, m.paint);
    // A pillars along the windshield edges, the last pillars along the rear
    // window, a dark B pillar between the doors.
    const up = new THREE.Vector3(0, 1, 0);
    const strut = (
      from: ProfilePoint,
      to: ProfilePoint,
      side: number,
      material: THREE.Material,
    ) => {
      const a = new THREE.Vector3(side * edgeAt(from[1]), from[1], from[0]);
      const b = new THREE.Vector3(side * edgeAt(to[1]), to[1], to[0]);
      const dir = b.clone().sub(a);
      const s = add(pillar, material);
      s.scale.set(1, dir.length(), 1);
      s.position.copy(a.add(b).multiplyScalar(0.5));
      s.quaternion.setFromUnitVectors(up, dir.normalize());
    };
    const bTop = (roofFront[1] + roofRear[1]) / 2;
    for (const side of [-1, 1]) {
      strut(windshieldBase, roofFront, side, m.paint);
      strut(roofRear, rearBase, side, m.paint);
      strut([bU, windshieldBase[1]], [bU, bTop], side, m.trim);
      // Mirrors at the windshield base, each on its stalk.
      const mp = mirrorParts[side < 0 ? 0 : 1];
      if (mp != null) {
        add(mirror, m.paint).position.set(...mp.head.center);
        add(stalk, m.trim).position.set(...mp.stalk.center);
      }
      // Lights at the front and the back.
      const head = add(lamp, m.headlight);
      head.position.set(side * (W / 2 - 0.32), p.head[1], p.head[0] + 0.01);
      const tail = add(lamp, m.taillight);
      tail.position.set(side * (W / 2 - 0.3), p.tail[1], p.tail[0] - 0.01);
    }
    const grilleMesh = add(grille, m.trim);
    grilleMesh.position.set(0, (p.body[0]?.[1] ?? 0.3) + 0.12, 0.02);
    // Wheels: tire, a brake disc behind the rim, the rim lip, five spokes, the hub.
    for (const axle of [p.frontAxle, p.rearAxle]) {
      for (const side of [-1, 1]) {
        const wheel = new THREE.Group();
        const outer = side * 0.06;
        const t = new THREE.Mesh(tire, m.tire);
        const d = new THREE.Mesh(disc, m.trim);
        d.position.x = -side * 0.03;
        const face = new THREE.Mesh(rimLip, m.rim);
        face.position.x = outer - side * 0.02;
        const h = new THREE.Mesh(hub, m.rim);
        h.position.x = outer;
        wheel.add(t, d, face, h);
        for (let i = 0; i < 5; i += 1) {
          const s = new THREE.Mesh(spoke, m.rim);
          const a = (i / 5) * Math.PI * 2;
          s.position.set(outer, Math.cos(a) * rimR * 0.48, Math.sin(a) * rimR * 0.48);
          s.rotation.x = a;
          wheel.add(s);
        }
        wheel.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        wheel.position.set(side * (W / 2 - TIRE_WIDTH_M / 2 - 0.03), r, axle);
        g.add(wheel);
      }
    }
    if (bed != null && p.bed != null) {
      const liner = add(bed, m.trim);
      liner.position.set(0, beltTop + 0.004, (p.bed[0] + p.bed[1]) / 2);
    }
    // Door gaps, handles, window trim and the open port door.
    g.add(doors.build(m));
    // The charge port (`carPortLocal`), with its status light above it.
    const s = add(socket, m.trim);
    s.position.copy(port);
    const light = add(socketLight, m.chargePort);
    light.position.set(
      nosePort ? port.x : port.x + Math.sign(port.x) * 0.005,
      port.y + 0.09,
      nosePort ? port.z - 0.005 : port.z,
    );
    return g;
  }

  // One geometry per material: a car draws as nine meshes at most, not dozens.
  const { build, geometries } = mergeAssembly(assemble, parts);
  return { bodyType, build, port, geometries };
}
