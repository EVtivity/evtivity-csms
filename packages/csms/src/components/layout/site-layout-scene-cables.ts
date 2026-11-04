// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Cable tubes of the 3D site scene: idle cables, charging cables with their charge flow, cable hangers.

import * as THREE from 'three';
import {
  CHARGE_FLOW,
  CHARGE_FLOW_STOPS,
  chargeFlowCoreRadius,
  chargeFlowHaloRadius,
  chargeFlowRepeat,
} from './site-layout-cable';
import { liftOntoSurface } from './site-layout-cable-surface';
import { SCENE_COLORS } from './site-layout-colors';
import { createCableHangerKit, type CableHangerSpec } from './site-layout-model-cable-hanger';

import type { SceneSlice } from './site-layout-scene-context';
import { tubeSegments } from './site-layout-scene-station-slots';

type CablesCtx = SceneSlice<
  'M' | 'cableGround' | 'chargeFlowTextures' | 'modelKit' | 'modelOf' | 'shadowed' | 'track',
  'cable' | 'cableHanger' | 'chargeContactGlow' | 'chargeFlowPath' | 'chargingCable'
>;

export function installCables(scn: CablesCtx): void {
  // A cable hanger (site-layout-model-cable-hanger.ts) with its mounting face
  // through `at`, turned `turnY` about y (0: the face is z = at.z, the hanger out along +z).
  function cableHanger(
    spec: CableHangerSpec,
    at: readonly [number, number, number],
    turnY: number,
    rubber: THREE.Material,
  ): THREE.Group {
    const kit = scn.modelKit(`cable-hanger:${JSON.stringify(spec)}`, () =>
      createCableHangerKit(spec),
    );
    const g = scn.modelOf(kit, 'cable-hanger', {
      // Powder coated steel, the gray of the charger metal parts.
      body: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.55, metalness: 0.3 }),
      metal: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
      rubber,
    });
    g.position.set(...at);
    g.rotation.y = turnY;
    return g;
  }
  scn.cableHanger = cableHanger;
  function cable(
    points: Array<[number, number, number]>,
    material: THREE.Material,
    radius = 0.022,
  ) {
    const rested =
      scn.cableGround != null ? liftOntoSurface(points, scn.cableGround, radius) : points;
    const curve = new THREE.CatmullRomCurve3(rested.map((p) => new THREE.Vector3(...p)));
    return scn.shadowed(
      new THREE.Mesh(
        scn.track(new THREE.TubeGeometry(curve, tubeSegments(points.length), radius, 8, false)),
        material,
      ),
    );
  }
  scn.cable = cable;
  // Bright pulses with soft ends, repeated along a charging cable.
  function chargeFlowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const g = ctx.createLinearGradient(0, 0, 64, 0);
      for (const [at, alpha] of CHARGE_FLOW_STOPS) {
        g.addColorStop(at, `rgba(255,255,255,${String(alpha)})`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 4);
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
  // The flowing light along a path (`CHARGE_FLOW`): a bright core, unlit so it reads in the
  // shade, and a soft halo, both moving toward the vehicle in the frame loop.
  function chargeFlowPath(points: Array<[number, number, number]>, radius = 0.022): THREE.Group {
    const g = new THREE.Group();
    const rested =
      scn.cableGround != null ? liftOntoSurface(points, scn.cableGround, radius) : points;
    const curve = new THREE.CatmullRomCurve3(rested.map((p) => new THREE.Vector3(...p)));
    const texture = chargeFlowTexture();
    texture.repeat.set(chargeFlowRepeat(curve.getLength()), 1);
    scn.chargeFlowTextures.push(texture);
    const segments = tubeSegments(points.length);
    const flow = new THREE.Mesh(
      scn.track(new THREE.TubeGeometry(curve, segments, chargeFlowCoreRadius(radius), 8, false)),
      scn.track(
        new THREE.MeshBasicMaterial({
          color: CHARGE_FLOW.coreColor,
          map: texture,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    );
    const halo = new THREE.Mesh(
      scn.track(new THREE.TubeGeometry(curve, segments, chargeFlowHaloRadius(radius), 8, false)),
      scn.track(
        new THREE.MeshBasicMaterial({
          color: CHARGE_FLOW.color,
          map: texture,
          transparent: true,
          opacity: CHARGE_FLOW.haloOpacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      ),
    );
    for (const m of [halo, flow]) {
      m.raycast = () => undefined;
      m.renderOrder = 2;
      m.userData['chargeFlow'] = true;
      g.add(m);
    }
    return g;
  }
  scn.chargeFlowPath = chargeFlowPath;
  // A charging cable: the cable, and while it carries energy a green light
  // around it that flows from the charger toward the vehicle (`CHARGE_FLOW`).
  function chargingCable(
    points: Array<[number, number, number]>,
    material: THREE.Material,
    radius = 0.022,
    flowing = true,
  ): THREE.Group {
    const g = new THREE.Group();
    g.add(cable(points, material, radius));
    if (flowing) g.add(chargeFlowPath(points, radius));
    return g;
  }
  // The contact glow of a charging pantograph: a flat, soft disc in the charging color,
  // additive and unlit, steady (it does not animate, so reduced motion changes nothing).
  function chargeContactGlow(at: readonly [number, number, number], radiusM: number): THREE.Mesh {
    const glow = new THREE.Mesh(
      scn.track(new THREE.SphereGeometry(1, 24, 12)),
      scn.track(
        new THREE.MeshBasicMaterial({
          color: CHARGE_FLOW.color,
          transparent: true,
          opacity: CHARGE_FLOW.haloOpacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      ),
    );
    glow.scale.set(radiusM, 0.06, radiusM);
    glow.position.set(at[0], at[1], at[2]);
    glow.raycast = () => undefined;
    glow.renderOrder = 2;
    glow.userData['chargeContact'] = true;
    return glow;
  }
  scn.chargeContactGlow = chargeContactGlow;
  scn.chargingCable = chargingCable;
}
