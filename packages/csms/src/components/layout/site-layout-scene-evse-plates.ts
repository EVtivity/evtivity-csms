// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The EVSE number plates of the 3D site scene (site-layout-model-evse-plate.ts):
// the plate, its number and its own status light in the EVSE's state color,
// kept per station for the hover label (`evse:<stationId>:<index>`) and the
// light's pulse or blink. The plates stay out of the station merge, so they
// can be picked and their lights animate.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import {
  EVSE_DIGIT_CANVAS,
  EVSE_PLATE,
  createEvsePlateKit,
  drawEvseDigit,
  evseDigitZ,
  evsePlateLightGeometry,
  type EvsePlateMount,
} from './site-layout-model-evse-plate';
import type { SceneSlice } from './site-layout-scene-context';
import type { SceneStation } from './site-layout-scene-types';
import { SIGN_FONT_FAMILY } from './site-layout-signs';

type PlatesCtx = SceneSlice<
  'M' | 'built' | 'modelKit' | 'modelOf' | 'track',
  'addEvsePlate' | 'addEvsePortLight'
>;

/** One plate of a station, kept for hover picking and its light. */
export interface EvsePlateEntry {
  station: SceneStation;
  index: number;
  plate: THREE.Object3D;
  light: THREE.MeshStandardMaterial;
  built: unknown;
}

const platesByScene = new WeakMap<object, Map<string, EvsePlateEntry[]>>();

/** The plates of `stationId` from the current build (`built`) of the scene. */
function livePlates(scn: object, stationId: string, built: unknown): EvsePlateEntry[] {
  return (platesByScene.get(scn)?.get(stationId) ?? []).filter((e) => e.built === built);
}

const EVSE_HOVER_PREFIX = 'evse:';

/** The hover key of an EVSE plate (`onEquipmentHover`): `evse:<stationId>:<index>`, EVSE order. */
export function evsePlateHoverKey(stationId: string, index: number): string {
  return `${EVSE_HOVER_PREFIX}${stationId}:${String(index)}`;
}

