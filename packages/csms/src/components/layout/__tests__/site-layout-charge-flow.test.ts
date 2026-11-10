// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { STATUS_COLORS } from '@/lib/chart-theme';
import {
  CAR_PORTS,
  CHARGE_FLOW,
  parksBackedIn,
  chargeFlowCoreRadius,
  chargeFlowHaloRadius,
  chargeFlowOffset,
  connectorFlows,
  evseFlows,
} from '../site-layout-cable';
import { sceneCar } from '../site-layout-car';
import { SCENE_COLORS } from '../site-layout-colors';
import { CONNECTOR_SPECS, type ConnectorKind } from '../site-layout-connectors';
import { ENGLISH_SIGN_TEXTS } from '../site-layout-signs';
import { installCables } from '../site-layout-scene-cables';
import { installChargerModel } from '../site-layout-scene-charger-model';
import { installConnectors } from '../site-layout-scene-connectors';
import type { SceneCtx } from '../site-layout-scene-context';
import { installDressing } from '../site-layout-scene-dressing';
import { installFreeSpots } from '../site-layout-scene-free-spots';
import { installKit } from '../site-layout-scene-kit';
import { installEvsePlates } from '../site-layout-scene-evse-plates';
import { installRfidPads } from '../site-layout-scene-rfid';
import { installLargeChargers } from '../site-layout-scene-large-chargers';
import { installMerge } from '../site-layout-scene-merge';
import { installStationModel } from '../site-layout-scene-station-model';
import { installTemplates } from '../site-layout-scene-templates';
import type { SceneLayout, SceneStation } from '../site-layout-scene-types';

// Every charging cable of the 3D view carries the charge flow (the light tube and its halo)
// while its connector charges or discharges, and only then (owner rule 2026-11-02).

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

/** The scene context the station builder needs, without a renderer or a DOM canvas. */
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
  scn.poseOf = () => ({ point: { x: 0, z: 0 }, turn: 0 });
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
  installChargerModel(scn);
  installStationModel(scn);
  installMerge(scn);
  // The canvas parts (screen text, signs, logo) need a 2D context the test DOM lacks.
  scn.addScreenMessage = () => undefined;
  scn.evSignTexture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  scn.warningTexture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  scn.virtualSignSprite = () => new THREE.Sprite();
  return scn;
}

interface Case {
  name: string;
  lot?: Partial<Lot>;
  station: Partial<SceneStation> & Pick<SceneStation, 'kind'>;
  /** Cables to the vehicles: one per car the station draws. */
  cables: number;
}

