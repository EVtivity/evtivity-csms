// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Parts shared by the depot charging models of the 3D site layout (the
// pantograph pole, the pantograph hood, the bus roof pantograph, the bus and
// the megawatt dispensers): their material slots, straight struts between
// two points, ribbed insulators and the scissor (lazy tong) linkage of a
// pantograph.

import * as THREE from 'three';
import {
  ModelParts,
  boxG,
  cylG,
  latheG,
  type ModelKit,
  type Pt,
  type Vec3,
} from './site-layout-model-kit';

/**
 * The material slots of the depot models. `plate` is the front plate area a
 * scene can tint (the station's accent color); `insulator` the gray silicone
 * of the insulators; `copper` the contact rails and shoes.
 */
export const DEPOT_SLOTS = [
  'body',
  'plate',
  'trim',
  'metal',
  'glass',
  'light',
  'insulator',
  'copper',
  'rubber',
  'stop',
  'concrete',
] as const;
export type DepotSlot = (typeof DEPOT_SLOTS)[number];
export type DepotKit = ModelKit<DepotSlot>;
export type DepotParts = ModelParts<DepotSlot>;
export type DepotMaterials = Readonly<Record<DepotSlot, THREE.Material>>;

const UP = new THREE.Vector3(0, 1, 0);

function between(g: THREE.BufferGeometry, a: Vec3, b: Vec3): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const len = dir.length();
  if (len > 1e-6) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(
    ...new THREE.Vector3(...a)
      .add(new THREE.Vector3(...b))
      .multiplyScalar(0.5)
      .toArray(),
  );
  return g;
}

/** A rectangular tube from a to b, `w` by `d` in section. */
export function strutG(a: Vec3, b: Vec3, w: number, d: number): THREE.BufferGeometry {
  const len = new THREE.Vector3(...b).distanceTo(new THREE.Vector3(...a));
  return between(boxG(w, Math.max(0.001, len), d), a, b);
}

/** A round bar or tube from a to b. */
export function rodG(a: Vec3, b: Vec3, r: number, segments = 8): THREE.BufferGeometry {
  const len = new THREE.Vector3(...b).distanceTo(new THREE.Vector3(...a));
  return between(cylG(r, r, Math.max(0.001, len), segments), a, b);
}

/**
 * A ribbed post insulator `h` high standing on y = 0: a core of radius
 * `core` with `sheds` weather sheds of radius `shed`. The metal end caps are
 * added by the caller.
 */
export function insulatorG(h: number, core: number, shed: number, sheds = 4): THREE.BufferGeometry {
  const pts: Pt[] = [
    [0, 0],
    [core, 0],
  ];
  const pitch = h / (sheds + 1);
  for (let i = 1; i <= sheds; i += 1) {
    const y = pitch * i;
    pts.push([core, y - pitch * 0.35], [shed, y - pitch * 0.1], [shed, y], [core, y + pitch * 0.1]);
  }
  pts.push([core, h], [0, h]);
  return latheG(pts, 10);
}

/** An insulator with its metal end caps, from y0 to y1 (either direction) at (x, z). */
export function addInsulator(
  p: DepotParts,
  at: { x: number; z: number },
  y0: number,
  y1: number,
  core = 0.025,
  shed = 0.045,
): void {
  const lo = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  const cap = Math.min(0.025, h * 0.15);
  p.add('metal', cylG(core + 0.006, core + 0.006, cap, 10), { at: [at.x, lo + cap / 2, at.z] });
  p.add('metal', cylG(core + 0.006, core + 0.006, cap, 10), {
    at: [at.x, lo + h - cap / 2, at.z],
  });
  p.add('insulator', insulatorG(h - 2 * cap, core, shed, h > 0.12 ? 4 : 3), {
    at: [at.x, lo + cap, at.z],
  });
}

/**
 * The geometry of a scissor (lazy tong) linkage of `stages` crossed arm
 * pairs of length `armM` spanning `heightM`: each stage is `heightM / stages`
 * high and its arms span `widthM` between the outer pivots
 * (armM^2 = width^2 + stage height^2).
 */
export function scissorWidth(armM: number, heightM: number, stages: number): number {
  const h = heightM / stages;
  return Math.sqrt(Math.max(0, armM * armM - h * h));
}

/** The height a scissor linkage reaches, clamped to what its arms allow (folded at 5 percent of an arm per stage). */
export function scissorHeight(armM: number, stages: number, wantM: number): number {
  return Math.min(Math.max(wantM, stages * armM * 0.05), stages * armM * 0.97);
}

export interface ScissorOptions {
  /** Maps (u across the linkage, y, s off its plane) to the model frame. */
  map: (u: number, y: number, s: number) => Vec3;
  /** Where the linkage starts and which way it runs (-1 down, 1 up). */
  startY: number;
  dir: -1 | 1;
  heightM: number;
  stages: number;
  armM: number;
  /** The offsets of the two parallel linkage planes. */
  planes: readonly number[];
  /** The arm section: across its plane and off it. */
  armW: number;
  armD: number;
  pinR: number;
}

/**
 * A scissor linkage in two parallel planes: crossed arms per stage (the two
 * arms of a pair offset off the plane so they pass each other), pins at
 * every crossing and joint, and cross shafts tying the planes together at
 * the outer joints. Returns the span of its last stage.
 */
export function addScissor(p: DepotParts, o: ScissorOptions): number {
  const h = o.heightM / o.stages;
  const w = scissorWidth(o.armM, o.heightM, o.stages);
  const sMin = Math.min(...o.planes);
  const sMax = Math.max(...o.planes);
  for (let k = 0; k < o.stages; k += 1) {
    const y0 = o.startY + o.dir * k * h;
    const y1 = y0 + o.dir * h;
    for (const s of o.planes) {
      const off = o.armD * 0.55;
      p.add('metal', strutG(o.map(-w / 2, y0, s + off), o.map(w / 2, y1, s + off), o.armW, o.armD));
      p.add('metal', strutG(o.map(w / 2, y0, s - off), o.map(-w / 2, y1, s - off), o.armW, o.armD));
      // The center pin of the pair.
      p.add(
        'trim',
        rodG(o.map(0, (y0 + y1) / 2, s - off * 2), o.map(0, (y0 + y1) / 2, s + off * 2), o.pinR),
      );
    }
    // Cross shafts at the outer joints, plane to plane.
    for (const u of [-w / 2, w / 2]) {
      p.add('trim', rodG(o.map(u, y1, sMin - o.armD), o.map(u, y1, sMax + o.armD), o.pinR));
    }
  }
  return w;
}

/** Builds a kit into a group named `name`. */
export function buildDepotGroup(
  kit: DepotKit,
  materials: DepotMaterials,
  name: string,
): THREE.Group {
  const g = kit.build(materials);
  g.name = name;
  return g;
}
