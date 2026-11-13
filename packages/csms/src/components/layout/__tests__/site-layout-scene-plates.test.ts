// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The EVSE number plates and box number plates of the 3D site scene: where
// they stand, their number texture and light, which build they belong to, and
// which plate a ray meets first (the hover label). The scene kit is the real
// one; a recording 2D context stands in for the canvas the test DOM lacks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EVSE_PLATE } from '../site-layout-model-evse-plate';
import { UNIT_PLATE } from '../site-layout-model-unit-plate';
import {
  evsePlateAnchor,
  evsePlateHoverKey,
  evsePlateLights,
  installEvsePlates,
  parseEvsePlateHoverKey,
  pickEvsePlate,
} from '../site-layout-scene-evse-plates';
import { installKit } from '../site-layout-scene-kit';
import {
  installUnitPlates,
  parseUnitPlateHoverKey,
  pickUnitPlate,
  unitPlateAnchor,
  unitPlateHoverKey,
} from '../site-layout-scene-unit-plates';
import type { SceneStation } from '../site-layout-scene-types';

type EvseCtx = Parameters<typeof installEvsePlates>[0];
type UnitCtx = Parameters<typeof installUnitPlates>[0];
type KitCtx = Parameters<typeof installKit>[0];
type Scn = Omit<EvseCtx & UnitCtx, 'built'> & {
  built: unknown[];
  objects: Map<string, { group: THREE.Group; station: SceneStation }>;
};
/** The scene as the pickers read it. */
const picks = (scn: Scn): Parameters<typeof pickEvsePlate>[0] =>
  scn as unknown as Parameters<typeof pickEvsePlate>[0];

let drawn: string[] = [];
let withContext = true;

