// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Picking, hovering, dragging and focusing in the 3D site scene, through the
// real three.js raycasting (no WebGL): a top-down camera over a 100 m square,
// so canvas pixel (px, py) of a 1000 px canvas is lot point (x, z).

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { clampToLot, worldToBay, bayTurn } from '../site-layout-grid';
import { distanceToSegment, installInteraction } from '../site-layout-scene-interaction';
import type { SceneLayout } from '../site-layout-scene-types';

type Ctx = Parameters<typeof installInteraction>[0];
type Lot = SceneLayout['lot'];

function px(x: number, z: number): { clientX: number; clientY: number } {
  return { clientX: (x / 50 + 1) * 500, clientY: (z / 50 + 1) * 500 };
}

function box(userData: Record<string, unknown>, size = 2): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());
  m.position.y = size / 2;
  Object.assign(m.userData, userData);
  return m;
}

const gridLot: Lot = {
  siteType: 'parking_lot',
  rowLengths: [4],
  cols: 4,
  rows: 1,
  spotW: 2.6,
  spotD: 5.5,
  lane: 7,
  pitch: 12.5,
  width: 10.4,
  depth: 5.5,
  facing: 0,
  mounting: 'wall',
  depot: null,
};

interface StationSpec {
  id: string;
  at: { x: number; z: number };
  free?: boolean;
  handle?: boolean;
  top?: number;
}

function station(spec: StationSpec) {
  const group = new THREE.Group();
  group.userData['stationId'] = spec.id;
  group.add(box({ stationId: spec.id }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.2), new THREE.MeshBasicMaterial());
  ring.userData['ring'] = true;
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 3;
  group.add(ring);
  let handle: THREE.Group | null = null;
  if (spec.handle === true) {
    handle = new THREE.Group();
    const knob = box({ rotateHandle: spec.id }, 1);
    knob.position.set(0, 3, 0);
    handle.add(knob);
    group.add(handle);
  }
  group.position.set(spec.at.x, 0, spec.at.z);
  const st = {
    id: spec.id,
    free:
      spec.free === true ? { x: spec.at.x, z: spec.at.z, rotationDeg: 0, spotType: 'car' } : null,
  };
  return { group, ring, handle, top: spec.top ?? 2, station: st };
}

interface SceneOptions {
  editing?: boolean;
  lot?: Lot;
  stations?: StationSpec[];
  withHandle?: boolean;
}

