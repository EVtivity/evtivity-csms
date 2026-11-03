// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  OUTDOOR_SWITCHBOARD,
  SWITCHBOARD_SLOTS,
  createOutdoorSwitchboardKit,
  type SwitchboardSlot,
} from '../site-layout-model-switchboard';

function materials(): Record<SwitchboardSlot, THREE.Material> {
  return Object.fromEntries(
    SWITCHBOARD_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<SwitchboardSlot, THREE.Material>;
}

function boxOf(g: THREE.Object3D, slot: string): THREE.Box3 {
  const o = g.getObjectByName(slot);
  if (o == null) throw new Error(`no ${slot} mesh`);
  return new THREE.Box3().setFromObject(o);
}

describe('outdoor switchboard', () => {
  it('keeps the scene envelope and stays under 7000 triangles', () => {
    const kit = createOutdoorSwitchboardKit();
    expect(kit.triangles).toBeLessThan(7000);
    const b = new THREE.Box3().setFromObject(kit.build(materials()));
    expect(b.min.y).toBeCloseTo(0, 3);
    expect(b.max.y).toBeGreaterThan(2.3);
    expect(b.max.y).toBeLessThan(2.36);
    expect(b.max.x - b.min.x).toBeCloseTo(OUTDOOR_SWITCHBOARD.pad.widthM, 2);
    expect(b.max.z - b.min.z).toBeCloseTo(OUTDOOR_SWITCHBOARD.pad.depthM, 2);
  });

  it('draws the enclosure 1.9 m wide and 0.8 m deep and uses every slot', () => {
    const kit = createOutdoorSwitchboardKit();
    for (const s of SWITCHBOARD_SLOTS) expect(kit.slotTriangles[s] ?? 0).toBeGreaterThan(0);
    const body = boxOf(kit.build(materials()), 'body');
    expect(body.max.x - body.min.x).toBeCloseTo(OUTDOOR_SWITCHBOARD.widthM + 0.1, 2);
    const doors = boxOf(kit.build(materials()), 'door');
    expect(doors.max.z).toBeLessThan(OUTDOOR_SWITCHBOARD.depthM / 2 + 0.05);
    expect(doors.min.z).toBeGreaterThan(-OUTDOOR_SWITCHBOARD.depthM / 2 - 0.05);
  });
});
