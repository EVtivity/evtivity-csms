// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CONNECTOR_MATERIAL_SLOTS,
  createConnectorHandleKit,
  createConnectorHolsterKit,
} from '../site-layout-connector-geometry';
import { CONNECTOR_SPECS, type ConnectorKind } from '../site-layout-connectors';

const KINDS = Object.keys(CONNECTOR_SPECS) as ConnectorKind[];

function materials(): Record<(typeof CONNECTOR_MATERIAL_SLOTS)[number], THREE.Material> {
  const m = new THREE.MeshBasicMaterial();
  return { shell: m, insert: m, contact: m, trim: m, boot: m };
}

describe('connector triangle budget', () => {
  it('keeps every handle under 1500 triangles and every holster under 600 (a 150 station site stays small)', () => {
    const counts: Record<string, number> = {};
    for (const kind of KINDS) {
      const handle = createConnectorHandleKit(kind);
      const holster = createConnectorHolsterKit(kind);
      counts[kind] = handle.triangles;
      counts[`${kind} holster`] = holster.triangles;
    }
    for (const kind of KINDS) {
      expect(counts[kind], JSON.stringify(counts)).toBeLessThan(1500);
      expect(counts[`${kind} holster`], `${kind} holster`).toBeLessThan(600);
    }
  });

  it('merges a handle into one mesh per material, at most five, with finite geometry', () => {
    for (const kind of KINDS) {
      const g = createConnectorHandleKit(kind).build(materials());
      expect(g.children.length, kind).toBeLessThanOrEqual(5);
      expect(g.children.length, kind).toBeGreaterThanOrEqual(4);
      const box = new THREE.Box3().setFromObject(g);
      expect(Number.isFinite(box.min.x) && Number.isFinite(box.max.y), kind).toBe(true);
      // The plug face is the front of the handle: nothing reaches past it but the J1772 latch hook.
      expect(box.max.z, kind).toBeLessThan(0.02);
    }
  });

  it('builds each handle to its published length (Amphenol, JE / Obara, Yonggui drawings)', () => {
    // Plug face to the end of the boot, meters: [min, max] of the cited handles.
    const lengths: Record<ConnectorKind, [number, number]> = {
      type1: [0.17, 0.17],
      type2: [0.201, 0.216],
      ccs1: [0.269, 0.271],
      ccs2: [0.267, 0.267],
      chademo: [0.27, 0.304],
      nacs: [0.224, 0.224],
      mcs: [0.395, 0.4],
    };
    for (const kind of KINDS) {
      const g = createConnectorHandleKit(kind).build(materials());
      const box = new THREE.Box3().setFromObject(g);
      const length = -box.min.z;
      const [min, max] = lengths[kind];
      expect(length, kind).toBeGreaterThan(min * 0.88);
      expect(length, kind).toBeLessThan(max * 1.12);
    }
  });
});
