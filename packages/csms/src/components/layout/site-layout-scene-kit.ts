// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Scene-life model kits and the per-rebuild materials and meshes of the 3D site scene.

import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import * as THREE from 'three';
import { type CarPort } from './site-layout-cable';
import type { CarKit } from './site-layout-car-geometry';
import type { ChargerKit } from './site-layout-model-charger-parts';
import type { ModelKit } from './site-layout-model-kit';
import { createVehicleKit } from './site-layout-vehicle-kit';

import type { SceneCtx } from './site-layout-scene-context';
import { type Disposable } from './site-layout-scene-types';

export function installKit(scn: SceneCtx): void {
  // The car geometries of each body type (site-layout-car-geometry.ts), built
  // on first use and shared by every car of the type for the scene's life.
  const carKits = new Map<string, CarKit>();
  scn.carKits = carKits;
  function carKit(bodyType: VehicleBodyType, port: CarPort = 'front_left'): CarKit {
    const key = `${bodyType}:${port}`;
    let kit = carKits.get(key);
    if (kit == null) {
      kit = createVehicleKit(bodyType, port);
      carKits.set(key, kit);
    }
    return kit;
  }
  scn.carKit = carKit;

  // Everything built per rebuild, disposed on the next one.
  scn.built = [];
  const track = <T extends Disposable>(item: T): T => {
    scn.built.push(item);
    return item;
  };
  scn.track = track;
  const M = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    track(new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...extra }));
  scn.M = M;
  const shadowed = <T extends THREE.Mesh>(mesh: T): T => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  scn.shadowed = shadowed;
  const box = (w: number, h: number, d: number, material: THREE.Material | THREE.Material[]) =>
    shadowed(new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), material));
  scn.box = box;
  const cylinder = (r: number, h: number, segments: number, material: THREE.Material) =>
    shadowed(new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, h, segments)), material));
  scn.cylinder = cylinder;
  // A prism with rounded vertical edges: footprint w by d, height h, standing on y = 0.
  function roundedPrism(w: number, d: number, h: number, r: number, material: THREE.Material) {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -d / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + d - r);
    s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    s.lineTo(x + r, y + d);
    s.quadraticCurveTo(x, y + d, x, y + d - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    const g = track(
      new THREE.ExtrudeGeometry(s, {
        depth: h,
        bevelEnabled: true,
        bevelThickness: 0.015,
        bevelSize: 0.015,
        bevelSegments: 2,
        curveSegments: 6,
      }),
    );
    g.rotateX(-Math.PI / 2);
    return shadowed(new THREE.Mesh(g, material));
  }
  scn.roundedPrism = roundedPrism;
  // The charger body geometries of each model and variant
  // (site-layout-model-*.ts), built on first use for the scene's life.
  const modelKits = new Map<string, ModelKit<string>>();
  scn.modelKits = modelKits;
  function modelKit<S extends string>(key: string, make: () => ModelKit<S>): ModelKit<S> {
    let kit = modelKits.get(key) as ModelKit<S> | undefined;
    if (kit == null) {
      kit = make();
      modelKits.set(key, kit);
    }
    return kit;
  }
  scn.modelKit = modelKit;
  const chargerKit = (key: string, make: () => ChargerKit): ChargerKit => modelKit(key, make);
  scn.chargerKit = chargerKit;

  // A kit model tagged with its name (close-up renders and tests find it by `userData.model`).
  function modelOf<S extends string>(
    kit: ModelKit<S>,
    model: string,
    materials: Readonly<Record<S, THREE.Material>>,
  ): THREE.Group {
    const group = kit.build(materials);
    group.userData['model'] = model;
    return group;
  }
  scn.modelOf = modelOf;
  // An empty point marking a feature of a model (a cable coil), for close-up renders.
  function marker(feature: string, at: [number, number, number]): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(...at);
    o.userData['feature'] = feature;
    return o;
  }
  scn.marker = marker;
}