/** The plate a hover key names, or null for any other key. */
export function parseEvsePlateHoverKey(
  key: string | null,
): { stationId: string; index: number } | null {
  if (key?.startsWith(EVSE_HOVER_PREFIX) !== true) return null;
  const rest = key.slice(EVSE_HOVER_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) return null;
  const index = Number(rest.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { stationId: rest.slice(0, at), index };
}

/**
 * The hover key of the EVSE plate of `stationId` the ray meets first, or null
 * when the ray meets another part of the station first or no plate of it.
 */
export function pickEvsePlate(
  scn: SceneSlice<'objects'>,
  built: unknown,
  ray: THREE.Raycaster,
  stationId: string,
): string | null {
  const obj = scn.objects.get(stationId);
  if (obj == null) return null;
  const live = livePlates(scn, stationId, built).filter((e) => e.station === obj.station);
  if (live.length === 0) return null;
  const hit = ray.intersectObjects(
    live.map((e) => e.plate),
    true,
  )[0];
  if (hit == null) return null;
  const entry = live.find((e) => {
    let o: THREE.Object3D | null = hit.object;
    while (o != null && o !== e.plate) o = o.parent;
    return o === e.plate;
  });
  if (entry == null) return null;
  // Nothing of the station in front of the plate (its body seen from the other side).
  const nearest = ray
    .intersectObject(obj.group, true)
    .find((h) => h.object.type === 'Mesh' && h.object.userData['ring'] !== true);
  if (nearest != null && nearest.distance < hit.distance - 1e-4) return null;
  return evsePlateHoverKey(stationId, entry.index);
}

/** Where the hover label of a plate points: just above the plate, in world space (null: no such plate). */
export function evsePlateAnchor(
  scn: object,
  built: unknown,
  stationId: string,
  index: number,
): THREE.Vector3 | null {
  const entry = livePlates(scn, stationId, built).find((e) => e.index === index);
  if (entry == null) return null;
  return entry.plate.localToWorld(new THREE.Vector3(0, EVSE_PLATE.heightM / 2 + 0.02, 0));
}

/** The EVSE status lights of the scene's current build (the frame loop pulses and blinks them). */
export function evsePlateLights(scn: object, built: unknown): EvsePlateEntry[] {
  const out: EvsePlateEntry[] = [];
  for (const entries of platesByScene.get(scn)?.values() ?? []) {
    for (const e of entries) if (e.built === built) out.push(e);
  }
  return out;
}

export function installEvsePlates(scn: PlatesCtx): void {
  // The number textures of this build, one per number.
  let digits: { built: unknown; byNumber: Map<number, THREE.Material | null> } | null = null;
  function digitMaterial(n: number): THREE.Material | null {
    if (digits?.built !== scn.built) digits = { built: scn.built, byNumber: new Map() };
    const cached = digits.byNumber.get(n);
    if (cached !== undefined) return cached;
    let material: THREE.Material | null = null;
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const ctx = canvas?.getContext('2d') ?? null;
    // fail-open: without a 2D context the plate shows its plain face, no number
    if (canvas != null && ctx != null) {
      canvas.width = EVSE_DIGIT_CANVAS.width;
      canvas.height = EVSE_DIGIT_CANVAS.height;
      drawEvseDigit(ctx, n, SIGN_FONT_FAMILY);
      const texture = scn.track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      material = scn.track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    }
    digits.byNumber.set(n, material);
    return material;
  }

  /**
   * The plate of EVSE `index` (EVSE order) of `s` at `mount` on `g`: its
   * number (`s.evseLamps`, else index + 1) and its status light in the EVSE's
   * state color (else the station's), dark while the station is offline.
   */
  function addEvsePlate(
    g: THREE.Object3D,
    s: SceneStation,
    index: number,
    mount: EvsePlateMount,
  ): { plate: THREE.Group; light: THREE.MeshStandardMaterial } {
    const lamp = s.evseLamps?.[index];
    const number = lamp?.number ?? index + 1;
    const color = lamp?.color ?? s.lightColor;
    const plate = scn.modelOf(scn.modelKit('evse-plate', createEvsePlateKit), 'evse-plate', {
      plate: scn.M(SCENE_COLORS.dark1, { roughness: 0.5, metalness: 0.2 }),
      face: scn.M(SCENE_COLORS.dark1, { roughness: 0.7 }),
      bezel: scn.M(SCENE_COLORS.chargerMetal, { roughness: 0.4, metalness: 0.7 }),
    });
    const light = scn.track(
      new THREE.MeshStandardMaterial({
        color,
        emissive: s.lit ? color : '#000000',
        emissiveIntensity: s.lit ? 0.9 : 0,
        roughness: 0.3,
      }),
    );
    plate.add(new THREE.Mesh(scn.track(evsePlateLightGeometry()), light));
    const digit = digitMaterial(number);
    if (digit != null) {
      const plane = new THREE.Mesh(
        scn.track(new THREE.PlaneGeometry(EVSE_PLATE.face.widthM, EVSE_PLATE.face.heightM)),
        digit,
      );
      plane.position.set(0, EVSE_PLATE.face.yM, evseDigitZ());
      plate.add(plane);
    }
    // Out of the station merge: picked for its label, its light animates.
    plate.traverse((o) => {
      o.userData['evsePlate'] = true;
    });
    plate.position.set(mount.at[0], mount.at[1], mount.at[2]);
    plate.rotation.y = mount.turnY;
    g.add(plate);
    let byStation = platesByScene.get(scn);
    if (byStation == null) {
      byStation = new Map();
      platesByScene.set(scn, byStation);
    }
    // A station built again replaces its plates (its new station object).
    const kept = (byStation.get(s.id) ?? []).filter(
      (e) => e.built === scn.built && e.station === s,
    );
    byStation.set(s.id, [...kept, { station: s, index, plate, light, built: scn.built }]);
    return { plate, light };
  }
  scn.addEvsePlate = addEvsePlate;

  function addEvsePortLight(
    g: THREE.Object3D,
    light: THREE.MeshStandardMaterial,
    geometry: THREE.BufferGeometry,
    at: readonly [number, number, number],
    tiltX = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(scn.track(geometry), light);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.rotation.x = tiltX;
    // Out of the station merge: its light animates with the EVSE's plate light.
    mesh.userData['evseLight'] = true;
    g.add(mesh);
    return mesh;
  }
  scn.addEvsePortLight = addEvsePortLight;
}