function scene(opts: SceneOptions = {}) {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const site = new THREE.Group();
  const objects = new Map<string, ReturnType<typeof station>>();
  for (const s of opts.stations ?? []) {
    const obj = station(s);
    site.add(obj.group);
    objects.set(s.id, obj);
  }
  const transformer = new THREE.Group();
  transformer.add(box({ transformerId: 'tfm_a' }));
  transformer.position.set(20, 0, 20);
  site.add(transformer);
  const battery = new THREE.Group();
  battery.add(box({ batteryId: 'ena_bat' }));
  battery.position.set(-20, 0, 20);
  site.add(battery);
  const canopy = new THREE.Group();
  canopy.add(box({ solarId: 'ena_sol' }));
  canopy.position.set(-20, 0, -20);
  site.add(canopy);
  // A grid canopy over two solar rows (not a free canopy): it does not move.
  const rowCanopy = new THREE.Group();
  rowCanopy.userData['solarRowIds'] = ['ena_r1', 'ena_r2'];
  const roof = box({ solarRowIds: ['ena_r1', 'ena_r2'] }, 1);
  roof.scale.set(6, 1, 20);
  rowCanopy.add(roof);
  rowCanopy.position.set(35, 0, -10);
  site.add(rowCanopy);
  // A panelboard (not at a transformer).
  const panel = new THREE.Group();
  panel.userData['panelId'] = 'pnl_1';
  panel.add(box({ panelId: 'pnl_1' }, 1));
  panel.position.set(0, 0, 40);
  site.add(panel);
  site.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 }) as DOMRect;
  let captured = false;
  Object.assign(canvas, {
    setPointerCapture: vi.fn(() => {
      captured = true;
    }),
    hasPointerCapture: () => captured,
    releasePointerCapture: vi.fn(() => {
      captured = false;
    }),
  });
  const virtualSign = new THREE.Sprite(new THREE.SpriteMaterial());
  virtualSign.userData['virtualSign'] = 'sta_sign';
  virtualSign.scale.set(4, 4, 1);
  virtualSign.position.set(-35, 5, 35);
  virtualSign.updateMatrixWorld(true);
  const callbacks = {
    snapTransformer: vi.fn((p: { x: number; z: number }) => ({
      x: Math.round(p.x),
      z: Math.round(p.z),
    })),
    snapFree: vi.fn((p: { x: number; z: number; rotationDeg: number }) => ({
      ...p,
      x: Math.round(p.x),
      z: Math.round(p.z),
    })),
    freeDropState: vi.fn(() => ({ blocked: true, guides: [{ kind: 'x' }] })),
    onTransformerDrop: vi.fn(),
    onBatteryDrop: vi.fn(),
    onSolarDrop: vi.fn(),
    onSolarPick: vi.fn(),
    onFreeDrop: vi.fn(),
    onPick: vi.fn(),
    onDrop: vi.fn(),
    onHover: vi.fn(),
    onEquipmentHover: vi.fn(),
    isBayTaken: vi.fn(() => false),
  };
  const lot = opts.lot ?? gridLot;
  const scn = {
    applySelection: vi.fn(),
    batteryObjects: new Map([['ena_bat', battery]]),
    built: {},
    callbacks,
    camera,
    controls: { enabled: true },
    editing: opts.editing ?? true,
    energyLabels: new Map([
      ['ena_r1', new THREE.Vector3(35, 0, -18)],
      ['ena_r2', new THREE.Vector3(35, 0, -2)],
    ]),
    focusAt: vi.fn(),
    layout: {
      lot,
      stations: [],
      links: {
        segments: [
          {
            flowId: 'flow_a',
            points: [
              { x: -40, z: -40 },
              { x: -40, z: 0 },
            ],
          },
          { flowId: 'flow_unlabeled', points: [{ x: 45, z: 45 }, null, { x: 45, z: 30 }] },
        ],
      },
    },
    linkLabels: new Map([['flow_a', {}]]),
    lotPoint: (p: { x: number; z: number }) => new THREE.Vector3(p.x, 0, p.z),
    objects,
    poseOf: vi.fn((s: { id: string }) => ({
      point: (opts.stations ?? []).find((x) => x.id === s.id)?.at ?? { x: 0, z: 0 },
      turn: 0,
    })),
    renderer: { domElement: canvas },
    showGuides: vi.fn(),
    site,
    solarObjects: new Map([['ena_sol', canopy]]),
    theme: { primary: '#00ff00', destructive: '#ff0000' },
    transformerObjects: new Map([['tfm_a', transformer]]),
    virtualSprites: new Map([['sta_sign', virtualSign]]),
  } as unknown as Ctx;
  installInteraction(scn);
  const handlers = scn as unknown as Record<string, (e: unknown) => void>;
  const fire = (
    name: 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onDoubleClick',
    at: { clientX: number; clientY: number },
    extra: Partial<{ pointerType: string; shiftKey: boolean; timeStamp: number }> = {},
  ): void => {
    handlers[name]?.({
      ...at,
      pointerId: 1,
      pointerType: 'mouse',
      shiftKey: false,
      timeStamp: 0,
      ...extra,
    });
  };
  const leave = (): void => {
    handlers['onPointerLeave']?.({});
  };
  return { scn, fire, leave, callbacks, canvas, objects, transformer, battery, canopy };
}

describe('distanceToSegment', () => {
  it('measures to the nearest point of the segment, its ends included', () => {
    expect(distanceToSegment({ x: 1, z: 3 }, { x: 0, z: 0 }, { x: 4, z: 0 })).toBeCloseTo(3);
    expect(distanceToSegment({ x: -3, z: 4 }, { x: 0, z: 0 }, { x: 4, z: 0 })).toBeCloseTo(5);
    expect(distanceToSegment({ x: 7, z: 4 }, { x: 0, z: 0 }, { x: 4, z: 0 })).toBeCloseTo(5);
  });

  it('measures to the point of a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, z: 4 }, { x: 0, z: 0 }, { x: 0, z: 0 })).toBeCloseTo(5);
  });
});

