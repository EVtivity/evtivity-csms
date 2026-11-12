// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Camera framing, zoom limits, fog and the screen points of labels in the 3D site scene.

import { unitPlateAnchor } from './site-layout-scene-unit-plates';
import { evsePlateAnchor } from './site-layout-scene-evse-plates';
import * as THREE from 'three';
import {
  FRONT_CAMERA_OFFSET,
  NARROW_STAGE_PX,
  OVERVIEW_CAMERA_OFFSET,
  denseFrameBox,
  clampTarget,
  fitFrame,
  cameraNearM,
  fogRange,
  frontCamera,
  maxZoomDistance,
  pixelsPerMeter,
  rotateBox,
  type Box,
} from './site-layout-grid';

import {
  FOCUS_EASE_MS,
  MAX_TARGET_Y,
  cameraEaseAt,
  focusDistance,
  type CameraEase,
} from './site-layout-camera-nav';
import type { OrbitState } from './site-layout-keyboard-nav';
import type { SceneSlice } from './site-layout-scene-context';
import { VIRTUAL_SIGN_WIDTH_M, type ScreenPoint } from './site-layout-scene-types';

type CameraCtx = SceneSlice<
  | 'built'
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
  | 'pan'
  | 'poseOf'
  | 'renderer'
  | 'site'
  | 'siteBox'
  | 'transformerObjects'
  | 'virtualSprites',
  | 'applyZoomLimit'
  | 'avatarPoint'
  | 'cancelCameraEase'
  | 'focusAt'
  | 'energyLabelPoint'
  | 'fit'
  | 'focusStation'
  | 'labelPoint'
  | 'lastFitDense'
  | 'linkLabelPoint'
  | 'resize'
  | 'stepCameraEase'
  | 'transformerLabelPoint'
  | 'updateFog'
  | 'virtualSignPoint'
  | 'evsePlatePoint'
  | 'unitPlatePoint'
>;

export function installCamera(scn: CameraCtx): void {
  // `toggle`: an explicit Fit to View; on a narrow stage it alternates the
  // densest part and the whole site. Otherwise a narrow stage frames the
  // densest part of a wide site (denseFrameBox) and a wide stage the whole.
  function fit(toggle = false): void {
    ease = null;
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
    const distance = scn.camera.position.distanceTo(scn.controls.target);
    const range = fogRange(distance);
    scn.fog.near = range.near;
    scn.fog.far = range.far;
    // The near plane follows the view distance, so a close-up is never cut.
    const near = cameraNearM(distance);
    if (Math.abs(scn.camera.near - near) > 1e-3) {
      scn.camera.near = near;
      scn.camera.updateProjectionMatrix();
    }
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

  function evsePlatePoint(stationId: string, index: number): ScreenPoint | null {
    const v = evsePlateAnchor(scn, scn.built, stationId, index);
    return v == null ? null : project(v);
  }
  scn.evsePlatePoint = evsePlatePoint;

  function unitPlatePoint(stationId: string): ScreenPoint | null {
    const v = unitPlateAnchor(scn, scn.built, stationId);
    return v == null ? null : project(v);
  }
  scn.unitPlatePoint = unitPlatePoint;

  // A camera move in progress (a double click, a station picked from the
  // list or Enter on its marker): eased over FOCUS_EASE_MS in the frame loop,
  // at once under reduced motion. Any wheel, drag or key input ends it.
  let ease: CameraEase | null = null;
  const offset = new THREE.Vector3();
  const sph = new THREE.Spherical();
  function orbitNow(): OrbitState {
    offset.subVectors(scn.camera.position, scn.controls.target);
    sph.setFromVector3(offset);
    const t = scn.controls.target;
    return {
      target: { x: t.x, y: t.y, z: t.z },
      azimuth: sph.theta,
      polar: sph.phi,
      distance: sph.radius,
    };
  }
  function applyOrbit(o: OrbitState): void {
    scn.controls.target.set(o.target.x, o.target.y, o.target.z);
    sph.set(o.distance, o.polar, o.azimuth);
    scn.camera.position.copy(scn.controls.target).add(offset.setFromSpherical(sph));
    scn.controls.update();
    updateFog();
  }
  function moveTo(to: OrbitState): void {
    if (scn.options.reducedMotion) {
      ease = null;
      applyOrbit(to);
      return;
    }
    ease = { from: orbitNow(), to, startMs: performance.now(), durationMs: FOCUS_EASE_MS };
  }
  /** One frame of the camera move; true while it runs. */
  function stepCameraEase(nowMs: number): boolean {
    if (ease == null) return false;
    const { state, done } = cameraEaseAt(ease, nowMs);
    applyOrbit(state);
    if (done) ease = null;
    return true;
  }
  scn.stepCameraEase = stepCameraEase;
  scn.cancelCameraEase = () => {
    ease = null;
  };

  /**
   * Makes `point` the orbit center, keeping the camera's angles; `heightM`
   * (the object there) also eases the camera in to frame it (`focusDistance`).
   */
  function focusAt(point: THREE.Vector3, heightM: number | null): void {
    const now = orbitNow();
    const c = clampTarget(point.x, point.z, scn.pan);
    moveTo({
      ...now,
      target: { x: c.x, y: Math.min(MAX_TARGET_Y, Math.max(0, point.y)), z: c.z },
      distance:
        heightM == null ? now.distance : focusDistance(heightM, now.distance, scn.camera.fov),
    });
  }
  scn.focusAt = focusAt;

  function focusStation(stationId: string): void {
    const obj = scn.objects.get(stationId);
    if (obj == null) return;
    const p = new THREE.Vector3(0, 0.8, 0);
    obj.group.localToWorld(p);
    focusAt(p, null);
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
