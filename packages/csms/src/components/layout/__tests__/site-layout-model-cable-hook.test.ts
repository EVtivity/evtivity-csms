// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AC_COIL_TOP_MAX_M,
  CABLE_HOOK,
  CABLE_HOOK_SLOTS,
  CABLE_REST_BEND_RATIO,
  buildCableHook,
  cableHookPath,
  cableHookProjectionM,
  cableHookSpec,
  cableHookTurnZ,
  coilTopRadius,
  createCableHookKit,
  turnsWidth,
  type CableHookSlot,
} from '../site-layout-model-cable-hook';
import { acHookSpec, dcHookSpec } from '../site-layout-charger-cables';
import { satelliteHookSpec } from '../site-layout-satellite-cables';
import { wallBoxHookSpec } from '../site-layout-wall-box-cable';
import { CONNECTOR_SPECS } from '../site-layout-connectors';

function materials(): Record<CableHookSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(CABLE_HOOK_SLOTS.map((s) => [s, m])) as unknown as Record<
    CableHookSlot,
    THREE.Material
  >;
}

describe('J cable hook model', () => {
  it('holds the turns side by side on its throat, the first one past the rose', () => {
    const spec = cableHookSpec(turnsWidth(3, 0.0125));
    expect(spec.throatM).toBeCloseTo(3 * 1.05 * 0.0125 + 2 * CABLE_HOOK.gapM, 9);
    // The first turn's inner edge clears the rose; the last turn's outer edge clears the bend.
    const first = cableHookTurnZ(0, 0.0125);
    expect(first - 0.0125 / 2).toBeGreaterThan(CABLE_HOOK.roseThicknessM);
    const last = cableHookTurnZ(2, 0.0125);
    expect(last + 0.0125 / 2).toBeLessThan(CABLE_HOOK.roseThicknessM + spec.throatM);
  });

  it('is a bent rod: straight out, round the bend, up the tip, nothing past it', () => {
    const spec = cableHookSpec(turnsWidth(2, 0.0353));
    const path = cableHookPath(spec);
    const end = path[path.length - 1];
    expect(end?.y).toBeCloseTo(CABLE_HOOK.bendRadiusM + CABLE_HOOK.tipRiseM, 9);
    // The tip rises higher than the thickest cable resting on the rod, so no turn slides off.
    expect(CABLE_HOOK.bendRadiusM + CABLE_HOOK.tipRiseM - CABLE_HOOK.rodRadiusM).toBeGreaterThan(
      0.0353,
    );
    const b = new THREE.Box3().setFromObject(buildCableHook(spec, materials()));
    // Mounted on the face (z = 0), nothing behind it; out no further than its projection.
    expect(b.min.z).toBeGreaterThanOrEqual(-1e-6);
    expect(b.max.z).toBeLessThanOrEqual(cableHookProjectionM(spec) + 1e-6);
    // Never a plain stand-in: a lathed rose, two screws, a tube rod and its rounded tip.
    expect(createCableHookKit(spec).triangles).toBeGreaterThan(300);
    expect(createCableHookKit(spec).triangles).toBeLessThan(1500);
  });

  it('stands out no more than 4 in on a sidewalk (2010 ADA 307.2) for the AC and wall box hooks', () => {
    // Every AC connector's cable, the 25 mm J3400 cable included.
    for (const kind of ['type1', 'type2', 'nacs'] as const) {
      const d = CONNECTOR_SPECS[kind].cableDiameterM;
      expect(cableHookProjectionM(acHookSpec(d))).toBeLessThanOrEqual(0.1016);
      expect(cableHookProjectionM(wallBoxHookSpec(d))).toBeLessThanOrEqual(0.1016);
    }
    // The DC and satellite hooks hold thicker cables: still close to the body.
    for (const kind of ['ccs1', 'ccs2', 'chademo', 'nacs'] as const) {
      expect(cableHookProjectionM(dcHookSpec(kind))).toBeLessThan(0.13);
      expect(cableHookProjectionM(satelliteHookSpec(kind))).toBeLessThan(0.2);
    }
  });

  it('bends every cable over it no tighter than the cited rest bend', () => {
    for (const kind of Object.keys(CONNECTOR_SPECS) as Array<keyof typeof CONNECTOR_SPECS>) {
      const d = CONNECTOR_SPECS[kind].cableDiameterM;
      for (const cable of ['ac', 'dc'] as const) {
        expect(coilTopRadius(d, cable)).toBeGreaterThanOrEqual(
          Math.min(CABLE_REST_BEND_RATIO[cable] * d, cable === 'ac' ? AC_COIL_TOP_MAX_M : Infinity),
        );
      }
    }
  });
});