describe('hovering with a mouse', () => {
  it('reports the station under the pointer once per change and sets the cursor', () => {
    const { fire, callbacks, canvas } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }],
    });
    fire('onPointerMove', px(0, 0));
    fire('onPointerMove', px(0.2, 0.2));
    expect(callbacks.onHover).toHaveBeenCalledTimes(1);
    expect(callbacks.onHover).toHaveBeenLastCalledWith('sta_a');
    expect(canvas.style.cursor).toBe('pointer');
    // A station hides any equipment label: onEquipmentHover keeps its first null.
    expect(callbacks.onEquipmentHover).not.toHaveBeenCalled();
    fire('onPointerMove', px(10, 10));
    expect(callbacks.onHover).toHaveBeenLastCalledWith(null);
    expect(canvas.style.cursor).toBe('default');
  });

  it('shows the grab cursor in Edit Layout', () => {
    const { fire, canvas } = scene({ stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }] });
    fire('onPointerMove', px(0, 0));
    expect(canvas.style.cursor).toBe('grab');
  });

  it('ignores touch moves without a drag', () => {
    const { fire, callbacks } = scene({ stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }] });
    fire('onPointerMove', px(0, 0), { pointerType: 'touch' });
    expect(callbacks.onHover).not.toHaveBeenCalled();
  });

  it('names the equipment under the pointer by its label key', () => {
    const { fire, callbacks } = scene({ editing: false });
    fire('onPointerMove', px(20, 20));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('transformer:tfm_a');
    fire('onPointerMove', px(-20, 20));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('energy:ena_bat');
    fire('onPointerMove', px(-20, -20));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('energy:ena_sol');
    fire('onPointerMove', px(0, 40));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('panel:pnl_1');
  });

  it('names the solar row of a row canopy nearest the pointer', () => {
    const { fire, callbacks } = scene({ editing: false });
    fire('onPointerMove', px(35, -17));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('energy:ena_r1');
    fire('onPointerMove', px(35, -3));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('energy:ena_r2');
  });

  it('names a labeled cable run within 0.45 m of the ground point, never an unlabeled one', () => {
    const { fire, callbacks } = scene({ editing: false });
    fire('onPointerMove', px(-39.7, -20));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('flow_a');
    fire('onPointerMove', px(-39, -20));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith(null);
    fire('onPointerMove', px(45, 38));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith(null);
  });

  it('shows a virtual status sign instead of the station tooltip', () => {
    const { fire, callbacks } = scene({ editing: false });
    fire('onPointerMove', px(-35, 35));
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('virtual:sta_sign');
    expect(callbacks.onHover).not.toHaveBeenCalled();
  });

  it('clears both labels when the pointer leaves the canvas', () => {
    const { fire, leave, callbacks } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }],
    });
    fire('onPointerMove', px(0, 0));
    fire('onPointerMove', px(20, 20));
    leave();
    expect(callbacks.onHover).toHaveBeenLastCalledWith(null);
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith(null);
  });
});

describe('clicking and tapping', () => {
  it('picks the station under a click outside Edit Layout, and none on empty ground', () => {
    const { fire, callbacks } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }],
    });
    fire('onPointerDown', px(0, 0));
    fire('onPointerUp', px(0, 0));
    expect(callbacks.onPick).toHaveBeenLastCalledWith('sta_a');
    fire('onPointerDown', px(10, 10));
    fire('onPointerUp', px(10, 10));
    expect(callbacks.onPick).toHaveBeenLastCalledWith(null);
    expect(callbacks.onSolarPick).not.toHaveBeenCalled();
  });

  it('picks nothing after the pointer moved more than 5 px between down and up', () => {
    const { fire, callbacks } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }],
    });
    fire('onPointerDown', px(0, 0));
    fire('onPointerUp', px(1, 0));
    expect(callbacks.onPick).not.toHaveBeenCalled();
  });

  it('shows the equipment label on a touch tap and hides it on a tap elsewhere', () => {
    const { fire, callbacks } = scene({ editing: false });
    fire('onPointerDown', px(20, 20), { pointerType: 'touch' });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch' });
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('transformer:tfm_a');
    fire('onPointerDown', px(-35, 35), { pointerType: 'touch', timeStamp: 1000 });
    fire('onPointerUp', px(-35, 35), { pointerType: 'touch', timeStamp: 1000 });
    expect(callbacks.onEquipmentHover).toHaveBeenLastCalledWith('virtual:sta_sign');
  });

  it('selects a station clicked in Edit Layout without a move, clearing the canopy pick', () => {
    const { fire, callbacks, scn } = scene({ stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }] });
    fire('onPointerDown', px(0, 0));
    expect(scn.controls.enabled).toBe(false);
    fire('onPointerUp', px(0, 0));
    expect(scn.controls.enabled).toBe(true);
    expect(scn.drag).toBeNull();
    expect(callbacks.onSolarPick).toHaveBeenCalledWith(null);
    expect(callbacks.onPick).toHaveBeenLastCalledWith('sta_a');
    expect(scn.showGuides).toHaveBeenCalledWith([]);
  });

  it('selects a free canopy clicked in Edit Layout, clearing the station pick', () => {
    const { fire, callbacks } = scene();
    fire('onPointerDown', px(-20, -20));
    fire('onPointerUp', px(-20, -20));
    expect(callbacks.onPick).toHaveBeenLastCalledWith(null);
    expect(callbacks.onSolarPick).toHaveBeenLastCalledWith('ena_sol');
  });

  it('clears the canopy pick on a click of empty ground in Edit Layout', () => {
    const { fire, callbacks, scn } = scene();
    fire('onPointerDown', px(10, 10));
    expect(scn.drag).toBeNull();
    fire('onPointerUp', px(10, 10));
    expect(callbacks.onSolarPick).toHaveBeenCalledWith(null);
    expect(callbacks.onPick).toHaveBeenLastCalledWith(null);
  });

  it('drops nothing for a transformer clicked without a move', () => {
    const { fire, callbacks } = scene();
    fire('onPointerDown', px(20, 20));
    fire('onPointerUp', px(20, 20));
    expect(callbacks.onTransformerDrop).not.toHaveBeenCalled();
    expect(callbacks.onPick).not.toHaveBeenCalled();
  });
});

