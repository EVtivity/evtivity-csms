// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { SURFACE_M } from '../site-layout-cable-surface';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createConnectorHandleKit,
  createConnectorHolsterKit,
  type ConnectorMaterials,
} from '../site-layout-connector-geometry';
import { holsterPose, type ConnectorKind } from '../site-layout-connectors';
import {
  AC_WALL_BOX,
  WALL_BOX_ADA,
  wallBoxDock,
  wallBoxHolsterMount,
  type WallBoxPorts,
} from '../site-layout-model-wall-box';
import { buildIdleChargerModel } from '../site-layout-scene-charger-model';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { wallBoxOffset } from '../site-layout-grid';

/** Every connector type an AC wall box carries (`connectorKindOf` for an AC station). */
const AC_KINDS: readonly ConnectorKind[] = ['type1', 'type2', 'nacs'];
// The 15 to 48 in reach range above the sidewalk the box hangs over (ADA heights count from the walking surface).
const REACH = {
  min: SURFACE_M.sidewalk + 15 * 0.0254,
  max: SURFACE_M.sidewalk + 48 * 0.0254,
};

function materials(): ConnectorMaterials {
  const m = new THREE.MeshBasicMaterial();
  return { shell: m, insert: m, contact: m, trim: m, boot: m };
}

/** Every vertex of `root` in its parent frame. */
function vertices(root: THREE.Object3D): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geometry = o.geometry as THREE.BufferGeometry;
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
    }
  });
  return out;
}

/** The handle seated in its holster in the dock of `side`, posed as the scene poses them (wall face z = 0). */
function dockedConnector(kind: ConnectorKind, ports: WallBoxPorts, side: -1 | 1): THREE.Group {
  const dock = wallBoxHolsterMount(WALL_BOX_BOTTOM_M, ports, side);
  const pose = holsterPose(dock.mount, dock.facing, dock.noseUp);
  const g = new THREE.Group();
  const holster = createConnectorHolsterKit(kind).build(materials());
  holster.position.set(pose.mouth.x, pose.mouth.y, pose.mouth.z);
  holster.rotation.set(pose.holsterTilt, pose.holsterYaw, 0, 'YXZ');
  const handle = createConnectorHandleKit(kind).build(materials());
  handle.position.set(pose.handle.x, pose.handle.y, pose.handle.z);
  handle.rotation.set(pose.handleTilt, pose.handleYaw, 0, 'YXZ');
  g.add(holster, handle);
  return g;
}

const docks: Array<{ ports: WallBoxPorts; side: -1 | 1 }> = [
  { ports: 1, side: -1 },
  { ports: 2, side: -1 },
  { ports: 2, side: 1 },
];

describe('wall box dock (2010 ADA 307.2 and 308)', () => {
  it('keeps the box bottom under 27 in', () => {
    expect(WALL_BOX_BOTTOM_M).toBe(0.68);
    expect(WALL_BOX_ADA.walkingSurfaceM).toBe(SURFACE_M.sidewalk);
    expect(WALL_BOX_ADA.leadingEdgeMaxM - SURFACE_M.sidewalk).toBeCloseTo(0.685, 9);
    expect(WALL_BOX_BOTTOM_M).toBeLessThanOrEqual(WALL_BOX_ADA.leadingEdgeMaxM);
    expect(WALL_BOX_ADA.protrusionMaxM).toBeLessThanOrEqual(4 * 0.0254);
  });

  it('docks every AC connector angled down along the face, no part above 27 in more than 4 in proud of the box', () => {
    const limit = WALL_BOX_ADA.edgeZ + WALL_BOX_ADA.protrusionMaxM;
    for (const kind of AC_KINDS) {
      for (const { ports, side } of docks) {
        const label = `${kind} ${String(ports)} ${String(side)}`;
        const pts = vertices(dockedConnector(kind, ports, side));
        const above = pts.filter((p) => p.y > WALL_BOX_ADA.leadingEdgeMaxM);
        expect(above.length, label).toBeGreaterThan(0);
        expect(Math.max(...above.map((p) => p.z)), label).toBeLessThanOrEqual(limit);
        // The handle stays in front of the wall, its grip within the reach range.
        expect(Math.min(...pts.map((p) => p.z)), label).toBeGreaterThan(0);
        expect(Math.min(...pts.map((p) => p.y)), label).toBeGreaterThanOrEqual(REACH.min);
        expect(Math.max(...pts.map((p) => p.y)), label).toBeLessThanOrEqual(REACH.max);
      }
    }
  });

  it('keeps the dock inside the reach range and its handle clear of the status ring', () => {
    for (const { ports, side } of docks) {
      const dock = wallBoxDock(WALL_BOX_BOTTOM_M, ports, side);
      expect(dock.y).toBeGreaterThanOrEqual(REACH.min);
      expect(dock.y).toBeLessThanOrEqual(REACH.max);
      const ringFrom =
        ports === 2 ? AC_WALL_BOX.dual.ringFromBottomM : AC_WALL_BOX.ring.centerFromBottomM;
      const ringBottom = WALL_BOX_BOTTOM_M + ringFrom - AC_WALL_BOX.ring.radiusM;
      for (const kind of AC_KINDS) {
        const top = Math.max(...vertices(dockedConnector(kind, ports, side)).map((p) => p.y));
        expect(top, `${kind} ${String(ports)}`).toBeLessThan(ringBottom);
      }
    }
  });

  it('holds the whole idle wall box, its hooks and coils, to the limit above 27 in', () => {
    const w = wallBoxOffset();
    for (const model of ['wall-box', 'wall-box-dual'] as const) {
      const built = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      const above = vertices(built.group).filter((p) => p.y > WALL_BOX_ADA.leadingEdgeMaxM);
      expect(Math.max(...above.map((p) => p.z - w)), model).toBeLessThanOrEqual(
        WALL_BOX_ADA.edgeZ + WALL_BOX_ADA.protrusionMaxM,
      );
      built.dispose();
    }
  });
});
