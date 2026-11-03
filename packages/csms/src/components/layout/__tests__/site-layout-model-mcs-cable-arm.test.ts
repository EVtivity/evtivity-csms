// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MCS_ARM,
  createMcsArmBoomKit,
  createMcsArmPoleKit,
  mcsArmBendM,
  mcsArmOutlet,
} from '../site-layout-model-mcs-cable-arm';
import {
  mcsArmCable,
  mcsArmChargingYaw,
  mcsArmIdleYaw,
  mcsArmOutletAt,
  mcsArmPole,
  mcsArmReachM,
  mcsArmYawToward,
  mcsHangingLength,
  minBendRadius,
} from '../site-layout-mcs-arm-cable';
import { MCS_DISPENSER, MCS_DISPENSER_HOLSTER } from '../site-layout-model-mcs-dispenser';
import { CONNECTOR_SPECS, handleCableEntry, holsterPose } from '../site-layout-connectors';
import { CABLE_MIN_BEND_RATIO } from '../site-layout-model-cable-gland';
import type { Vec3 } from '../site-layout-model-kit';
import { DEPOT_SLOTS, type DepotSlot } from '../site-layout-model-scissor';

function materials(): Record<DepotSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(DEPOT_SLOTS.map((s) => [s, m])) as unknown as Record<
    DepotSlot,
    THREE.Material
  >;
}

const D = CONNECTOR_SPECS.mcs.cableDiameterM;
const FLOOR = 0.45;

/**
 * The cable is one piece from the slewing head over the boom into the
 * handle: no gap between points, every bend at least six diameters.
 */
function expectOnePiece(route: readonly Vec3[], pole: Vec3, end: Vec3): void {
  const first = route[0] ?? [0, 0, 0];
  // It starts at the slewing head on the pole.
  expect(Math.hypot(first[0] - pole[0], first[2] - pole[2])).toBeLessThan(0.15);
  expect(route[route.length - 1]).toEqual(end);
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1] ?? first;
    const b = route[i] ?? first;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThan(0.2);
  }
  // The last two points run straight along the boot axis into the handle.
  expect(minBendRadius(route.slice(0, -1))).toBeGreaterThanOrEqual(CABLE_MIN_BEND_RATIO * D - 1e-6);
  expect(mcsArmBendM(D)).toBeCloseTo(CABLE_MIN_BEND_RATIO * D, 9);
}

describe('MCS cable management arm', () => {
  it('builds the pole and boom under 3000 triangles, the boom above the dispenser', () => {
    const pole = createMcsArmPoleKit();
    const boom = createMcsArmBoomKit(D);
    expect(pole.triangles + boom.triangles).toBeLessThan(3000);
    const pb = new THREE.Box3().setFromObject(pole.build(materials()));
    expect(pb.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(pb.max.y).toBeCloseTo(MCS_ARM.pivotY - 0.01, 1);
    const bb = new THREE.Box3().setFromObject(boom.build(materials()));
    // Everything on the boom stays above the dispenser top and the 80 in clearance.
    expect(bb.min.y).toBeGreaterThan(MCS_DISPENSER.heightM);
    expect(bb.min.y).toBeGreaterThan(80 * 0.0254);
    expect(bb.max.x).toBeGreaterThan(MCS_ARM.boomM - 0.01);
    expect(mcsArmOutlet(0, D)[1]).toBeGreaterThan(80 * 0.0254);
  });

  it('hangs the idle cable from the stowed boom into the holstered handle, clear of the island', () => {
    const at = { x: 0, z: 0 };
    const pole = mcsArmPole(at);
    // The pole stands clear of the dispenser body.
    expect(Math.abs(pole[0]) - MCS_ARM.pole.sizeM / 2).toBeGreaterThan(MCS_DISPENSER.widthM / 2);
    const h = MCS_DISPENSER_HOLSTER;
    const pose = holsterPose({ x: h[0], y: h[1], z: h[2] }, { x: 0, z: 1 });
    const entry = handleCableEntry(pose.handle, pose.handleYaw, 'mcs');
    const yaw = mcsArmIdleYaw(pole, entry, FLOOR, D);
    // Stowed toward the holster, turned no more than 90 degrees.
    expect(Math.abs(yaw - mcsArmYawToward(pole, entry.lead))).toBeLessThanOrEqual(
      Math.PI / 2 + 1e-9,
    );
    const route = mcsArmCable(pole, yaw, entry, FLOOR, D);
    expectOnePiece(route, pole, entry.end);
    const out = mcsArmOutletAt(pole, yaw, D);
    expect(route.some((p) => Math.hypot(p[0] - out[0], p[1] - out[1], p[2] - out[2]) < 1e-6)).toBe(
      true,
    );
    expect(Math.min(...route.map((p) => p[1]))).toBeGreaterThanOrEqual(FLOOR - 1e-6);
    expect(mcsHangingLength(route, D)).toBeLessThanOrEqual(MCS_ARM.cableM + 0.01);
    // The handle sits in the ADA 308 reach range.
    expect(entry.end[1]).toBeGreaterThan(15 * 0.0254);
    expect(entry.end[1]).toBeLessThan(48 * 0.0254);
  });

  it('swings the boom toward the inlet with its tip outside the truck side', () => {
    const pole = mcsArmPole({ x: 0, z: 0 });
    for (const inlet of [
      [0.8, 1.0, 1.0],
      [1.4, 1.1, 0.9],
      [0.3, 1.0, 2.0],
    ] as const) {
      const side = inlet[2] - 0.1;
      const yaw = mcsArmChargingYaw(pole, [...inlet], side - 0.25, D);
      const tipZ = pole[2] + Math.sin(yaw) * mcsArmReachM(D);
      expect(tipZ).toBeLessThanOrEqual(side - 0.25 + 1e-9);
      // Toward the inlet's side in x.
      expect(Math.sign(Math.cos(yaw))).toBe(Math.sign(inlet[0] - pole[0]) || 1);
      const plug = {
        lead: [inlet[0], inlet[1], inlet[2] - 0.1] as const,
        end: [...inlet] as const,
      };
      const route = mcsArmCable(pole, yaw, plug, FLOOR, D);
      expect(Math.min(...route.map((p) => p[1]))).toBeGreaterThanOrEqual(FLOOR - 1e-6);
      expectOnePiece(route, pole, plug.end);
      expect(mcsHangingLength(route, D)).toBeLessThanOrEqual(MCS_ARM.cableM + 0.01);
    }
  });
});
