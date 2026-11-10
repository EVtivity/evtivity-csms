// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cable hook every charger loops its idle cable over (owner decisions
// 2026-11-02 and 2026-11-09: a simple generic J hook close to the body that
// does not stick out). A powder coated steel rod bent into a J: out of a
// round rose screwed to the body face, straight out through the throat where
// the turns rest side by side, then bent up into a short tip so the loops
// cannot slide off; nothing past the tip. The generic utility J hook of the
// class (round rod, rose plate, upturned tip); no manufacturer publishes
// the dimensions of the cable hooks sold with chargers (research 2026-11-10),
// so the sizes below are derived.
//
// Frame: the mounting face is z = 0, the throat runs out along +z, the rod's
// axis at y = 0, its top at `CABLE_HOOK.rodRadiusM`. The turns hang parallel
// to the face, each in its own plane along the throat (`cableHookTurnZ`).

import * as THREE from 'three';
import { ModelParts, cylG, latheG } from './site-layout-model-kit';
import type { ModelKit } from './site-layout-model-kit';

/** The material slots of the hook. */
export const CABLE_HOOK_SLOTS = [
  /** The powder coated steel rod and rose. */
  'body',
  /** Steel: the screw heads. */
  'metal',
] as const;
export type CableHookSlot = (typeof CABLE_HOOK_SLOTS)[number];
export type CableHookKit = ModelKit<CableHookSlot>;

/**
 * The hook's fixed sizes, derived: a 12 mm rod (a common bent rod hook
 * section, stiff enough for 3.6 m of 35 mm DC cable, about 5 kg), a 50 mm
 * round rose 8 mm thick with two screws, 3 mm between the rose and the first
 * turn and between the last turn and the bend, a 12 mm bend radius into a tip
 * 38 mm high (more than the thickest cable, the 35.3 mm CCS1 cable, so a turn cannot slide off).
 */
export const CABLE_HOOK = {
  rodRadiusM: 0.006,
  roseRadiusM: 0.025,
  roseThicknessM: 0.008,
  gapM: 0.003,
  bendRadiusM: 0.012,
  tipRiseM: 0.038,
} as const;

/** Turns rest side by side on the throat at this many cable diameters each. */
export const CABLE_TURN_PITCH = 1.05;

/**
 * The tightest bend of a cable at rest over its hook, in cable diameters, by
 * cable class: the minimum bending radius its makers publish. A heavy cable
 * over a 12 mm rod rests on the rod's top and bends no tighter than this.
 * - DC: 5, the fixed (at rest) minimum of the Topcable EVC DC 1500 V
 *   datasheet (IEC 62893-4-1, 2x50+1G25, 28.5 mm, "5 x diameter",
 *   https://www.topcable.com/downloads/pdf/en/topcable-datasheet-evc-dc-1500v-en.pdf);
 *   Amphenol's CCS2 cable sheet gives 4 x OD fixed, 8 x OD flexing (not re-read).
 * - AC: 10, the only minimum the LAPP OLFLEX CHARGE AC datasheet publishes
 *   ("Flexing: 10 x outer diameter", EN 50620 and IEC 62893-3, March 2025,
 *   https://lappmobility.lappgroup.com/media/69/9a/53/1760680212/Oelflex-Charge-AC-en.pdf).
 */
export const CABLE_REST_BEND_RATIO = { ac: 10, dc: 5 } as const;

/** The class of a charging cable: AC (pedestals, curb posts, wall boxes) or DC (dispensers, satellites). */
export type CableClass = keyof typeof CABLE_REST_BEND_RATIO;

/**
 * The most an AC cable's top bend takes: 10 times the thickest cable of the
 * LAPP sheet (5G6+1x0.5, 16.1 mm), 0.161 m; an AC charger's cable is drawn
 * at most that thick (`AC_CABLE_MAX_DIAMETER_M`). Derived.
 */
export const AC_COIL_TOP_MAX_M = 0.161;

/** The radius the cable's center line runs at over the top of the hook. */
export function coilTopRadius(cableDiameterM: number, cable: CableClass): number {
  const bend = CABLE_REST_BEND_RATIO[cable] * cableDiameterM;
  return Math.max(
    cable === 'ac' ? Math.min(bend, AC_COIL_TOP_MAX_M) : bend,
    CABLE_HOOK.rodRadiusM + cableDiameterM / 2,
  );
}

export interface CableHookSpec {
  /** The throat's length: room for every turn it holds side by side plus a gap at each end. */
  throatM: number;
}

/** The hook for turns `turnsWidthM` wide in all (turns times `CABLE_TURN_PITCH` diameters). */
export function cableHookSpec(turnsWidthM: number): CableHookSpec {
  return { throatM: turnsWidthM + 2 * CABLE_HOOK.gapM };
}

