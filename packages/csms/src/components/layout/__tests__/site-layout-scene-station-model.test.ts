// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// One station's model in the 3D site scene: its card readers, props, virtual
// status sign, rotation handle and the vehicles of a dual-outlet bus charger
// and a two-port curb post, through the real station builder (no WebGL).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { freeSpotRects } from '@evtivity/lib/site-layout';
import { STATUS_COLORS } from '@/lib/chart-theme';
import { sceneCar } from '../site-layout-car';
import { SCENE_COLORS } from '../site-layout-colors';
import { CURB_POST_BACK_M, readerMount, wallBoxOffset } from '../site-layout-grid';
import { READER_SCENE_SCALE } from '../site-layout-model-reader-parts';
import { installCables } from '../site-layout-scene-cables';
import { installChargerModel } from '../site-layout-scene-charger-model';
import { installConnectors } from '../site-layout-scene-connectors';
import type { SceneCtx } from '../site-layout-scene-context';
import { installDressing } from '../site-layout-scene-dressing';
import { installEvsePlates } from '../site-layout-scene-evse-plates';
import { installFreeSpots } from '../site-layout-scene-free-spots';
import { installKit } from '../site-layout-scene-kit';
import { installLargeChargers } from '../site-layout-scene-large-chargers';
import { installMerge } from '../site-layout-scene-merge';
import { installRfidPads } from '../site-layout-scene-rfid';
import { installStationModel } from '../site-layout-scene-station-model';
import { installTemplates } from '../site-layout-scene-templates';
import { installUnitPlates } from '../site-layout-scene-unit-plates';
import { VIRTUAL_SIGN_Y_M, type SceneLayout, type SceneStation } from '../site-layout-scene-types';
import { ENGLISH_SIGN_TEXTS } from '../site-layout-signs';

type Lot = SceneLayout['lot'];

function lotOf(overrides: Partial<Lot> = {}): Lot {
  return {
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
    ...overrides,
  };
}

const POSE = { point: { x: 3, z: 4 }, turn: Math.PI / 2 };

function sceneCtx(lot: Lot): SceneCtx {
  const color = STATUS_COLORS['charging'] ?? '#22c55e';
  const scn = {} as SceneCtx;
  scn.theme = {
    dark: false,
    signs: ENGLISH_SIGN_TEXTS,
    virtualColors: { reserved: color, maintenance: color },
    plateColors: { ac: '#336699', dc: '#336699' },
    primary: color,
    destructive: color,
  };
  scn.layout = {
    lot,
    stations: [],
    transformers: [],
    batteries: [],
    solar: [],
    panels: [],
    links: { segments: [], labels: [] },
  };
  scn.logo = null;
  scn.chargeFlowTextures = [];
  scn.objects = new Map();
  scn.site = new THREE.Group();
  scn.editing = false;
  scn.poseOf = () => POSE;
  scn.lotPoint = (p, y = 0) => new THREE.Vector3(p.x, y, p.z);
  installKit(scn);
  installCables(scn);
  installConnectors(scn);
  installFreeSpots(scn);
  installTemplates(scn);
  installDressing(scn);
  installLargeChargers(scn);
  installRfidPads(scn);
  installEvsePlates(scn);
  installUnitPlates(scn);
  installChargerModel(scn);
  installStationModel(scn);
  installMerge(scn);
  scn.addScreenMessage = () => undefined;
  scn.evSignTexture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  scn.warningTexture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  scn.virtualSignSprite = (kind, id) => {
    const sprite = new THREE.Sprite();
    sprite.userData['virtualSign'] = id;
    sprite.userData['kind'] = kind;
    return sprite;
  };
  return scn;
}

function station(over: Partial<SceneStation>): SceneStation {
  return {
    id: 'sta_m',
    bay: { col: 1, row: 0 },
    lightColor: STATUS_COLORS['charging'] ?? '#22c55e',
    lit: true,
    pulsing: false,
    glow: false,
    wall: false,
    prop: null,
    terminals: [],
    blinking: false,
    kind: 'ac',
    cables: [1],
    evseConnectors: [1],
    connectorKinds: [['type1']],
    ...over,
  };
}

function build(s: SceneStation, lot: Partial<Lot> = {}) {
  const scn = sceneCtx(lotOf(lot));
  const palette = SCENE_COLORS.light;
  return { obj: scn.buildModel(s, palette, scn.templates(palette)), scn };
}

