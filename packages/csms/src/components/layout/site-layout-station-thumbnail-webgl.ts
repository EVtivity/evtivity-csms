// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The offscreen WebGL renderer of the 2D card station pictures. Loaded only
// through `import()` (it pulls in three.js and the model kits); it builds the
// idle charger the 3D scene draws (`buildIdleChargerModel`: the body, its
// holsters with seated handles, each idle cable looped over its hanger, the
// MCS arm stowed), lights it like the 3D view (a prefiltered room environment,
// a sky light and a sun), frames it from the front three-quarter view and
// reads the frame back as a PNG data URL.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildIdleChargerModel } from './site-layout-scene-charger-model';
import { webglAvailable } from '@/lib/webgl';
import {
  THUMBNAIL_PIXEL_RATIO,
  THUMBNAIL_SIZE,
  type ThumbnailRenderer,
  type ThumbnailRequest,
} from './site-layout-station-thumbnail';

// Moves the camera along its view direction until the model's box fills `fill` of the frame
// height (every model at one height, so the cards read at one scale), or its width when wider.
function frame(camera: THREE.PerspectiveCamera, box: THREE.Box3, fill: number): void {
  const center = box.getCenter(new THREE.Vector3());
  const dir = new THREE.Vector3(0.62, 0.32, 1).normalize();
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  let distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) =>
      new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ),
  );
  for (let pass = 0; pass < 3; pass++) {
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    let ex = 0;
    let ey = 0;
    for (const c of corners) {
      const p = c.clone().project(camera);
      ex = Math.max(ex, Math.abs(p.x));
      ey = Math.max(ey, Math.abs(p.y));
    }
    if (ex <= 0 || ey <= 0) break;
    distance *= Math.max(ey / fill, ex / 0.98);
  }
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.lookAt(center);
  camera.near = Math.max(0.01, distance - radius * 2);
  camera.far = distance + radius * 2;
  camera.updateProjectionMatrix();
}

/** The shared renderer, or null without WebGL. */
export function createWebGlThumbnailRenderer(): ThumbnailRenderer | null {
  if (!webglAvailable()) return null;
  const canvas = document.createElement('canvas');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
  } catch (err: unknown) {
    console.warn('No WebGL context for the station thumbnails', err);
    return null;
  }
  const width = THUMBNAIL_SIZE.width * THUMBNAIL_PIXEL_RATIO;
  const height = THUMBNAIL_SIZE.height * THUMBNAIL_PIXEL_RATIO;
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();

  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(22, width / height, 0.01, 100);

  return {
    render(request: ThumbnailRequest): string {
      const charger = buildIdleChargerModel(request.model, {
        plateColor: request.plateColor,
        dark: request.dark,
      });
      try {
        scene.environmentIntensity = request.dark ? 0.25 : 0.6;
        scene.add(charger.group);
        frame(camera, new THREE.Box3().setFromObject(charger.group), 0.97);
        renderer.render(scene, camera);
        return canvas.toDataURL('image/png');
      } finally {
        scene.remove(charger.group);
        charger.dispose();
      }
    },
    dispose(): void {
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