beforeEach(() => {
  drawn = [];
  withContext = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (!withContext) return null;
    return {
      fillStyle: '',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect: () => undefined,
      fillText: (text: string) => {
        drawn.push(text);
      },
    } as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function scene(): Scn {
  const scn = { objects: new Map() } as unknown as Scn;
  installKit(scn as unknown as KitCtx);
  installEvsePlates(scn as unknown as EvseCtx);
  installUnitPlates(scn as unknown as UnitCtx);
  return scn;
}

function sceneStation(over: Record<string, unknown> = {}): SceneStation {
  return { id: 'sta_a', lit: true, lightColor: '#22c55e', ...over } as unknown as SceneStation;
}

/** A level ray toward -z through (x, y), from in front of the plates. */
function rayAt(x: number, y: number): THREE.Raycaster {
  return new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
}

/** A station group at the origin holding the plates, registered as the scene object. */
function stationGroup(scn: Scn, s: SceneStation): THREE.Group {
  const group = new THREE.Group();
  scn.objects.set(s.id, { group, station: s });
  return group;
}

describe('EVSE plate hover keys', () => {
  it('refuses keys of another kind or without a valid index', () => {
    expect(parseEvsePlateHoverKey(null)).toBeNull();
    expect(parseEvsePlateHoverKey('unit:sta_a')).toBeNull();
    expect(parseEvsePlateHoverKey('evse:sta_a')).toBeNull();
    expect(parseEvsePlateHoverKey('evse::1')).toBeNull();
    expect(parseEvsePlateHoverKey('evse:sta_a:-1')).toBeNull();
    expect(parseEvsePlateHoverKey('evse:sta_a:1.5')).toBeNull();
    expect(parseEvsePlateHoverKey(evsePlateHoverKey('sta_a', 2))).toEqual({
      stationId: 'sta_a',
      index: 2,
    });
  });
});

describe('addEvsePlate', () => {
  it('mounts the plate with its EVSE number, its lamp color lit, every part marked', () => {
    const scn = scene();
    const s = sceneStation({
      evseLamps: [{ number: 7, color: '#ff8800' }],
    });
    const g = stationGroup(scn, s);
    const { plate, light } = scn.addEvsePlate(g, s, 0, { at: [0.1, 1.2, 0.3], turnY: Math.PI });
    expect(plate.parent).toBe(g);
    expect(plate.position.toArray()).toEqual([0.1, 1.2, 0.3]);
    expect(plate.rotation.y).toBe(Math.PI);
    expect(light.color.getHexString()).toBe('ff8800');
    expect(light.emissive.getHexString()).toBe('ff8800');
    expect(light.emissiveIntensity).toBe(0.9);
    expect(drawn).toEqual(['7']);
    plate.traverse((o) => {
      expect(o.userData['evsePlate']).toBe(true);
    });
  });

  it('numbers an EVSE without a lamp by its order, its light dark while the station is offline', () => {
    const scn = scene();
    const s = sceneStation({ lit: false });
    const { light } = scn.addEvsePlate(stationGroup(scn, s), s, 1, { at: [0, 0, 0], turnY: 0 });
    expect(drawn).toEqual(['2']);
    expect(light.color.getHexString()).toBe('22c55e');
    expect(light.emissive.getHexString()).toBe('000000');
    expect(light.emissiveIntensity).toBe(0);
  });

  it('draws each number once per build and again after a rebuild', () => {
    const scn = scene();
    const s = sceneStation();
    const g = stationGroup(scn, s);
    scn.addEvsePlate(g, s, 0, { at: [0, 0, 0], turnY: 0 });
    scn.addEvsePlate(g, sceneStation({ id: 'sta_b' }), 0, { at: [1, 0, 0], turnY: 0 });
    expect(drawn).toEqual(['1']);
    scn.built = [];
    scn.addEvsePlate(g, s, 0, { at: [0, 0, 0], turnY: 0 });
    expect(drawn).toEqual(['1', '1']);
  });

  it('shows the plain face without a 2D context', () => {
    withContext = false;
    const scn = scene();
    const s = sceneStation();
    const { plate } = scn.addEvsePlate(stationGroup(scn, s), s, 0, { at: [0, 0, 0], turnY: 0 });
    const planes = plate.children.filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.PlaneGeometry,
    );
    expect(planes).toHaveLength(0);
  });

  it('lists the lights of the current build only, a rebuilt station replacing its plates', () => {
    const scn = scene();
    const s = sceneStation();
    const g = stationGroup(scn, s);
    const first = scn.built;
    scn.addEvsePlate(g, s, 0, { at: [0, 0, 0], turnY: 0 });
    scn.addEvsePlate(g, s, 1, { at: [0.2, 0, 0], turnY: 0 });
    expect(evsePlateLights(scn, first).map((e) => e.index)).toEqual([0, 1]);
    scn.built = [];
    const s2 = sceneStation();
    scn.addEvsePlate(g, s2, 0, { at: [0, 0, 0], turnY: 0 });
    expect(evsePlateLights(scn, first)).toEqual([]);
    expect(evsePlateLights(scn, scn.built).map((e) => e.station)).toEqual([s2]);
    expect(evsePlateLights({}, scn.built)).toEqual([]);
  });

  it('points the label anchor just above the plate, none for a plate it does not know', () => {
    const scn = scene();
    const s = sceneStation();
    const g = stationGroup(scn, s);
    g.position.set(10, 0, 0);
    scn.addEvsePlate(g, s, 0, { at: [0, 1, 0], turnY: 0 });
    g.updateMatrixWorld(true);
    const a = evsePlateAnchor(scn, scn.built, 'sta_a', 0);
    expect(a?.x).toBeCloseTo(10);
    expect(a?.y).toBeCloseTo(1 + EVSE_PLATE.heightM / 2 + 0.02);
    expect(evsePlateAnchor(scn, scn.built, 'sta_a', 3)).toBeNull();
    expect(evsePlateAnchor(scn, [], 'sta_a', 0)).toBeNull();
  });

  it('adds a port light sharing the plate light, out of the merge', () => {
    const scn = scene();
    const s = sceneStation();
    const g = stationGroup(scn, s);
    const { light } = scn.addEvsePlate(g, s, 0, { at: [0, 0, 0], turnY: 0 });
    const mesh = scn.addEvsePortLight(g, light, new THREE.SphereGeometry(0.01), [0, 1, 0.2], 0.3);
    expect(mesh.material).toBe(light);
    expect(mesh.position.toArray()).toEqual([0, 1, 0.2]);
    expect(mesh.rotation.x).toBeCloseTo(0.3);
    expect(mesh.userData['evseLight']).toBe(true);
    expect(mesh.parent).toBe(g);
    const flat = scn.addEvsePortLight(g, light, new THREE.SphereGeometry(0.01), [0, 0, 0]);
    expect(flat.rotation.x).toBe(0);
  });
});

describe('pickEvsePlate', () => {
  function twoPlates() {
    const scn = scene();
    const s = sceneStation();
    const g = stationGroup(scn, s);
    scn.addEvsePlate(g, s, 0, { at: [-0.5, 1, 0], turnY: 0 });
    scn.addEvsePlate(g, s, 1, { at: [0.5, 1, 0], turnY: 0 });
    g.updateMatrixWorld(true);
    return { scn, s, g };
  }

  it('names the plate the ray meets', () => {
    const { scn } = twoPlates();
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(-0.5, 1), 'sta_a')).toBe('evse:sta_a:0');
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(0.5, 1), 'sta_a')).toBe('evse:sta_a:1');
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(2, 1), 'sta_a')).toBeNull();
  });

  it('names nothing behind another part of the station, a ring not counting', () => {
    const { scn, g } = twoPlates();
    const ring = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.01), new THREE.MeshBasicMaterial());
    ring.userData['ring'] = true;
    ring.position.z = 1;
    g.add(ring);
    g.updateMatrixWorld(true);
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(-0.5, 1), 'sta_a')).toBe('evse:sta_a:0');
    const body = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.01), new THREE.MeshBasicMaterial());
    body.position.z = 2;
    g.add(body);
    g.updateMatrixWorld(true);
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(-0.5, 1), 'sta_a')).toBeNull();
  });

  it('names nothing for an unknown station, another build or a rebuilt station', () => {
    const { scn } = twoPlates();
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(-0.5, 1), 'sta_x')).toBeNull();
    expect(pickEvsePlate(picks(scn), [], rayAt(-0.5, 1), 'sta_a')).toBeNull();
    const obj = scn.objects.get('sta_a');
    if (obj != null) obj.station = sceneStation();
    expect(pickEvsePlate(picks(scn), scn.built, rayAt(-0.5, 1), 'sta_a')).toBeNull();
  });
});