/**
 * The most a hook over a sidewalk (an AC pedestal, curb post or wall box) may
 * stand out: 4 in (0.1016 m), the protrusion limit of the 2010 ADA Standards
 * 307.2 for objects 27 to 80 in above the floor.
 */
export const SIDEWALK_HOOK_MAX_M = 4 * 0.0254;

/**
 * The turns a sidewalk hook holds for a cable `cableDiameterM` thick: up to
 * `maxTurns`, fewer for a thick cable (the 25 mm J3400 cable two), so the
 * hook stays within `SIDEWALK_HOOK_MAX_M`; at least one.
 */
export function sidewalkHookTurns(maxTurns: number, cableDiameterM: number): number {
  const h = CABLE_HOOK;
  const fixed = h.roseThicknessM + 2 * h.gapM + h.bendRadiusM + h.rodRadiusM;
  const fit = Math.floor((SIDEWALK_HOOK_MAX_M - fixed) / (CABLE_TURN_PITCH * cableDiameterM));
  return Math.max(1, Math.min(maxTurns, fit));
}

/** The width `turns` turns of a cable `cableDiameterM` thick take on the throat. */
export function turnsWidth(turns: number, cableDiameterM: number): number {
  return turns * CABLE_TURN_PITCH * cableDiameterM;
}

/** Where along the throat (z) turn `k` of a cable of `cableDiameterM` hangs, `offsetM` past earlier cables. */
export function cableHookTurnZ(k: number, cableDiameterM: number, offsetM = 0): number {
  return (
    CABLE_HOOK.roseThicknessM +
    CABLE_HOOK.gapM +
    offsetM +
    (k + 0.5) * CABLE_TURN_PITCH * cableDiameterM
  );
}

/** How far the hook stands out from the face: rose, throat, bend and the rod's half thickness. */
export function cableHookProjectionM(spec: CableHookSpec): number {
  return CABLE_HOOK.roseThicknessM + spec.throatM + CABLE_HOOK.bendRadiusM + CABLE_HOOK.rodRadiusM;
}

/** The rod's center line: out of the face, through the throat, round the bend, up the tip. */
export function cableHookPath(spec: CableHookSpec): THREE.Vector3[] {
  const h = CABLE_HOOK;
  const end = h.roseThicknessM + spec.throatM;
  const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0.002), new THREE.Vector3(0, 0, end)];
  for (let i = 1; i <= 8; i += 1) {
    const a = ((Math.PI / 2) * i) / 8;
    pts.push(
      new THREE.Vector3(0, h.bendRadiusM * (1 - Math.cos(a)), end + h.bendRadiusM * Math.sin(a)),
    );
  }
  pts.push(new THREE.Vector3(0, h.bendRadiusM + h.tipRiseM, end + h.bendRadiusM));
  return pts;
}

/** The hook, its rod axis at the frame origin's height, out along +z from the face. */
export function createCableHookKit(spec: CableHookSpec): CableHookKit {
  const h = CABLE_HOOK;
  const p = new ModelParts<CableHookSlot>();
  // The rose: a round plate with a softened rim, its back on the face.
  p.add(
    'body',
    latheG(
      [
        [0, h.roseThicknessM],
        [h.roseRadiusM - 0.004, h.roseThicknessM],
        [h.roseRadiusM, h.roseThicknessM - 0.003],
        [h.roseRadiusM, 0],
        [0, 0],
      ],
      20,
    ),
    { rot: [Math.PI / 2, 0, 0] },
  );
  // Two screw heads, above and below the rod.
  for (const sy of [-1, 1]) {
    p.add('metal', cylG(0.0045, 0.0045, 0.002, 10), {
      at: [0, sy * 0.015, h.roseThicknessM + 0.001],
      rot: [Math.PI / 2, 0, 0],
    });
  }
  // The rod: one bent piece, the straight runs and the bend sampled along its path.
  const path = new THREE.CurvePath<THREE.Vector3>();
  const pts = cableHookPath(spec);
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a != null && b != null) path.add(new THREE.LineCurve3(a, b));
  }
  p.add('body', new THREE.TubeGeometry(path, 32, h.rodRadiusM, 10, false));
  // A rounded tip, so the rod ends as a bent rod does.
  const tip = pts[pts.length - 1];
  if (tip != null) {
    p.add('body', new THREE.SphereGeometry(h.rodRadiusM, 10, 6), { at: [tip.x, tip.y, tip.z] });
  }
  return p.kit();
}

/** The hook group built with `materials` (tests and renders). */
export function buildCableHook(
  spec: CableHookSpec,
  materials: Readonly<Record<CableHookSlot, THREE.Material>>,
): THREE.Group {
  return createCableHookKit(spec).build(materials);
}
