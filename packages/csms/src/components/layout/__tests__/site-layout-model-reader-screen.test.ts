// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { READER_INTERFACE_ABOVE_MOUNT_M } from '../site-layout-grid';
import {
  READER_BRACKET,
  READER_INTERFACE_Y_M,
  READER_SCENE_SCALE,
  READER_SLOTS,
  type ReaderSlot,
} from '../site-layout-model-reader-parts';
import { SCREEN_READER, createScreenReaderKit } from '../site-layout-model-reader-screen';

function materials(): Record<ReaderSlot, THREE.Material> {
  return Object.fromEntries(
    READER_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<ReaderSlot, THREE.Material>;
}

function slotBox(group: THREE.Group, slot: ReaderSlot): THREE.Box3 {
  const mesh = group.getObjectByName(slot);
  expect(mesh, slot).toBeDefined();
  return new THREE.Box3().setFromObject(mesh as THREE.Object3D);
}

describe('screen card reader model', () => {
  const kit = createScreenReaderKit();
  const group = kit.build(materials());

  it('stays under 1500 triangles', () => {
    expect(kit.triangles).toBeLessThan(1500);
  });

  it('has the datasheet front (132 by 88 mm) and stands on its bracket off the host', () => {
    const body = slotBox(group, 'body');
    expect(body.max.x - body.min.x).toBeCloseTo(SCREEN_READER.widthM, 3);
    const all = new THREE.Box3().setFromObject(group);
    expect(all.min.z).toBeGreaterThanOrEqual(-0.0001);
    expect(all.max.z).toBeCloseTo(READER_BRACKET.standoffM + SCREEN_READER.depthM, 2);
  });

  it('shows a lit 95 by 54 mm screen centered at the card interface height', () => {
    const screen = slotBox(group, 'screen');
    expect(screen.max.x - screen.min.x).toBeCloseTo(SCREEN_READER.screen.widthM, 3);
    expect(screen.max.y - screen.min.y).toBeCloseTo(SCREEN_READER.screen.heightM, 3);
    expect((screen.min.y + screen.max.y) / 2).toBeCloseTo(READER_INTERFACE_Y_M, 4);
    expect(READER_INTERFACE_Y_M * READER_SCENE_SCALE).toBeCloseTo(
      READER_INTERFACE_ABOVE_MOUNT_M,
      6,
    );
  });

  it('carries the contactless mark beside the screen, the LEDs and the chip slot below', () => {
    for (const slot of ['mark', 'light', 'slot', 'bezel', 'metal'] as const) slotBox(group, slot);
    expect(slotBox(group, 'mark').min.x).toBeGreaterThan(slotBox(group, 'screen').max.x);
    expect(slotBox(group, 'slot').max.y).toBeLessThan(
      READER_INTERFACE_Y_M - SCREEN_READER.heightM / 2,
    );
  });
});