const DC: ConnectorKind[] = ['ccs1', 'chademo'];
const CASES: Case[] = [
  {
    name: 'DC dispenser holster plug',
    station: { kind: 'dc', cables: [2], evseConnectors: [2], connectorKinds: [DC] },
    cables: 1,
  },
  {
    name: 'AC pedestal',
    station: { kind: 'ac', cables: [1], evseConnectors: [1], connectorKinds: [['type1']] },
    cables: 1,
  },
  {
    name: 'AC curb post',
    lot: { siteType: 'curbside', rowLengths: [2, 2] },
    station: { kind: 'ac', cables: [1], evseConnectors: [1], connectorKinds: [['type1']] },
    cables: 1,
  },
  {
    name: 'AC wall box',
    lot: { siteType: 'office_retail', mounting: 'wall' },
    station: {
      kind: 'ac',
      wall: true,
      cables: [1],
      evseConnectors: [1],
      connectorKinds: [['type1']],
    },
    cables: 1,
  },
  {
    name: 'split satellites, one per EVSE',
    station: {
      kind: 'dc',
      dispensers: [-1.3, 1.3],
      stalls: [
        { x: -1.3, width: 2.6 },
        { x: 1.3, width: 2.6 },
      ],
      cables: [1, 1],
      connectorKinds: [['ccs1'], ['ccs1']],
    },
    cables: 2,
  },
  {
    name: 'bus dispenser arm drape',
    station: {
      kind: 'dc',
      charger: 'bus_dispenser',
      free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
      car: sceneCar({ color: null, bodyType: 'bus' }),
      connectorKinds: [['ccs1']],
    },
    cables: 1,
  },
  {
    name: 'MCS arm cable',
    station: {
      kind: 'dc',
      charger: 'truck_mcs',
      free: { x: 0, z: 0, rotationDeg: 0, spotType: 'truck_pull_through' },
      car: sceneCar({ color: null, bodyType: 'semi_truck' }),
      connectorKinds: [['mcs']],
    },
    cables: 1,
  },
  {
    name: 'standard charger in a bus bay, routed on the ground',
    station: {
      kind: 'dc',
      charger: 'standard',
      free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
      car: sceneCar({ color: null, bodyType: 'bus' }),
      connectorKinds: [['ccs1']],
    },
    cables: 1,
  },
  {
    name: 'depot pantograph lowered onto the bus roof rails, down its linkage',
    station: {
      kind: 'dc',
      charger: 'pantograph_down',
      free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
      car: sceneCar({ color: null, bodyType: 'bus' }),
      connectorKinds: [['ccs1']],
    },
    cables: 1,
  },
  {
    name: 'bus roof pantograph raised into the contact hood, down its arm',
    station: {
      kind: 'dc',
      charger: 'pantograph_up',
      free: { x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' },
      car: sceneCar({ color: null, bodyType: 'bus' }),
      connectorKinds: [['ccs1']],
    },
    cables: 1,
  },
];

const PANTOGRAPHS = new Set(['pantograph_down', 'pantograph_up']);

function stationOf(c: Case, flowing: boolean[]): SceneStation {
  const twoStalls = c.station.stalls != null && c.station.stalls.length > 1;
  return {
    id: `flow:${c.name}`,
    bay: { col: 1, row: 0 },
    lightColor: STATUS_COLORS['charging'] ?? '#22c55e',
    lit: true,
    pulsing: flowing.some(Boolean),
    glow: false,
    wall: false,
    prop: 'car',
    terminals: [],
    blinking: false,
    ...c.station,
    ...(twoStalls
      ? {
          stallCars: c.station.stalls?.map(() => sceneCar(null)),
          stallFlows: flowing,
          stallPlugged: c.station.stalls?.map(() => 0),
        }
      : { cableFlow: flowing[0] ?? false }),
  };
}

function flowMeshes(g: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData['chargeFlow'] === true) out.push(o);
  });
  return out;
}

function build(c: Case, flowing: boolean[]): { group: THREE.Group; scn: SceneCtx } {
  const scn = sceneCtx(lotOf(c.lot));
  const palette = SCENE_COLORS.light;
  const obj = scn.buildModel(stationOf(c, flowing), palette, scn.templates(palette));
  return { group: obj.group, scn };
}

