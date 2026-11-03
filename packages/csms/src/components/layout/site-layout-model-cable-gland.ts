// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cable gland where a charging cable leaves a charger body: a hex body
// nut on the wall, a sealing dome that clamps the cable and a ribbed strain
// relief, sized from the cable's outside diameter, and the cable's first run
// out of it (straight along the gland axis, then a bend no tighter than the
// cable allows). One gland for every charger model.

import * as THREE from 'three';
import { ModelParts, cylG, latheG, type ModelKit, type Vec3 } from './site-layout-model-kit';

export const CABLE_GLAND_SLOTS = ['nut', 'dome', 'relief'] as const;
export type CableGlandSlot = (typeof CABLE_GLAND_SLOTS)[number];

/**
 * Gland sizes derived from the cable outside diameter d (no single source
 * sizes them; typical of the class, for example Lapp SKINTOP and Hummel HSK
 * glands): the clamping range must hold d, which takes a metric thread about
 * d + 8 mm (M50 clamps about 25 to 38 mm, M20 6 to 12 mm); the hex body is
 * about 1.2 times the thread across flats and a third of it high; the dome is
 * as wide as the thread and 0.6 of it long; the strain relief is 1.5 d long
 * and tapers from the dome to the cable.
 */
export function cableGlandSize(cableDiameterM: number): {
  threadM: number;
  nutM: number;
  nutHeightM: number;
  domeM: number;
  reliefM: number;
  lengthM: number;
} {
  const threadM = cableDiameterM + 0.008;
  const nutHeightM = threadM / 3;
  const domeM = threadM * 0.6;
  const reliefM = cableDiameterM * 1.5;
  return {
    threadM,
    nutM: threadM * 1.2,
    nutHeightM,
    domeM,
    reliefM,
    lengthM: nutHeightM + domeM + reliefM,
  };
}

/**
 * The tightest bend of a charging cable: 6 times its outside diameter (the
 * usual minimum for a flexing rubber-sheathed cable at rest: the cable makers'
 * 6 d to 7.5 d for mobile use; IEC 60364-5-52 Table 52.1 is cited for it but
 * was not read, the standard is paywalled, so that citation is unverified).
 */
export const CABLE_MIN_BEND_RATIO = 6;

/** A stand-in material: the gland's parts are copied into the caller's slots. */
const nil = new THREE.MeshBasicMaterial();

/** The rotation that turns the gland's +y axis onto `axis` (a unit vector). */
function axisEuler(axis: Vec3): Vec3 {
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(...axis).normalize(),
  );
  const e = new THREE.Euler().setFromQuaternion(q);
  return [e.x, e.y, e.z];
}

/**
 * Adds a gland at `at` (on the body wall) pointing out along `axis`, its
 * parts in the slots given.
 */
export function addCableGland<S extends string>(
  parts: ModelParts<S>,
  slots: Readonly<Record<CableGlandSlot, S>>,
  at: Vec3,
  axis: Vec3,
  cableDiameterM: number,
): void {
  const g = cableGlandSize(cableDiameterM);
  const rot = axisEuler(axis);
  const local = new ModelParts<CableGlandSlot>();
  const r = g.threadM / 2;
  // The hex body nut on the wall, chamfered at its outer edge.
  local.add('nut', cylG(g.nutM / 2 - 0.001, g.nutM / 2, g.nutHeightM, 6), {
    at: [0, g.nutHeightM / 2, 0],
  });
  // The sealing dome: a short cylinder rounding over to the cable.
  local.add(
    'dome',
    latheG(
      [
        [r, g.nutHeightM],
        [r, g.nutHeightM + g.domeM * 0.45],
        [r * 0.85, g.nutHeightM + g.domeM * 0.8],
        [cableDiameterM / 2 + 0.002, g.nutHeightM + g.domeM],
      ],
      14,
    ),
  );
  // The ribbed strain relief tapering to the cable.
  const y0 = g.nutHeightM + g.domeM;
  const ribs = 4;
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i <= ribs * 2; i++) {
    const t = i / (ribs * 2);
    const base = cableDiameterM / 2 + (r - cableDiameterM / 2) * 0.6 * (1 - t);
    pts.push([base + (i % 2 === 0 ? 0.0015 : 0), y0 + g.reliefM * t]);
  }
  local.add('relief', latheG(pts, 12));
  const kit = local.kit();
  const placed = kit.build({ nut: nil, dome: nil, relief: nil });
  for (const mesh of placed.children) {
    if (!(mesh instanceof THREE.Mesh)) continue;
    const slot = mesh.name as CableGlandSlot;
    parts.add(slots[slot], (mesh.geometry as THREE.BufferGeometry).clone(), { at, rot });
  }
  for (const geometry of kit.geometries) geometry.dispose();
}

/** A gland on its own (for its test): on the origin, pointing up. */
export function createCableGlandKit(cableDiameterM: number): ModelKit<CableGlandSlot> {
  const p = new ModelParts<CableGlandSlot>();
  addCableGland(
    p,
    { nut: 'nut', dome: 'dome', relief: 'relief' },
    [0, 0, 0],
    [0, 1, 0],
    cableDiameterM,
  );
  return p.kit();
}

/**
 * The first run of a cable out of a gland at `at` pointing along `axis`:
 * from inside the gland on its axis, out past the strain relief tip by one
 * diameter, then a quarter bend toward `bend` (a unit vector square to the
 * axis) of radius CABLE_MIN_BEND_RATIO diameters. The caller continues the
 * cable from the last point.
 */
export function cableOutOfGland(at: Vec3, axis: Vec3, cableDiameterM: number, bend: Vec3): Vec3[] {
  const a = new THREE.Vector3(...axis).normalize();
  const b = new THREE.Vector3(...bend).normalize();
  const o = new THREE.Vector3(...at);
  const g = cableGlandSize(cableDiameterM);
  const tip = o.clone().addScaledVector(a, g.lengthM + cableDiameterM);
  const r = CABLE_MIN_BEND_RATIO * cableDiameterM;
  const arc = [Math.PI / 6, Math.PI / 3, Math.PI / 2].map((t) =>
    tip
      .clone()
      .addScaledVector(a, r * Math.sin(t))
      .addScaledVector(b, r * (1 - Math.cos(t))),
  );
  // Points along the axis up to the bend keep the smooth curve straight through the gland.
  const along = [-0.01, g.lengthM / 2, g.lengthM].map((t) => o.clone().addScaledVector(a, t));
  return [...along, tip, ...arc].map((v) => [v.x, v.y, v.z] as const);
}
