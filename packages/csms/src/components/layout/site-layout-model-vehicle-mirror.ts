// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Exterior mirrors of the vehicle kits and the arms that hold them on the body
// (owner rule 2026-11-02: no floating mirror; every arm touches the body and
// the mirror head). Frame of every function: the vehicle's own frame, nose at
// z = 0, the body along +z, x across (left side at -x), y up from the ground.
//
// - A city bus carries its mirrors on curved "banana" arms from the front
//   corners above the windshield, reaching forward and out over the corners,
//   the heads hanging in front of the windshield pillars (the arrangement of
//   12 m low floor city buses of the class, for example the Mercedes eCitaro;
//   2.95 m across the mirrors).
// - A truck cab carries each mirror on a bracket of two tubes from the door
//   frame to the head (the West Coast mirror mount of class 6 to 8 cabs).
// - A car mirror stands on a short stalk on the door top at the windshield base.

import * as THREE from 'three';
import type { Vec3 } from './site-layout-model-kit';

/** How far into the body and the head an arm reaches, so no seam shows: 5 mm. */
export const MIRROR_ARM_EMBED_M = 0.005;

/**
 * The bus mirror: a 0.12 by 0.42 by 0.2 m head 0.14 m out from the body side,
 * centered 2.15 m above grade and 0.38 m in front of the nose (2.95 m across
 * the heads on a 2.55 m bus: 2.55 + 2 x (0.14 + 0.06)). The arm, a 44 mm
 * tube, leaves the front face 0.1 m in from the corner at 2.9 m, past its
 * 0.07 m rounded edge, and arcs forward and out to the head top. Derived.
 */
export const BUS_MIRROR = {
  head: { widthM: 0.12, heightM: 0.42, depthM: 0.2, outM: 0.14, centerY: 2.15, z: -0.38 },
  arm: { radiusM: 0.022, anchorY: 2.9, insetM: 0.1 },
} as const;

/**
 * The bus front face z at height `y`: the side outline's straight line from
 * (z 0.02, y 2.2) to (z 0.12, y roofY - 0.05) (`buildBus`).
 */
export function busFrontFaceZ(y: number, roofY: number): number {
  return 0.02 + ((y - 2.2) / (roofY - 0.05 - 2.2)) * 0.1;
}

/** The center and size of a bus mirror head on `side` (-1 left, 1 right). */
export function busMirrorHead(side: -1 | 1, width: number): { center: Vec3; size: Vec3 } {
  const h = BUS_MIRROR.head;
  return {
    center: [side * (width / 2 + h.outM), h.centerY, h.z],
    size: [h.widthM, h.heightM, h.depthM],
  };
}

/**
 * The arm's center line: from inside the front face (embedded by the arm
 * radius plus `MIRROR_ARM_EMBED_M`, so its end disc is under the surface),
 * up and forward over the corner, down onto the head top (ending inside it).
 */
export function busMirrorArmPoints(side: -1 | 1, width: number, roofY: number): Vec3[] {
  const a = BUS_MIRROR.arm;
  const head = busMirrorHead(side, width);
  const faceZ = busFrontFaceZ(a.anchorY, roofY);
  const x0 = side * (width / 2 - a.insetM);
  const xh = head.center[0];
  const topY = head.center[1] + head.size[1] / 2;
  return [
    [x0, a.anchorY, faceZ + a.radiusM + MIRROR_ARM_EMBED_M],
    [x0, a.anchorY + 0.02, faceZ - 0.06],
    [side * (width / 2 + 0.05), a.anchorY + 0.02, -0.2],
    [xh, a.anchorY - 0.15, head.center[2]],
    [xh, topY - a.radiusM - MIRROR_ARM_EMBED_M, head.center[2]],
  ];
}

/** The bus arm as a tube geometry in the vehicle frame. */
export function busMirrorArmGeometry(
  side: -1 | 1,
  width: number,
  roofY: number,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    busMirrorArmPoints(side, width, roofY).map((p) => new THREE.Vector3(...p)),
  );
  return new THREE.TubeGeometry(curve, 20, BUS_MIRROR.arm.radiusM, 8, false);
}

/**
 * A truck mirror: a 0.08 m deep head on a bracket of two 30 mm tubes, one
 * near its top and one near its bottom, from the door frame (the cab side at
 * x = cab half width) to the head's inner face. `headOutM` is the head center
 * out from the cab side.
 */
export interface TruckMirror {
  head: { center: Vec3; size: Vec3 };
  tubes: Array<{ from: Vec3; to: Vec3 }>;
}

export const TRUCK_MIRROR_TUBE_RADIUS_M = 0.015;

export function truckMirror(
  side: -1 | 1,
  cabHalfWidth: number,
  at: { y: number; z: number; headOutM: number; head: Vec3 },
): TruckMirror {
  const [hw, hh, hd] = at.head;
  const center: Vec3 = [side * (cabHalfWidth + at.headOutM), at.y, at.z];
  const inner = side * (cabHalfWidth + at.headOutM - hw / 2 + MIRROR_ARM_EMBED_M);
  const from = side * (cabHalfWidth - MIRROR_ARM_EMBED_M);
  const tubes = [at.y + hh / 2 - 0.06, at.y - hh / 2 + 0.06].map((y) => ({
    from: [from, y, at.z] as Vec3,
    to: [inner, y, at.z] as Vec3,
  }));
  return { head: { center, size: [hw, hh, hd] }, tubes };
}

/** A straight tube between two points (a bracket arm). */
export function mirrorTubeGeometry(from: Vec3, to: Vec3, radius: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(radius, radius, len, 8);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    b.clone().sub(a).normalize(),
  );
  g.applyQuaternion(q);
  const mid = a.add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/**
 * A car mirror stalk: a 50 by 80 by 50 mm block from inside the door top (its
 * bottom `embed` under the body's top line at the windshield base) up into the
 * mirror head, at the head's inner third. Returns its center and size.
 */
export function carMirrorStalk(
  side: -1 | 1,
  width: number,
  bodyTopY: number,
  head: { center: Vec3; size: Vec3 },
): { center: Vec3; size: Vec3 } {
  const bottom = bodyTopY - 0.03;
  const top = head.center[1] - head.size[1] / 2 + 0.02;
  return {
    center: [side * (width / 2 - 0.03), (bottom + top) / 2, head.center[2]],
    size: [0.05, top - bottom, 0.05],
  };
}