describe('charge flow on every charging cable', () => {
  for (const c of CASES) {
    it(`${c.name}: the light tube and halo while charging, none while idle`, () => {
      const charging = build(
        c,
        Array.from({ length: c.cables }, () => true),
      );
      // A core and a halo per cable to a vehicle, each with a moving texture.
      expect(flowMeshes(charging.group), c.name).toHaveLength(2 * c.cables);
      expect(charging.scn.chargeFlowTextures.length, c.name).toBe(c.cables);

      const idle = build(
        c,
        Array.from({ length: c.cables }, () => false),
      );
      expect(flowMeshes(idle.group), c.name).toHaveLength(0);
      expect(idle.scn.chargeFlowTextures, c.name).toHaveLength(0);
    });
  }

  it('glows where a charging pantograph head meets the rails, and only then', () => {
    const glows = (g: THREE.Object3D): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData['chargeContact'] === true) out.push(o);
      });
      return out;
    };
    for (const c of CASES) {
      const pantograph = PANTOGRAPHS.has(c.station.charger ?? '');
      const lit = glows(build(c, [true]).group);
      expect(lit, c.name).toHaveLength(pantograph ? 1 : 0);
      expect(glows(build(c, [false]).group), c.name).toHaveLength(0);
      for (const glow of lit) {
        // Up at the roof rails or the hood, in the charging color, steady (no moving texture).
        expect(glow.position.y, c.name).toBeGreaterThan(3);
        const material = glow.material as THREE.MeshBasicMaterial;
        expect(`#${material.color.getHexString()}`, c.name).toBe(CHARGE_FLOW.color.toLowerCase());
        expect(material.map, c.name).toBeNull();
      }
    }
  });

  it('lights only the second EVSE of a dual-port pedestal that charges', () => {
    const dual: Case = {
      name: 'AC dual-port pedestal',
      station: {
        kind: 'ac',
        stalls: [
          { x: -1.3, width: 2.6 },
          { x: 1.3, width: 2.6 },
        ],
        shiftX: 1.3,
        cables: [2],
        evseConnectors: [1, 1],
        connectorKinds: [['type1'], ['type1']],
      },
      cables: 2,
    };
    expect(flowMeshes(build(dual, [true, true]).group)).toHaveLength(4);
    const second = build(dual, [false, true]).group;
    expect(flowMeshes(second)).toHaveLength(2);
    const first = build(dual, [true, false]).group;
    expect(flowMeshes(first)).toHaveLength(2);
    // The lit cable is the one to the car in the stall of that EVSE: the second stall
    // (x > 0) reaches its car's port, the first stays left of the pair line.
    const maxX = (g: THREE.Group): number =>
      Math.max(...flowMeshes(g).map((m) => new THREE.Box3().setFromObject(m).max.x));
    expect(maxX(second)).toBeGreaterThan(0.1);
    expect(maxX(first)).toBeLessThan(0.1);
  });

  it('keeps the flow tubes out of the merged meshes of a large site', () => {
    const c = CASES[0] as Case;
    const scn = sceneCtx(lotOf(c.lot));
    const palette = SCENE_COLORS.light;
    const obj = scn.buildModel(stationOf(c, [true]), palette, scn.templates(palette));
    scn.site.add(obj.group);
    scn.objects.set(obj.station.id, obj);
    scn.mergeStations();
    // Both tubes stay on the station with their own texture, so the light keeps moving.
    expect(flowMeshes(obj.group)).toHaveLength(2);
  });

  it('draws the halo outside the light tube and the light tube outside every cable', () => {
    for (const spec of Object.values(CONNECTOR_SPECS)) {
      const r = spec.cableDiameterM / 2;
      expect(chargeFlowCoreRadius(r)).toBeGreaterThan(r);
      expect(chargeFlowHaloRadius(r)).toBeGreaterThan(chargeFlowCoreRadius(r));
    }
    expect(chargeFlowHaloRadius(0.011)).toBe(CHARGE_FLOW.haloM);
  });

  it('keeps the light still with reduced motion and moves it toward the vehicle otherwise', () => {
    expect(chargeFlowOffset(null)).toBe(0);
    expect(chargeFlowOffset(1)).toBeLessThan(0);
  });
});

