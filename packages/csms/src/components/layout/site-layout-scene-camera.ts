// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Camera framing, zoom limits, fog and the screen points of labels in the 3D site scene.

import * as THREE from 'three';
import {
  FRONT_CAMERA_OFFSET,
  NARROW_STAGE_PX,
  OVERVIEW_CAMERA_OFFSET,
  denseFrameBox,
  fitFrame,
  fogRange,
  frontCamera,
  maxZoomDistance,
  pixelsPerMeter,
  rotateBox,
  type Box,
} from './site-layout-grid';

import type { SceneSlice } from './site-layout-scene-context';
import { VIRTUAL_SIGN_WIDTH_M, type ScreenPoint } from './site-layout-scene-types';

type CameraCtx = SceneSlice<
  | 'camera'
  | 'container'
  | 'controls'
  | 'energyLabels'
  | 'fog'
  | 'frameBox'
  | 'layout'
  | 'linkLabels'
  | 'lotBox'
  | 'objects'
  | 'options'
  | 'poseOf'
  | 'renderer'
  | 'site'
  | 'siteBox'
  | 'transformerObjects'
  | 'virtualSprites',
  | 'applyZoomLimit'
  | 'avatarPoint'
  | 'energyLabelPoint'
  | 'fit'
  | 'focusStation'
  | 'labelPoint'
  | 'lastFitDense'
  | 'linkLabelPoint'
  | 'resize'
  | 'transformerLabelPoint'
  | 'updateFog'
  | 'virtualSignPoint'
>;

export function installCamera(scn: CameraCtx): void {
  // `toggle`: an explicit Fit to View; on a narrow stage it alternates the
  // densest part and the whole site. Otherwise a narrow stage frames the
  // densest part of a wide site (denseFrameBox) and a wide stage the whole.
  function fit(toggle = false): void {
    const width = scn.container.clientWidth || 1;
    const height = scn.container.clientHeight || 1;
    applyZoomLimit();
    const narrow = scn.container.clientWidth > 0 && width < NARROW_STAGE_PX;
    const wantDense = narrow && !(toggle && scn.lastFitDense);
    const points = scn.layout.stations.map((s) => scn.poseOf(s).point);
    const framed = (box: Box): Box => (wantDense ? denseFrameBox(box, points, width) : box);
    const viewBox = scn.options.view === 'front' ? scn.lotBox : scn.siteBox;
    scn.lastFitDense = wantDense && framed(viewBox) !== viewBox;
    // The front camera, and the overview of an office or retail site (the
    // building stays behind the lot), turn with the facing.
    if (scn.options.view === 'front' || scn.layout.lot.siteType === 'office_retail') {
      const front = frontCamera(
        framed(viewBox),
        scn.layout.lot.facing,
        width / height,
        scn.options.view === 'front' ? FRONT_CAMERA_OFFSET : OVERVIEW_CAMERA_OFFSET,
      );
      scn.controls.target.set(front.target.x, front.target.y, front.target.z);
      scn.camera.position.set(front.position.x, front.position.y, front.position.z);
    } else {
      const { target, distance } = fitFrame(
        rotateBox(framed(scn.siteBox), scn.layout.lot.facing),
        width / height,
      );
      scn.controls.target.set(target.x, target.y, target.z);
      scn.camera.position.set(
        target.x + distance * 0.22,
        distance * 0.62,
        target.z - 0.6 + distance * 0.86,
      );
    }
    scn.controls.update();
    updateFog();
  }
  scn.fit = fit;

  // The zoom-out limit and the far plane follow the site, so a large site can
  // be seen whole and the fogged ground never ends inside the view.
  function applyZoomLimit(): void {
    scn.controls.maxDistance = maxZoomDistance(scn.frameBox);
    scn.camera.far = fogRange(scn.controls.maxDistance).far + 100;
    scn.camera.updateProjectionMatrix();
  }
  scn.applyZoomLimit = applyZoomLimit;

  function updateFog(): void {
    const range = fogRange(scn.camera.position.distanceTo(scn.controls.target));
    scn.fog.near = range.near;
    scn.fog.far = range.far;
  }
  scn.updateFog = updateFog;

  function resize(): void {
    const width = scn.container.clientWidth || 1;
    const height = scn.container.clientHeight || 1;
    scn.renderer.setSize(width, height, false);
    scn.camera.aspect = width / height;
    scn.camera.updateProjectionMatrix();
  }
  scn.resize = resize;

  function project(v: THREE.Vector3): ScreenPoint {
    const distance = v.distanceTo(scn.camera.position);
    v.project(scn.camera);
    return {
      x: (v.x * 0.5 + 0.5) * scn.container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * scn.container.clientHeight,
      depth: v.z,
      distance,
      pxPerMeter: pixelsPerMeter(distance, scn.camera.fov, scn.container.clientHeight),
      visible: v.z < 1,
    };
  }

  function labelPoint(stationId: string): ScreenPoint | null {
    const obj = scn.objects.get(stationId);
    if (obj == null) return null;
    // The label point in the station's own frame (a wall box hangs behind its spot).
    const v = new THREE.Vector3(0, obj.top + 0.45, obj.labelZ);
    obj.group.localToWorld(v);
    return project(v);
  }
  scn.labelPoint = labelPoint;

  function avatarPoint(stationId: string): ScreenPoint | null {
    const obj = scn.objects.get(stationId);
    if (obj == null) return null;
    // Above the car roof while charging (the car parks nose to the charger), else above the charger.
    const v =
      obj.avatarAnchor != null
        ? obj.avatarAnchor.clone()
        : new THREE.Vector3(0, obj.top + 1.1, obj.labelZ);
    obj.group.localToWorld(v);
    return project(v);
  }
  scn.avatarPoint = avatarPoint;

  function virtualSignPoint(stationId: string): ScreenPoint | null {
    const sprite = scn.virtualSprites.get(stationId);
    if (sprite == null) return null;
    const v = new THREE.Vector3(0, (VIRTUAL_SIGN_WIDTH_M * 176) / 512 / 2 + 0.1, 0);
    sprite.localToWorld(v);
    return project(v);
  }
  scn.virtualSignPoint = virtualSignPoint;

  function focusStation(stationId: string): void {
    const obj = scn.objects.get(stationId);
    if (obj == null) return;
    const p = new THREE.Vector3(0, 0.8, 0);
    obj.group.localToWorld(p);
    const shift = p.sub(scn.controls.target);
    scn.controls.target.add(shift);
    scn.camera.position.add(shift);
    scn.controls.update();
    updateFog();
  }
  scn.focusStation = focusStation;

  function transformerLabelPoint(id: string): ScreenPoint | null {
    const g = scn.transformerObjects.get(id);
    if (g == null) return null;
    const v = g.position.clone();
    v.y = 2.3;
    return project(scn.site.localToWorld(v));
  }
  scn.transformerLabelPoint = transformerLabelPoint;

  function energyLabelPoint(id: string): ScreenPoint | null {
    const p = scn.energyLabels.get(id);
    return p == null ? null : project(scn.site.localToWorld(p.clone()));
  }
  scn.energyLabelPoint = energyLabelPoint;

  function linkLabelPoint(id: string): ScreenPoint | null {
    const p = scn.linkLabels.get(id);
    return p == null ? null : project(scn.site.localToWorld(p.clone()));
  }
  scn.linkLabelPoint = linkLabelPoint;
}