describe('box number plates', () => {
  it('round-trips the hover key and refuses other keys', () => {
    expect(parseUnitPlateHoverKey(unitPlateHoverKey('sta_a'))).toBe('sta_a');
    expect(parseUnitPlateHoverKey('unit:')).toBeNull();
    expect(parseUnitPlateHoverKey('evse:sta_a:0')).toBeNull();
    expect(parseUnitPlateHoverKey(null)).toBeNull();
  });

  it('adds no plate to a station without a box number', () => {
    const scn = scene();
    const s = sceneStation();
    expect(scn.addUnitPlate(stationGroup(scn, s), s, { at: [0, 0, 0], turnY: 0 })).toBeNull();
  });

  it('mounts the plate with its number, every part marked, each number drawn once per build', () => {
    const scn = scene();
    const s = sceneStation({ unitPlate: { number: 3 } });
    const g = stationGroup(scn, s);
    const plate = scn.addUnitPlate(g, s, { at: [0, 1.25, 0.1], turnY: 0.5 });
    expect(plate?.parent).toBe(g);
    expect(plate?.position.toArray()).toEqual([0, 1.25, 0.1]);
    expect(plate?.rotation.y).toBe(0.5);
    plate?.traverse((o) => {
      expect(o.userData['unitPlate']).toBe(true);
    });
    scn.addUnitPlate(g, sceneStation({ id: 'sta_b', unitPlate: { number: 3 } }), {
      at: [1, 1, 0],
      turnY: 0,
    });
    expect(drawn).toEqual(['3']);
    scn.built = [];
    scn.addUnitPlate(g, s, { at: [0, 1.25, 0.1], turnY: 0.5 });
    expect(drawn).toEqual(['3', '3']);
  });

  it('shows the plain face without a 2D context', () => {
    withContext = false;
    const scn = scene();
    const s = sceneStation({ unitPlate: { number: 1 } });
    const plate = scn.addUnitPlate(stationGroup(scn, s), s, { at: [0, 0, 0], turnY: 0 });
    const planes = (plate?.children ?? []).filter(
      (c) => (c as THREE.Mesh).geometry instanceof THREE.PlaneGeometry,
    );
    expect(planes).toHaveLength(0);
  });

  function plated() {
    const scn = scene();
    const s = sceneStation({ unitPlate: { number: 2 } });
    const g = stationGroup(scn, s);
    const plate = scn.addUnitPlate(g, s, { at: [0, 1, 0], turnY: 0 });
    g.updateMatrixWorld(true);
    return { scn, s, g, plate };
  }

  it('names the plate the ray meets, also when the ray meets its own face first', () => {
    const { scn } = plated();
    expect(pickUnitPlate(picks(scn), scn.built, rayAt(0, 1), 'sta_a')).toBe('unit:sta_a');
    expect(pickUnitPlate(picks(scn), scn.built, rayAt(1, 1), 'sta_a')).toBeNull();
  });

  it('names nothing behind another part of the station', () => {
    const { scn, g } = plated();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.01), new THREE.MeshBasicMaterial());
    body.position.set(0, 1, 1);
    g.add(body);
    g.updateMatrixWorld(true);
    expect(pickUnitPlate(picks(scn), scn.built, rayAt(0, 1), 'sta_a')).toBeNull();
  });

  it('names nothing for an unknown station, another build or a rebuilt station', () => {
    const { scn } = plated();
    expect(pickUnitPlate(picks(scn), scn.built, rayAt(0, 1), 'sta_x')).toBeNull();
    expect(pickUnitPlate(picks(scn), [], rayAt(0, 1), 'sta_a')).toBeNull();
    const obj = scn.objects.get('sta_a');
    if (obj != null) obj.station = sceneStation();
    expect(pickUnitPlate(picks(scn), scn.built, rayAt(0, 1), 'sta_a')).toBeNull();
  });

  it('points the label anchor just above the plate, none for another build', () => {
    const { scn, g } = plated();
    g.position.set(0, 0, -4);
    g.updateMatrixWorld(true);
    const a = unitPlateAnchor(scn, scn.built, 'sta_a');
    expect(a?.y).toBeCloseTo(1 + UNIT_PLATE.heightM / 2 + 0.02);
    expect(a?.z).toBeCloseTo(-4);
    expect(unitPlateAnchor(scn, [], 'sta_a')).toBeNull();
  });
});
