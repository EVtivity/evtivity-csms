// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Load management cable runs of the 3D site scene and their live flow.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import { linkPolyline, linkTubeGeometry, polylineLength } from './site-layout-link-curve';
import type { LinkKind } from './site-layout-links';

import type { SceneCtx } from './site-layout-scene-context';
import { type LinkMeshes } from './site-layout-scene-types';

export function installLinks(scn: SceneCtx): void {
  // A glowing cable run on the ground along an orthogonal path of lot
  // points: a thin bright core with a moving pulse and a wide faint halo.
  // Links never take clicks or drags.
  function buildLink(
    points: readonly THREE.Vector3[],
    kind: LinkKind,
    id: string,
    flowId: string,
  ): THREE.Group {
    const g = new THREE.Group();
    // Each turn a short-radius bend of the same tube, core and halo alike (site-layout-link-curve.ts).
    const line = linkPolyline(points);
    if (line.length < 2) return g;
    // The first turn of the run, for close-up renders of a bend.
    const turn = points.find((p, i) => {
      const a = points[i - 1];
      const b = points[i + 1];
      return (
        a != null &&
        b != null &&
        p.clone().sub(a).normalize().dot(b.clone().sub(p).normalize()) < 0.99
      );
    });
    if (turn != null) g.userData['linkTurn'] = turn.clone();
    const length = polylineLength(line);
    const color = kind === 'station' ? SCENE_COLORS.linkStation : SCENE_COLORS.linkFeeder;
    const flow = scn.flowTexture();
    flow.repeat.set(Math.max(1, length / 3), 1);
    scn.flowTextures.push(flow);
    const core = new THREE.Mesh(
      scn.track(linkTubeGeometry(line, kind === 'station' ? 0.035 : 0.05)),
      scn.track(
        new THREE.MeshBasicMaterial({
          color,
          map: flow,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    const halo = new THREE.Mesh(
      scn.track(linkTubeGeometry(line, kind === 'station' ? 0.1 : 0.14)),
      scn.track(
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    for (const m of [core, halo]) {
      m.raycast = () => undefined;
      m.renderOrder = 2;
    }
    g.add(halo, core);
    const radius = kind === 'station' ? 0.035 : 0.05;
    const entry: LinkMeshes = { core, halo, line, radius, kind, flowId, step: -1 };
    scn.linkMeshes.set(id, entry);
    styleLink(entry, scn.linkFlow.get(flowId) ?? null);
    return g;
  }
  scn.buildLink = buildLink;

  // The live flow of a link: brightness and thickness grow with the power.
  // Without load data (null) the link keeps its plain look. Thickness changes
  // in steps of a tenth, so a small change rebuilds no geometry.
  function styleLink(entry: LinkMeshes, flow: number | null): void {
    const step = flow == null ? -1 : Math.round(Math.min(1, Math.max(0, flow)) * 10);
    if (step === entry.step) return;
    entry.step = step;
    const level = step < 0 ? 0.5 : step / 10;
    const base = entry.kind === 'station' ? 0.035 : 0.05;
    const haloBase = entry.kind === 'station' ? 0.1 : 0.14;
    const scale = 0.6 + level * 1.1;
    // Dimmer than a charging cable's flow (owner request 2026-11-02), so the eye goes to the cables.
    entry.core.material.opacity = step < 0 ? 0.5 : 0.2 + 0.4 * level;
    entry.halo.material.opacity = step < 0 ? 0.08 : 0.03 + 0.15 * level;
    if (step < 0 && entry.radius === base) return;
    entry.radius = step < 0 ? base : base * scale;
    const core = linkTubeGeometry(entry.line, entry.radius);
    const halo = linkTubeGeometry(entry.line, step < 0 ? haloBase : haloBase * scale);
    entry.core.geometry.dispose();
    entry.halo.geometry.dispose();
    entry.core.geometry = scn.track(core);
    entry.halo.geometry = scn.track(halo);
  }
  scn.styleLink = styleLink;
}
