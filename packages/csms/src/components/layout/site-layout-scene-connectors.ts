// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Connector handles and holsters of the 3D site scene.

import * as THREE from 'three';
import { type Point3 } from './site-layout-cable';
import { SCENE_COLORS } from './site-layout-colors';
import {
  createConnectorHandleKit,
  createConnectorHolsterKit,
  type ConnectorKit,
  type ConnectorMaterials,
} from './site-layout-connector-geometry';
import {
  CONNECTOR_SPECS,
  handleCableEntry,
  holsterPose,
  type CableEntry,
  type ConnectorKind,
} from './site-layout-connectors';
import { cableOutOfGland } from './site-layout-model-cable-gland';

import type { SceneCtx } from './site-layout-scene-context';
import { type Point3Tuple } from './site-layout-scene-types';

export function installConnectors(scn: SceneCtx): void {
  // The connector handle and holster geometries of each type
  // (site-layout-connector-geometry.ts), built on first use and shared for
  // the scene's life; the materials are per rebuild.
  const connectorKits = new Map<string, ConnectorKit>();
  scn.connectorKits = connectorKits;
  function connectorKit(kind: ConnectorKind, part: 'handle' | 'holster'): ConnectorKit {
    const key = `${part}:${kind}`;
    let kit = connectorKits.get(key);
    if (kit == null) {
      kit = part === 'handle' ? createConnectorHandleKit(kind) : createConnectorHolsterKit(kind);
      connectorKits.set(key, kit);
    }
    return kit;
  }
  scn.connectorMaterialSet = null;
  function connectorMaterials(): { handle: ConnectorMaterials; holster: ConnectorMaterials } {
    if (scn.connectorMaterialSet != null) return scn.connectorMaterialSet;
    const insert = scn.M(SCENE_COLORS.connectorInsert, { roughness: 0.75, metalness: 0 });
    const contact = scn.M(SCENE_COLORS.connectorContact, { roughness: 0.28, metalness: 0.95 });
    const trim = scn.M(SCENE_COLORS.connectorTrim, { roughness: 0.45, metalness: 0.15 });
    const boot = scn.M(SCENE_COLORS.rubber, { roughness: 0.9, metalness: 0 });
    scn.connectorMaterialSet = {
      handle: {
        shell: scn.M(SCENE_COLORS.connectorShell, { roughness: 0.42, metalness: 0.05 }),
        insert,
        contact,
        trim,
        boot,
      },
      holster: {
        shell: scn.M(SCENE_COLORS.holster, { roughness: 0.55, metalness: 0.05 }),
        insert,
        contact,
        trim,
        boot,
      },
    };
    return scn.connectorMaterialSet;
  }

  // A connector handle of its type: the plug face at the origin facing +z, the
  // grip down and back to where the cable leaves its boot (`plugCableEnd`).
  // Built once per type per rebuild and cloned.
  const handleTemplates = new Map<string, THREE.Group>();
  scn.handleTemplates = handleTemplates;
  function connectorHandle(kind: ConnectorKind): THREE.Group {
    const key = `handle:${kind}`;
    const cached = handleTemplates.get(key);
    if (cached != null) return cached.clone();
    const g = connectorKit(kind, 'handle').build(connectorMaterials().handle);
    g.userData['connector'] = kind;
    handleTemplates.set(key, g);
    return g.clone();
  }
  scn.connectorHandle = connectorHandle;
  function connectorHolster(kind: ConnectorKind): THREE.Group {
    const key = `holster:${kind}`;
    const cached = handleTemplates.get(key);
    if (cached != null) return cached.clone();
    const g = connectorKit(kind, 'holster').build(connectorMaterials().holster);
    handleTemplates.set(key, g);
    return g.clone();
  }
  // A holster on a charger surface at `mount` (its plate against the surface,
  // the cup facing `facing`, a unit vector on the ground plane) with its handle
  // seated nose first, unless the handle is plugged into a vehicle. Returns
  // where the handle's cable leaves its boot, or the cup mouth when empty.
  // The cable of a handle holstered on a side wall: out of its gland along the
  // gland axis, bent down (`cableOutOfGland`), in a loop on the ground and up
  // to the handle's boot at `entry`.
  function sideHolsterCable(
    gland: { at: Point3Tuple; axis: Point3Tuple },
    side: number,
    entry: CableEntry,
    kind: ConnectorKind,
  ): THREE.Mesh {
    const lead = entry.lead;
    const out = cableOutOfGland(
      gland.at,
      gland.axis,
      CONNECTOR_SPECS[kind].cableDiameterM,
      [0, -1, 0],
    ).map((p) => [p[0], p[1], p[2]] as [number, number, number]);
    return scn.cable(
      [
        ...out,
        [lead[0] + side * 0.04, 0.3, lead[2] - 0.04],
        [lead[0] + side * 0.02, 0.14, lead[2] + 0.06],
        [lead[0], Math.min(0.45, lead[1] - 0.15), lead[2] + 0.03],
        lead,
        entry.end,
      ],
      scn.M(SCENE_COLORS.rubber, { roughness: 0.9 }),
      CONNECTOR_SPECS[kind].cableDiameterM / 2,
    );
  }
  scn.sideHolsterCable = sideHolsterCable;
  function holsteredConnector(
    parent: THREE.Object3D,
    kind: ConnectorKind,
    mount: Point3,
    facing: { x: number; z: number },
    plugged: boolean,
  ): CableEntry {
    const pose = holsterPose(mount, facing);
    const holster = connectorHolster(kind);
    holster.position.set(pose.mouth.x, pose.mouth.y, pose.mouth.z);
    holster.rotation.y = pose.holsterYaw;
    parent.add(holster);
    const entry = handleCableEntry(pose.handle, pose.handleYaw, kind);
    if (plugged) return entry;
    const h = connectorHandle(kind);
    h.position.set(pose.handle.x, pose.handle.y, pose.handle.z);
    h.rotation.y = pose.handleYaw;
    parent.add(h);
    return entry;
  }
  scn.holsteredConnector = holsteredConnector;
}
