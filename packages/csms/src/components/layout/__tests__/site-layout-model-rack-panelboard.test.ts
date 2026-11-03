// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NEMA3R_PANEL } from '../site-layout-model-nema3r-enclosure';
import { POWER_SLOTS, type PowerKit, type PowerSlot } from '../site-layout-model-power-slots';
import {
  RACK_PANELBOARD,
  createRackPanelboardKit,
  rackEnclosureBackZ,
} from '../site-layout-model-rack-panelboard';
import { STRUT_CHANNEL, strutChannelG } from '../site-layout-model-strut';

function materials(): Record<PowerSlot, THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return Object.fromEntries(POWER_SLOTS.map((s) => [s, m])) as unknown as Record<
    PowerSlot,
    THREE.Material
  >;
}

function slotBounds(kit: PowerKit, slot: PowerSlot): THREE.Box3 {
  const mesh = kit.build(materials()).getObjectByName(slot);
  if (mesh == null) throw new Error(slot);
  return new THREE.Box3().setFromObject(mesh);
}

describe('panelboard on a strut rack', () => {
  it('builds the NEMA 3R enclosure (0.51 x 0.97 x 0.165 m) topped at 1.87 m under 3000 triangles', () => {
    const { kit } = createRackPanelboardKit();
    expect(kit.triangles).toBeLessThan(3000);
    const door = slotBounds(kit, 'door');
    expect(door.max.y).toBeLessThan(RACK_PANELBOARD.topM);
    expect(door.max.z).toBeCloseTo(rackEnclosureBackZ() + NEMA3R_PANEL.depthM, 3);
    const body = slotBounds(kit, 'body');
    // The box top sits at 1.87 m, the drip hood above it.
    expect(body.min.y).toBeCloseTo(RACK_PANELBOARD.topM - NEMA3R_PANEL.heightM, 3);
    expect(body.max.y).toBeCloseTo(RACK_PANELBOARD.topM + NEMA3R_PANEL.hood.heightM, 3);
    const pad = slotBounds(kit, 'concrete');
    expect(pad.max.x - pad.min.x).toBeCloseTo(RACK_PANELBOARD.padWM, 3);
    expect(pad.max.y).toBeCloseTo(RACK_PANELBOARD.padHM, 3);
  });

  it('runs the conduit from the enclosure bottom into the pad', () => {
    const { kit } = createRackPanelboardKit();
    const conduit = slotBounds(kit, 'conduit');
    expect(conduit.min.y).toBeCloseTo(RACK_PANELBOARD.padHM, 3);
    expect(conduit.max.y).toBeCloseTo(RACK_PANELBOARD.topM - NEMA3R_PANEL.heightM, 3);
  });

  it('extrudes a real P1000 C channel, not a box', () => {
    const g = strutChannelG(1, 'y');
    g.computeBoundingBox();
    const b = g.boundingBox ?? new THREE.Box3();
    expect(b.max.x - b.min.x).toBeCloseTo(STRUT_CHANNEL.sizeM, 4);
    expect(b.max.z - b.min.z).toBeCloseTo(STRUT_CHANNEL.sizeM, 4);
    expect(b.max.y - b.min.y).toBeCloseTo(1, 4);
    // A lipped C section has 16 corners: far more faces than a box's 12 triangles.
    const tris = (g.index?.count ?? g.getAttribute('position').count) / 3;
    expect(tris).toBeGreaterThanOrEqual(60);
    const bar = strutChannelG(0.8, 'x');
    bar.computeBoundingBox();
    expect((bar.boundingBox?.max.x ?? 0) - (bar.boundingBox?.min.x ?? 0)).toBeCloseTo(0.8, 4);
  });
});