describe('dragging in Edit Layout', () => {
  it('moves a battery to the snapped point and drops it by its id', () => {
    const { fire, callbacks, battery } = scene();
    fire('onPointerDown', px(-20, 20));
    fire('onPointerMove', px(-10.4, 25.3));
    expect(battery.position.x).toBe(-10);
    expect(battery.position.z).toBe(25);
    fire('onPointerUp', px(-10.4, 25.3));
    expect(callbacks.onBatteryDrop).toHaveBeenCalledWith('ena_bat', { x: -10, z: 25 });
  });

  it('keeps a move within 5 px a click', () => {
    const { fire, callbacks, battery } = scene();
    fire('onPointerDown', px(-20, 20));
    fire('onPointerMove', px(-19.8, 20));
    expect(battery.position.x).toBe(-20);
    fire('onPointerUp', px(-19.8, 20));
    expect(callbacks.onBatteryDrop).not.toHaveBeenCalled();
  });

  it('moves a free canopy through snapFree and drops it by its id', () => {
    const { fire, callbacks, canopy } = scene();
    fire('onPointerDown', px(-20, -20));
    fire('onPointerMove', px(-5.2, -14.6));
    const [asked, grid] = callbacks.snapFree.mock.calls.at(-1) as unknown as [
      { x: number; z: number; rotationDeg: number },
      boolean,
    ];
    expect(asked.x).toBeCloseTo(-5.2);
    expect(asked.z).toBeCloseTo(-14.6);
    expect(asked.rotationDeg).toBe(0);
    expect(grid).toBe(false);
    expect(canopy.position.x).toBe(-5);
    expect(canopy.position.z).toBe(-15);
    fire('onPointerUp', px(-5.2, -14.6));
    expect(callbacks.onSolarDrop).toHaveBeenCalledWith('ena_sol', { x: -5, z: -15 });
  });

  it('never grabs a row canopy (a grid site canopy covers its row)', () => {
    const { fire, scn } = scene();
    fire('onPointerDown', px(35, -10));
    expect(scn.drag).toBeNull();
    expect(scn.controls.enabled).toBe(true);
  });

  it('moves a station freely on a custom site and shows its drop state', () => {
    const { fire, callbacks, objects, scn } = scene({
      lot: { ...gridLot, siteType: 'custom' },
      stations: [{ id: 'sta_f', at: { x: 0, z: 0 }, free: true }],
    });
    const obj = objects.get('sta_f');
    fire('onPointerDown', px(0, 0));
    fire('onPointerMove', px(8.3, -3.6));
    expect(obj?.group.position.x).toBe(8);
    expect(obj?.group.position.z).toBe(-4);
    expect(callbacks.freeDropState).toHaveBeenLastCalledWith('sta_f', {
      x: 8,
      z: -4,
      rotationDeg: -0,
      spotType: 'car',
    });
    expect(obj?.ring.material.color.getHexString()).toBe('ff0000');
    expect(obj?.ring.material.opacity).toBe(0.9);
    expect(scn.showGuides).toHaveBeenLastCalledWith([{ kind: 'x' }]);
    fire('onPointerUp', px(8.3, -3.6));
    // Back to its stored position until the new layout arrives.
    expect(obj?.group.position.x).toBe(0);
    expect(obj?.group.position.z).toBe(0);
    expect(scn.applySelection).toHaveBeenCalled();
    expect(callbacks.onFreeDrop).toHaveBeenCalledWith('sta_f', {
      x: 8,
      z: -4,
      rotationDeg: -0,
      spotType: 'car',
    });
  });

  it('shows a free move as allowed without a drop state callback', () => {
    const { fire, callbacks, objects } = scene({
      lot: { ...gridLot, siteType: 'custom' },
      stations: [{ id: 'sta_f', at: { x: 0, z: 0 }, free: true }],
    });
    delete (callbacks as Partial<typeof callbacks>).freeDropState;
    fire('onPointerDown', px(0, 0));
    fire('onPointerMove', px(6, 6));
    expect(objects.get('sta_f')?.ring.material.color.getHexString()).toBe('00ff00');
  });

  it('turns a station by its visible rotation handle toward the pointer', () => {
    const { fire, callbacks, objects } = scene({
      lot: { ...gridLot, siteType: 'custom' },
      stations: [{ id: 'sta_f', at: { x: 0, z: 0 }, free: true, handle: true }],
    });
    const obj = objects.get('sta_f');
    // The handle shows on the selected station only.
    if (obj?.handle != null) obj.handle.visible = true;
    fire('onPointerDown', px(0, 0));
    // Pointer due +x of the station: local +z turns to +x, rotation 90 degrees clockwise.
    fire('onPointerMove', px(20, 0));
    const turn = obj?.group.rotation.y ?? 0;
    expect(Math.sin(turn)).toBeCloseTo(1, 3);
    expect(Math.cos(turn)).toBeCloseTo(0, 3);
    expect(obj?.group.position.x).toBe(0);
    fire('onPointerUp', px(20, 0));
    expect(callbacks.onFreeDrop).toHaveBeenCalledTimes(1);
    const [, placement] = callbacks.onFreeDrop.mock.calls[0] as [string, { rotationDeg: number }];
    expect(((placement.rotationDeg % 360) + 360) % 360).toBeCloseTo(270, 3);
  });

  it('picks the station, not a hidden rotation handle', () => {
    const { fire, scn } = scene({
      lot: { ...gridLot, siteType: 'custom' },
      stations: [{ id: 'sta_f', at: { x: 0, z: 0 }, free: true, handle: true }],
    });
    const obj = scn.objects.get('sta_f');
    if (obj?.handle != null) obj.handle.visible = false;
    fire('onPointerDown', px(0, 0));
    expect(scn.drag?.kind).toBe('station');
  });

  it('moves a grid station clamped to the lot, turned with the row, and drops it on a bay', () => {
    const { fire, callbacks, objects } = scene({
      stations: [{ id: 'sta_g', at: { x: 0, z: 0 } }],
    });
    const obj = objects.get('sta_g');
    fire('onPointerDown', px(0, 0));
    fire('onPointerMove', px(30, 30));
    const clamped = clampToLot(30, 30, gridLot);
    expect(obj?.group.position.x).toBeCloseTo(clamped.x);
    expect(obj?.group.position.z).toBeCloseTo(clamped.z);
    const bay = worldToBay(clamped.x, clamped.z, gridLot);
    expect(bay).not.toBeNull();
    if (bay == null) return;
    expect(obj?.group.rotation.y).toBe(bayTurn(bay, gridLot));
    expect(callbacks.isBayTaken).toHaveBeenLastCalledWith(bay, 'sta_g');
    expect(obj?.ring.material.color.getHexString()).toBe('00ff00');
    fire('onPointerUp', px(30, 30));
    expect(callbacks.onDrop).toHaveBeenCalledWith('sta_g', bay);
    expect(obj?.group.position.x).toBe(0);
  });

  it('colors the ring as blocked over a taken bay', () => {
    const { fire, callbacks, objects } = scene({
      stations: [{ id: 'sta_g', at: { x: 0, z: 0 } }],
    });
    callbacks.isBayTaken.mockReturnValue(true);
    fire('onPointerDown', px(0, 0));
    fire('onPointerMove', px(3, 0));
    expect(objects.get('sta_g')?.ring.material.color.getHexString()).toBe('ff0000');
  });

  it('clears the hover labels while dragging', () => {
    const { fire, callbacks } = scene({ stations: [{ id: 'sta_g', at: { x: 0, z: 0 } }] });
    fire('onPointerMove', px(0, 0));
    fire('onPointerDown', px(0, 0));
    fire('onPointerMove', px(3, 0));
    expect(callbacks.onHover).toHaveBeenLastCalledWith(null);
  });
});