describe('station model', () => {
  it('places the group at its pose and marks every part with the station id', () => {
    const { obj } = build(station({}));
    expect(obj.group.position.toArray()).toEqual([3, 0, 4]);
    expect(obj.group.rotation.y).toBeCloseTo(Math.PI / 2);
    obj.group.traverse((o) => {
      expect(o.userData['stationId']).toBe('sta_m');
    });
    expect(obj.ring.userData['ring']).toBe(true);
    expect(obj.ring.material.opacity).toBe(0);
    expect(obj.handle).toBeNull();
    expect(obj.virtualSign).toBeNull();
  });

  it('mounts each card reader where its interface is in reach, scaled for the site, by its id', () => {
    const terminals = [
      { id: 'trm_left', side: -1 as const, hasDisplay: true, online: true },
      { id: 'trm_whole', side: 0 as const, hasDisplay: false, online: false },
    ];
    const { obj } = build(station({ terminals }));
    const readers: THREE.Object3D[] = [];
    obj.group.traverse((o) => {
      if (typeof o.userData['terminalId'] === 'string') readers.push(o);
    });
    expect(readers.map((r) => r.userData['terminalId'])).toEqual(['trm_left', 'trm_whole']);
    terminals.forEach((t, i) => {
      const at = readerMount('ac', false, t.side, i, wallBoxOffset(), 1, 1);
      const r = readers[i];
      expect(r?.position.x).toBeCloseTo(at.x);
      expect(r?.position.y).toBeCloseTo(at.y);
      expect(r?.position.z).toBeCloseTo(at.z);
      expect(r?.scale.x).toBeCloseTo(READER_SCENE_SCALE);
    });
    expect(readers[0]?.userData['model']).toBe('reader-screen');
    expect(readers[1]?.userData['model']).toBe('reader-contactless');
  });

  it('stands a maintenance cone in the spot, at a curb in the parking lane in front of the post', () => {
    const lot = build(station({ prop: 'cone', carOffsetX: 1.3 }));
    const cone = lot.obj.group.children.find((c) => c.position.z === 2.2);
    expect(cone?.position.x).toBeCloseTo(0.15 + 1.3);
    const curb = build(station({ prop: 'cone' }), { siteType: 'curbside', rowLengths: [2, 2] });
    const cones = curb.obj.group.children.filter(
      (c) => c.position.x === 2.2 && c.position.z === CURB_POST_BACK_M + 1.2,
    );
    expect(cones).toHaveLength(1);
  });

  it('floats the virtual sign over the spot, the parking lane at a curb, or the middle of a bay', () => {
    const lot = build(station({ virtualSign: 'reserved', carOffsetX: 1.3 }));
    expect(lot.obj.virtualSign?.position.toArray()).toEqual([1.3, VIRTUAL_SIGN_Y_M, 2.6]);
    expect(lot.obj.virtualSign?.userData['kind']).toBe('reserved');
    const pair = build(
      station({
        virtualSign: 'maintenance',
        carOffsetX: 1.3,
        stallCars: [null, null],
        stalls: [
          { x: -1.3, width: 2.6 },
          { x: 1.3, width: 2.6 },
        ],
      }),
    );
    expect(pair.obj.virtualSign?.position.x).toBe(0);
    const curb = build(station({ virtualSign: 'reserved' }), {
      siteType: 'curbside',
      rowLengths: [2, 2],
    });
    expect(curb.obj.virtualSign?.position.toArray()).toEqual([
      2.2,
      VIRTUAL_SIGN_Y_M,
      CURB_POST_BACK_M + 1.2,
    ]);
    const bay = build(
      station({
        kind: 'dc',
        charger: 'bus_dispenser',
        free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
        virtualSign: 'reserved',
        connectorKinds: [['ccs1']],
      }),
      { siteType: 'custom' },
    );
    const rect = freeSpotRects(1, 'bus_bay')[0];
    if (rect == null) throw new Error('no bay');
    expect(bay.obj.virtualSign?.position.x).toBeCloseTo((rect.minX + rect.maxX) / 2);
    expect(bay.obj.virtualSign?.position.y).toBeCloseTo(VIRTUAL_SIGN_Y_M + 1.5);
    expect(bay.obj.virtualSign?.position.z).toBeCloseTo((rect.minZ + rect.maxZ) / 2);
  });

  it('gives a station on a custom site its rotation handle, hidden until selected', () => {
    const { obj } = build(
      station({ free: { x: 0, z: 0, rotationDeg: 0, spotType: 'car' }, spots: 2 }),
      { siteType: 'custom' },
    );
    expect(obj.handle).not.toBeNull();
    expect(obj.handle?.visible).toBe(false);
    obj.handle?.traverse((o) => {
      expect(o.userData['rotateHandle']).toBe('sta_m');
    });
  });

  it('puts a bus in each bay of a dual-outlet bus charger with a plug in', () => {
    const bus = sceneCar({ color: null, bodyType: 'bus' });
    const { obj } = build(
      station({
        kind: 'dc',
        charger: 'bus_dispenser',
        free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
        spots: 2,
        evseConnectors: [1, 1],
        cables: [1, 1],
        connectorKinds: [['ccs1'], ['ccs1']],
        stallCars: [bus, bus],
        stallFlows: [true, false],
        stallPlugged: [0, 0],
        pluggedSlot: { evse: 1, connector: 0 },
        prop: 'car',
      }),
      { siteType: 'custom' },
    );
    // A plugged handle per outlet, each in its own bus.
    const plugged: THREE.Object3D[] = [];
    obj.group.traverse((o) => {
      if (o.userData['plugged'] === true) plugged.push(o);
    });
    expect(plugged).toHaveLength(2);
    const bays = freeSpotRects(2, 'bus_bay');
    expect(bays).toHaveLength(2);
    // The avatar floats over the station session's bus, in the second bay.
    const second = bays[1];
    if (second == null || obj.avatarAnchor == null) throw new Error('no anchor');
    expect(obj.avatarAnchor.x).toBeGreaterThan(second.minX - 0.5);
    expect(obj.avatarAnchor.x).toBeLessThan(second.maxX + 0.5);
  });

  it('parks a car in each spot of a two-port curb post, the avatar over the session car', () => {
    const car = sceneCar(null);
    const { obj } = build(
      station({
        curbPair: true,
        evseConnectors: [1, 1],
        cables: [1, 1],
        connectorKinds: [['type1'], ['type1']],
        stallCars: [car, car],
        stallFlows: [true, true],
        stallPlugged: [0, 0],
        pluggedSlot: { evse: 0, connector: 0 },
        prop: 'car',
      }),
      { siteType: 'curbside', rowLengths: [2, 2] },
    );
    expect(obj.avatarAnchor).not.toBeNull();
    // The left spot's car (EVSE 1) is on the left of the post.
    expect(obj.avatarAnchor?.x ?? 0).toBeLessThan(0);
  });
});
