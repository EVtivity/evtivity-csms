// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The box number plates of the 3D site scene (site-layout-model-unit-plate.ts):
// one per unit charger of a station with units, its number on the face, kept
// per station for the hover label (`unit:<stationId>`). The plates stay out of
// the station merge, so they can be picked.

import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import {
  UNIT_NUMBER_CANVAS,
  UNIT_PLATE,
  createUnitPlateKit,
  drawUnitNumber,
  unitNumberZ,
} from './site-layout-model-unit-plate';
import type { EvsePlateMount } from './site-layout-model-evse-plate';
import type { SceneSlice } from './site-layout-scene-context';
import type { SceneStation } from './site-layout-scene-types';
import { SIGN_FONT_FAMILY } from './site-layout-signs';

type UnitPlatesCtx = SceneSlice<'M' | 'built' | 'modelKit' | 'modelOf' | 'track', 'addUnitPlate'>;

interface UnitPlateEntry {
  station: SceneStation;
  plate: THREE.Object3D;
  built: unknown;
}

const platesByScene = new WeakMap<object, Map<string, UnitPlateEntry>>();

function livePlate(scn: object, stationId: string, built: unknown): UnitPlateEntry | null {
  const entry = platesByScene.get(scn)?.get(stationId);
  return entry != null && entry.built === built ? entry : null;
}

const UNIT_HOVER_PREFIX = 'unit:';

/** The hover key of a box number plate (`onEquipmentHover`): `unit:<stationId>`. */
export function unitPlateHoverKey(stationId: string): string {
  return `${UNIT_HOVER_PREFIX}${stationId}`;
}

/** The station a box number plate hover key names, or null for any other key. */
export function parseUnitPlateHoverKey(key: string | null): string | null {
  if (key?.startsWith(UNIT_HOVER_PREFIX) !== true) return null;
  const id = key.slice(UNIT_HOVER_PREFIX.length);
  return id === '' ? null : id;
}

/**
 * The hover key of the box number plate of `stationId` when the ray meets it
 * first, else null (another part of the station in front, or no plate).
 */
export function pickUnitPlate(
  scn: SceneSlice<'objects'>,
  built: unknown,
  ray: THREE.Raycaster,
  stationId: string,
): string | null {
  const obj = scn.objects.get(stationId);
  const entry = livePlate(scn, stationId, built);
  if (obj == null || entry == null || entry.station !== obj.station) return null;
  const hit = ray.intersectObject(entry.plate, true)[0];
  if (hit == null) return null;
  const nearest = ray
    .intersectObject(obj.group, true)
    .find((h) => h.object.type === 'Mesh' && h.object.userData['ring'] !== true);
  if (nearest != null && nearest.distance < hit.distance - 1e-4) {
    let o: THREE.Object3D | null = nearest.object;
    while (o != null && o !== entry.plate) o = o.parent;
    if (o !== entry.plate) return null;
  }
  return unitPlateHoverKey(stationId);
}

/** Where the hover label of a box number plate points: just above it, in world space. */
export function unitPlateAnchor(
  scn: object,
  built: unknown,
  stationId: string,
): THREE.Vector3 | null {
  const entry = livePlate(scn, stationId, built);
  if (entry == null) return null;
  return entry.plate.localToWorld(new THREE.Vector3(0, UNIT_PLATE.heightM / 2 + 0.02, 0));
}

export function installUnitPlates(scn: UnitPlatesCtx): void {
  // The number textures of this build, one per number.
  let numbers: { built: unknown; byNumber: Map<number, THREE.Material | null> } | null = null;
  function numberMaterial(n: number): THREE.Material | null {
    if (numbers?.built !== scn.built) numbers = { built: scn.built, byNumber: new Map() };
    const cached = numbers.byNumber.get(n);
    if (cached !== undefined) return cached;
    let material: THREE.Material | null = null;
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const ctx = canvas?.getContext('2d') ?? null;
    // fail-open: without a 2D context the plate shows its plain face, no number
    if (canvas != null && ctx != null) {
      canvas.width = UNIT_NUMBER_CANVAS.width;
      canvas.height = UNIT_NUMBER_CANVAS.height;
      drawUnitNumber(ctx, n, SIGN_FONT_FAMILY);
      const texture = scn.track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      material = scn.track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    }
    numbers.byNumber.set(n, material);
    return material;
  }

  /** The box number plate of `s` (`s.unitPlate`) at `mount` on `g`; none without a box number. */
  function addUnitPlate(
    g: THREE.Object3D,
    s: SceneStation,
    mount: EvsePlateMount,
  ): THREE.Group | null {
    const number = s.unitPlate?.number;
    if (number == null) return null;
    const plate = scn.modelOf(scn.modelKit('unit-plate', createUnitPlateKit), 'unit-plate', {
      plate: scn.M(SCENE_COLORS.dark1, { roughness: 0.5, metalness: 0.2 }),
      face: scn.M(SCENE_COLORS.dark1, { roughness: 0.7 }),
    });
    const material = numberMaterial(number);
    if (material != null) {
      const plane = new THREE.Mesh(
        scn.track(new THREE.PlaneGeometry(UNIT_PLATE.face.widthM, UNIT_PLATE.face.heightM)),
        material,
      );
      plane.position.set(0, 0, unitNumberZ());
      plate.add(plane);
    }
    // Out of the station merge: picked for its label.
    plate.traverse((o) => {
      o.userData['unitPlate'] = true;
    });
    plate.position.set(mount.at[0], mount.at[1], mount.at[2]);
    plate.rotation.y = mount.turnY;
    g.add(plate);
    let byStation = platesByScene.get(scn);
    if (byStation == null) {
      byStation = new Map();
      platesByScene.set(scn, byStation);
    }
    byStation.set(s.id, { station: s, plate, built: scn.built });
    return plate;
  }
  scn.addUnitPlate = addUnitPlate;
}