describe('pointUnder', () => {
  it('returns the model point under the pointer, else the ground point', () => {
    const { scn } = scene({ stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }] });
    const onModel = scn.pointUnder(px(0, 0));
    expect(onModel?.y).toBeCloseTo(2);
    const onPanel = scn.pointUnder(px(0, 40));
    expect(onPanel?.y).toBeCloseTo(1);
    const onGround = scn.pointUnder(px(10, -10));
    expect(onGround?.x).toBeCloseTo(10);
    expect(onGround?.y).toBeCloseTo(0);
    expect(onGround?.z).toBeCloseTo(-10);
  });
});

describe('double click focus', () => {
  it('focuses a station at half its height', () => {
    const { fire, scn } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 5, z: 5 }, top: 3 }],
    });
    fire('onDoubleClick', px(5, 5));
    const [point, height] = (scn.focusAt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      THREE.Vector3,
      number,
    ];
    expect(point.x).toBeCloseTo(5);
    expect(point.y).toBeCloseTo(1.5);
    expect(point.z).toBeCloseTo(5);
    expect(height).toBe(3);
  });

  it('keeps a low station focus at least 0.5 m up and 1.2 m high', () => {
    const { fire, scn } = scene({
      editing: false,
      stations: [{ id: 'sta_a', at: { x: 5, z: 5 }, top: 0.4 }],
    });
    fire('onDoubleClick', px(5, 5));
    const [point, height] = (scn.focusAt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      THREE.Vector3,
      number,
    ];
    expect(point.y).toBeCloseTo(0.5);
    expect(height).toBe(1.2);
  });

  it('focuses equipment at the center of its box', () => {
    const { fire, scn } = scene({ editing: false });
    fire('onDoubleClick', px(20, 20));
    const [point, height] = (scn.focusAt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      THREE.Vector3,
      number,
    ];
    expect(point.x).toBeCloseTo(20);
    expect(point.y).toBeCloseTo(1);
    expect(height).toBeCloseTo(2);
  });

  it('focuses a panel at its group, at least 1 m high', () => {
    const { fire, scn } = scene({ editing: false });
    fire('onDoubleClick', px(0, 40));
    const [point, height] = (scn.focusAt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      THREE.Vector3,
      number,
    ];
    expect(point.z).toBeCloseTo(40);
    expect(height).toBe(1);
  });

  it('focuses nothing on empty ground or during a drag', () => {
    const { fire, scn } = scene({ stations: [{ id: 'sta_a', at: { x: 0, z: 0 } }] });
    fire('onDoubleClick', px(10, -10));
    fire('onPointerDown', px(0, 0));
    fire('onDoubleClick', px(0, 0));
    expect(scn.focusAt).not.toHaveBeenCalled();
  });

  it('focuses on a touch double tap and ignores the browser dblclick after a touch', () => {
    const { fire, scn } = scene({ editing: false });
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 100 });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch', timeStamp: 100 });
    fire('onDoubleClick', px(20, 20));
    expect(scn.focusAt).not.toHaveBeenCalled();
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 250 });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch', timeStamp: 250 });
    expect(scn.focusAt).toHaveBeenCalledTimes(1);
    // A third tap starts a new pair.
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 400 });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch', timeStamp: 400 });
    expect(scn.focusAt).toHaveBeenCalledTimes(1);
  });

  it('ends a tap pair when the touch moved', () => {
    const { fire, scn } = scene({ editing: false });
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 100 });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch', timeStamp: 100 });
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 200 });
    fire('onPointerUp', px(22, 20), { pointerType: 'touch', timeStamp: 200 });
    fire('onPointerDown', px(20, 20), { pointerType: 'touch', timeStamp: 300 });
    fire('onPointerUp', px(20, 20), { pointerType: 'touch', timeStamp: 300 });
    expect(scn.focusAt).not.toHaveBeenCalled();
  });
});