describe('dual-port pedestal cables', () => {
  // Each stall's cable keeps to its own side of the pedestal line, clear of the other stall,
  // its cable and its car, for every charge port (a rear port backs the car in).
  const STALL_W = 2.6;
  const dualStation = (port: (typeof CAR_PORTS)[number], flowing: boolean[]): SceneStation => ({
    id: `dual:${port}`,
    kind: 'ac',
    bay: { col: 1, row: 0 },
    lightColor: STATUS_COLORS['charging'] ?? '#22c55e',
    lit: true,
    pulsing: true,
    glow: false,
    wall: false,
    prop: 'car',
    terminals: [],
    blinking: false,
    stalls: [
      { x: -STALL_W / 2, width: STALL_W },
      { x: STALL_W / 2, width: STALL_W },
    ],
    shiftX: STALL_W / 2,
    cables: [2],
    evseConnectors: [1, 1],
    connectorKinds: [['type1'], ['type1']],
    stallCars: [
      { ...sceneCar(null), port },
      { ...sceneCar(null), port },
    ],
    stallFlows: flowing,
    stallPlugged: [0, 0],
  });
  const xRange = (station: SceneStation): [number, number] => {
    const scn = sceneCtx(lotOf());
    const palette = SCENE_COLORS.light;
    const g = scn.buildModel(station, palette, scn.templates(palette)).group;
    g.updateMatrixWorld(true);
    const box = new THREE.Box3();
    // The light tube follows the cable centerline (lit for this stall only).
    for (const m of flowMeshes(g)) {
      if (
        m.material instanceof THREE.MeshBasicMaterial &&
        m.material.blending === THREE.AdditiveBlending
      )
        continue;
      box.union(new THREE.Box3().setFromObject(m));
    }
    return [box.min.x, box.max.x];
  };
  // The light tube is at least 18 mm in radius around the cable centerline.
  const tube = 0.02;

  for (const port of CAR_PORTS) {
    it(`${port} (${parksBackedIn(port) ? 'backed in' : 'nose in'}): each cable stays in its own stall`, () => {
      const [firstMin, firstMax] = xRange(dualStation(port, [true, false]));
      expect(firstMax, `${port} first stall`).toBeLessThanOrEqual(tube);
      expect(firstMin, `${port} first stall`).toBeGreaterThanOrEqual(-STALL_W - tube);
      const [secondMin, secondMax] = xRange(dualStation(port, [false, true]));
      expect(secondMin, `${port} second stall`).toBeGreaterThanOrEqual(-tube);
      expect(secondMax, `${port} second stall`).toBeLessThanOrEqual(STALL_W + tube);
    });
  }
});

describe('which connector carries the flow', () => {
  const ALL = [
    'available',
    'occupied',
    'reserved',
    'unavailable',
    'faulted',
    'charging',
    'preparing',
    'suspended_ev',
    'suspended_evse',
    'finishing',
    'idle',
    'discharging',
    'ev_connected',
  ];

  it('flows while charging or discharging, never while suspended, idle, finishing or down', () => {
    for (const status of ALL) {
      expect(connectorFlows(status), status).toBe(
        status === 'charging' || status === 'discharging',
      );
    }
  });

  it('shows no flow on any other status, an open session included (Available, Occupied)', () => {
    expect(evseFlows({ connectors: [{ status: 'available' }] })).toBe(false);
    expect(evseFlows({ connectors: [{ status: 'occupied' }] })).toBe(false);
    expect(evseFlows({ connectors: [{ status: 'suspended_ev' }] })).toBe(false);
    expect(evseFlows({ connectors: [{ status: 'available' }, { status: 'charging' }] })).toBe(true);
  });
});

