// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  READER_INTERFACE_Y_M,
  READER_SLOTS,
  type ReaderSlot,
} from '../site-layout-model-reader-parts';
import {
  CONTACTLESS_READER,
  createContactlessReaderKit,
} from '../site-layout-model-reader-contactless';

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

describe('contactless card reader model', () => {
  const kit = createContactlessReaderKit();
  const group = kit.build(materials());

  it('stays under 1200 triangles', () => {
    expect(kit.triangles).toBeLessThan(1200);
  });

  it('has no screen, unlike the screen reader', () => {
    expect(group.getObjectByName('screen')).toBeUndefined();
    expect(kit.slotTriangles.screen).toBeUndefined();
  });

  it('builds the 68 mm landing zone in an 86 mm bezel at the card interface height', () => {
    const zone = slotBox(group, 'zone');
    expect(zone.max.x - zone.min.x).toBeCloseTo(CONTACTLESS_READER.module.sizeM, 2);
    expect((zone.min.y + zone.max.y) / 2).toBeCloseTo(READER_INTERFACE_Y_M, 4);
    const bezel = slotBox(group, 'bezel');
    expect(bezel.max.x - bezel.min.x).toBeCloseTo(CONTACTLESS_READER.bezel.sizeM, 3);
    for (const slot of ['mark', 'light', 'metal', 'body'] as const) slotBox(group, slot);
    expect(slotBox(group, 'mark').max.z).toBeGreaterThan(zone.max.z);
  });
});
