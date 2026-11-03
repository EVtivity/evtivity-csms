// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sceneSource } from './helpers/scene-source';
import { createConnectorHandleKit } from '../site-layout-connector-geometry';
import {
  CABLE_LEAD_M,
  CONNECTOR_SPECS,
  bootTipLocal,
  cableIntoHandle,
  gripAxis,
  handleCableEntry,
  holsterPose,
  plugYaw,
  type ConnectorKind,
} from '../site-layout-connectors';

const KINDS = Object.keys(CONNECTOR_SPECS) as ConnectorKind[];

/** Every pose a handle takes: seated in holsters facing three ways, plugged into left, right and nose ports. */
function poses(): Array<{ label: string; at: THREE.Vector3; yaw: number }> {
  const out: Array<{ label: string; at: THREE.Vector3; yaw: number }> = [];
  for (const facing of [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
  ]) {
    const pose = holsterPose({ x: 0.4, y: 1.1, z: 0.1 }, facing);
    out.push({
      label: `holstered ${String(facing.x)},${String(facing.z)}`,
      at: new THREE.Vector3(pose.handle.x, pose.handle.y, pose.handle.z),
      yaw: pose.handleYaw,
    });
  }
  const plugged: Array<[string, { x: number; y: number; z: number }, boolean]> = [
    ['plugged left', { x: -0.9, y: 0.8, z: 1.2 }, false],
    ['plugged right', { x: 0.9, y: 0.8, z: 1.2 }, false],
    ['plugged nose', { x: 0, y: 0.7, z: 0.2 }, true],
  ];
  for (const [label, port, nose] of plugged) {
    out.push({ label, at: new THREE.Vector3(port.x, port.y, port.z), yaw: plugYaw(port, 0, nose) });
  }
  return out;
}

describe('connector cable entry', () => {
  it('runs every cable into its handle through the boot, with no gap (holstered and plugged)', () => {
    const m = new THREE.MeshBasicMaterial();
    for (const kind of KINDS) {
      const spec = CONNECTOR_SPECS[kind];
      const kit = createConnectorHandleKit(kind);
      const tipLocal = bootTipLocal(kind);
      const { dir } = gripAxis(kind);
      const cableR = spec.cableDiameterM / 2;
      for (const { label, at, yaw } of poses()) {
        const name = `${kind} ${label}`;
        const handle = kit.build({ shell: m, insert: m, contact: m, trim: m, boot: m });
        handle.position.copy(at);
        handle.rotation.y = yaw;
        handle.updateMatrixWorld(true);
        const axis = new THREE.Vector3(Math.sin(yaw) * dir.u, dir.v, Math.cos(yaw) * dir.u);
        const tip = new THREE.Vector3(
          at.x + Math.sin(yaw) * tipLocal.z,
          at.y + tipLocal.y,
          at.z + Math.cos(yaw) * tipLocal.z,
        );
        // The boot ends at the tip, and its opening there hugs the cable.
        const boot = handle.children.find((c) => c.name === 'boot') as THREE.Mesh;
        const pos = boot.geometry.getAttribute('position');
        let reach = -Infinity;
        let tipRadius = 0;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i += 1) {
          v.fromBufferAttribute(pos, i).applyMatrix4(boot.matrixWorld);
          const along = v.clone().sub(tip).dot(axis);
          reach = Math.max(reach, along);
          if (Math.abs(along) < 0.002) {
            const radial = v.clone().sub(tip).sub(axis.clone().multiplyScalar(along)).length();
            tipRadius = Math.max(tipRadius, radial);
          }
        }
        expect(Math.abs(reach), `${name}: boot tip`).toBeLessThan(0.003);
        expect(tipRadius - cableR, `${name}: boot opening around the cable`).toBeLessThan(0.003);
        expect(tipRadius, `${name}: the cable fills the boot opening`).toBeGreaterThan(
          cableR * 0.9,
        );
        // The cable ends inside the boot on its axis and reaches it straight along the axis.
        const entry = handleCableEntry(at, yaw, kind);
        const end = new THREE.Vector3(...entry.end);
        const lead = new THREE.Vector3(...entry.lead);
        const endAlong = end.clone().sub(tip).dot(axis);
        expect(endAlong, `${name}: cable end inside the boot`).toBeLessThan(-0.003);
        expect(endAlong, `${name}: cable end inside the boot`).toBeGreaterThan(-spec.bootLengthM);
        expect(
          end.clone().sub(tip).sub(axis.clone().multiplyScalar(endAlong)).length(),
          `${name}: cable end on the boot axis`,
        ).toBeLessThan(0.001);
        expect(lead.clone().sub(tip).dot(axis), `${name}: lead`).toBeCloseTo(CABLE_LEAD_M, 6);
        expect(lead.clone().sub(end).normalize().dot(axis), `${name}: straight in`).toBeGreaterThan(
          0.9999,
        );
        const route = cableIntoHandle(
          [
            [0, 1, 0],
            [0, 0.2, 0.5],
            [9, 9, 9],
          ],
          entry,
        );
        expect(route.slice(-2), name).toEqual([entry.lead, entry.end]);
      }
    }
  });

  it('routes every scene cable that meets a handle through its cable entry', () => {
    // No cable ends at a bare grip point any more: each takes the lead and the end of its entry.
    expect(sceneSource).not.toMatch(/plugCableEnd\(/);
    expect(sceneSource.match(/handleCableEntry\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(sceneSource.match(/\.lead\b/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});