// Owner requirement 2026-11-10: after the cable, gland and wall box rework the
// charge flow still shows on every charging cable of every reworked charger
// and port, follows the charging route from its gland to the vehicle, and is
// absent while the connector is plugged in but suspended.
describe('the charge flow follows every reworked charging route', () => {
  const STALLS = [
    { x: -1.3, width: 2.6 },
    { x: 1.3, width: 2.6 },
  ];
  const ROUTE_CASES: Array<Case & { lengthM?: number }> = [
    {
      name: 'DC dispenser, one EVSE, two cables',
      station: { kind: 'dc', cables: [2], evseConnectors: [2], connectorKinds: [DC] },
      cables: 1,
      lengthM: 3.6,
    },
    {
      name: 'DC dispenser, two EVSEs, one cable each (the 6 m cable)',
      station: {
        kind: 'dc',
        stalls: STALLS,
        cables: [2],
        evseConnectors: [1, 1],
        connectorKinds: [['ccs1'], ['ccs1']],
      },
      cables: 2,
      lengthM: 6,
    },
    {
      name: 'DC dispenser, two EVSEs, four cables (the 6 m cable)',
      station: {
        kind: 'dc',
        stalls: STALLS,
        cables: [4],
        evseConnectors: [2, 2],
        connectorKinds: [DC, DC],
      },
      cables: 2,
      lengthM: 6,
    },
    {
      name: 'split satellites, one per EVSE',
      station: {
        kind: 'dc',
        dispensers: [-1.3, 1.3],
        stalls: STALLS,
        cables: [2, 2],
        connectorKinds: [DC, DC],
      },
      cables: 2,
    },
    {
      name: 'AC pedestal, one port',
      station: { kind: 'ac', cables: [1], evseConnectors: [1], connectorKinds: [['type1']] },
      cables: 1,
      lengthM: 5.79,
    },
    {
      name: 'AC pedestal, two ports',
      station: {
        kind: 'ac',
        stalls: STALLS,
        shiftX: 1.3,
        cables: [2],
        evseConnectors: [1, 1],
        connectorKinds: [['type1'], ['type1']],
      },
      cables: 2,
      lengthM: 5.79,
    },
    {
      name: 'AC curb post',
      lot: { siteType: 'curbside', rowLengths: [2, 2] },
      station: { kind: 'ac', cables: [1], evseConnectors: [1], connectorKinds: [['type1']] },
      cables: 1,
    },
    {
      name: 'wall box, one port',
      lot: { siteType: 'office_retail', mounting: 'wall' },
      station: {
        kind: 'ac',
        wall: true,
        cables: [1],
        evseConnectors: [1],
        connectorKinds: [['type1']],
      },
      cables: 1,
      lengthM: 7.62,
    },
    {
      name: 'wall box, two ports',
      lot: { siteType: 'office_retail', mounting: 'wall' },
      station: {
        kind: 'ac',
        wall: true,
        stalls: STALLS,
        cables: [2],
        evseConnectors: [1, 1],
        connectorKinds: [['type1'], ['type1']],
      },
      cables: 2,
      lengthM: 7.62,
    },
  ];

  /** The light tube cores (not the additive halos) and the cable tube each lies on. */
  function coresWithCables(g: THREE.Object3D): Array<{ core: THREE.Mesh; cable: THREE.Mesh }> {
    const out: Array<{ core: THREE.Mesh; cable: THREE.Mesh }> = [];
    g.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData['chargeFlow'] !== true) return;
      const m = o.material as THREE.MeshBasicMaterial;
      if (m.blending === THREE.AdditiveBlending) return;
      // chargingCable: a group of the cable tube and the flow group (halo, core).
      const cableGroup = o.parent?.parent;
      const cable = cableGroup?.children.find(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry instanceof THREE.TubeGeometry,
      );
      if (cable != null) out.push({ core: o, cable });
    });
    return out;
  }
  const pathOf = (m: THREE.Mesh): THREE.Curve<THREE.Vector3> =>
    (m.geometry as THREE.TubeGeometry).parameters.path;

  for (const c of ROUTE_CASES) {
    it(`${c.name}: the flow runs the whole charging route, none while suspended`, () => {
      const all = Array.from({ length: c.cables }, () => true);
      const charging = build(c, all).group;
      const pairs = coresWithCables(charging);
      expect(pairs, c.name).toHaveLength(c.cables);
      for (const { core, cable } of pairs) {
        const flow = pathOf(core);
        const route = pathOf(cable);
        // From the charger to the vehicle, end to end on the cable's own centerline.
        expect(flow.getPoint(0).distanceTo(route.getPoint(0)), c.name).toBeLessThan(1e-6);
        expect(flow.getPoint(1).distanceTo(route.getPoint(1)), c.name).toBeLessThan(1e-6);
        expect(flow.getPoint(0.5).distanceTo(route.getPoint(0.5)), c.name).toBeLessThan(1e-6);
        if (c.lengthM != null) {
          expect(Math.abs(route.getLength() - c.lengthM) / c.lengthM, c.name).toBeLessThan(0.03);
        }
      }
      // Plugged in but suspended: the cables to the vehicles stay, the flow does not.
      const suspended = build(
        c,
        all.map(() => false),
      ).group;
      expect(flowMeshes(suspended), c.name).toHaveLength(0);
      if (c.cables > 1) {
        // One port charging, the other suspended: one flow, on its own cable only.
        const one = build(
          c,
          all.map((_, i) => i === 0),
        ).group;
        expect(coresWithCables(one), c.name).toHaveLength(1);
      }
    });
  }
});
