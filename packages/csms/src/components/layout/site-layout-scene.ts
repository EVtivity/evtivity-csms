// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The three.js scene of the 3D site layout: a paved lot with painted parking
// spots and a curb on an endless grass ground, a concrete pad per station
// with a DC fast charger or AC pedestal model built in code, pad-mounted
// transformers on the grass (parking lot), the building with AC wall boxes on
// its facade (office or retail), one panel model per load management panel
// (a switchboard cabinet on a pad, or a panel on the facade) with the links to
// its circuits and stations, a glow on the front of every charging station,
// and the company logo on the back of every charger.
// Only SiteLayout3D imports this module, and SiteLayout loads SiteLayout3D
// with React.lazy, so three.js stays out of every other chunk.
//
// Spot (col, row) is grid slot (col, row) of the 2D board
// (@evtivity/lib/site-layout). The lot geometry, framing, zoom limit and fog
// live in site-layout-grid.ts, the links in site-layout-links.ts. Everything
// on the site is a child of one group turned by the facing.
//
// A custom site has no lot, street or building: each station stands at its
// free position (`SceneStation.free`) on grass, with its own parking spots on
// a paved apron. In Edit Layout a station drags freely (snapped, alignment
// guides, refused over another station's spots) and turns by a handle in
// front of its spots; the active display message shows on every lit
// charger screen (`SceneStation.message`).
//
// A depot is a paved yard (`buildDepotYard`): the bus bays with their lines
// and the head strip, the truck pull-through lanes with their islands, edge
// lines and arrows, the one-way roads into and out of them and the two-way
// drive lane. Each station stands in its slot's bay or lane
// (`SceneStation.free` from `depotSlotPlacement`, never dragged freely): a
// depot pantograph pole or dispenser in a bus bay, a megawatt dispenser on a
// truck lane island.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  freeSpotRects,
  freeFootprint,
  freeSpotsExtent,
  freeSpotTypeOf,
  FREE_LAYOUT,
  EV_SIGNS,
  WHEEL_STOP,
  SPLIT_SYSTEM,
  type DepotLayout,
  type FreePlacement,
  type FreeSpotRect,
  type LayoutBay,
} from '@evtivity/lib/site-layout';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import { SCENE_COLORS } from './site-layout-colors';
import {
  CAR_PROFILES,
  isLargeBodyType,
  sceneCar,
  vehicleSize,
  type SceneCar,
} from './site-layout-car';
import type { CarKit } from './site-layout-car-geometry';
import { createVehicleKit } from './site-layout-vehicle-kit';
import type { FreeChargerModel } from './site-layout-free';
import {
  BAY_LINE_GAP,
  BUILDING_HEIGHT_M,
  carNoseAtStop,
  chargerAtCurb,
  parkingRowGaps,
  rowFrontZ,
  wheelStopCenterZ,
  wheelStopMount,
  CAMERA_FOV,
  CURB_M,
  CURB_POST_BACK_M,
  FACADE_SIGN_STANDOFF_M,
  FACADE_Z,
  MAX_POLAR_ANGLE,
  clampCameraHeight,
  SIDEWALK_M,
  MIN_DISTANCE,
  OVERVIEW_CAMERA_OFFSET,
  bayToWorld as bayToLot,
  bayTurn,
  buildingBox,
  buildingFramePoints,
  beaconLevel,
  chargingGlowLevel,
  clampTarget,
  clampToLot,
  customSceneBox,
  pointsBox,
  denseFrameBox,
  handleRotation,
  NARROW_STAGE_PX,
  rotationHandleZ,
  SCREEN_MESSAGE,
  screenTextLayout,
  type AlignmentGuide,
  fitFrame,
  fogRange,
  FRONT_CAMERA_OFFSET,
  frontCamera,
  groundBox,
  layoutGroundBox,
  isSpot,
  logoFit,
  CHARGER_LOGO_PANELS,
  type ChargerLogoModel,
  maxZoomDistance,
  panBox,
  pixelsPerMeter,
  rotateBox,
  sceneBox,
  spotRect,
  wallBoxOffset,
  dispenserHolsters,
  worldToBay as lotToBay,
  type Box,
  type Lot,
  type Point,
  type StationProp,
  type VirtualSign,
  VIRTUAL_SIGN_OPACITY,
  readerMount,
} from './site-layout-grid';
import {
  EQUIPMENT_BOLLARD,
  equipmentBollards,
  equipmentPadBox,
  type EquipmentGround,
} from './site-layout-links';
import {
  ENGLISH_SIGN_TEXTS,
  SIGN_FONT_FAMILY,
  SIGN_POST_INSET_M,
  signLetterPx,
  signSupport,
  signLines,
  stationSignMount,
  type SignTexts,
  type StationSigns,
} from './site-layout-signs';
import type { AccessibleSpaceBoxes, Stall } from './site-layout-stalls';
import {
  SOLAR_CARPORT,
  carportFrame,
  carportTopY,
  clearColumnXs,
  freeColumnXs,
  rowCarport,
  type CanopyObstacle,
  type CarportFrame,
  type RowCarport,
} from './site-layout-solar';
import type { LinkKind, LoadLinks } from './site-layout-links';

/** Pixels per meter of the spot texture. */
const TEXTURE_PX_PER_M = 80;

export interface SceneTerminal {
  id: string;
  /** -1 left connector, 1 right connector, 0 the whole station. */
  side: -1 | 0 | 1;
  /** The model has its own screen (a VP7200 has none). */
  hasDisplay: boolean;
  online: boolean | null;
}

export interface SceneStation {
  id: string;
  kind: 'ac' | 'dc';
  bay: LayoutBay;
  /** The status light color (a CSS color three.js can parse). */
  lightColor: string;
  /** False for an offline station: its screen and light stay dark. */
  lit: boolean;
  /** True while charging: the light pulses unless reduced motion is on. */
  pulsing: boolean;
  /**
   * True while charging: a glowing strip around the screen or the connector,
   * in `lightColor`, pulsing gently (steady with reduced motion).
   */
  glow: boolean;
  /** An AC wall box on the building facade (office or retail with wall mounting), not a pedestal. */
  wall: boolean;
  /** What stands in the spot (`stationProp`): a car on a cable or a cone. */
  prop: StationProp;
  /** The virtual status sign over the spot (`virtualSignOf`): reserved now or in maintenance. */
  virtualSign?: VirtualSign | null | undefined;
  /** The car of a charging station (`sceneCar`); absent draws a grey sedan. */
  car?: SceneCar | undefined;
  /** Payment terminals paired to the station. */
  terminals: readonly SceneTerminal[];
  /** A faulted station: a red beacon above it, pulsing unless reduced motion is on. */
  beacon: boolean;
  /**
   * Custom site: where the station stands and its turn (its spots lie in
   * front of it). Depot: its bay or lane (`depotSlotPlacement`, with the spot
   * type), drawn the same way but moved by slot.
   */
  free?: FreePlacement | undefined;
  /** Custom site: the parking spots the station has (one per EVSE, 1 or 2). */
  spots?: number | undefined;
  /** Custom site with two car spots: the spot the car stands in, across the station (-1.3 or 1.3 m). */
  carOffsetX?: number | undefined;
  /** Custom site: the spot (0 or 1, EVSE order) the vehicle, sign or cone stands in. */
  propSpot?: number | undefined;
  /** Custom site: the charger model (`freeChargerModel`): a pantograph mast, a bus or truck dispenser, else the standard charger. */
  charger?: FreeChargerModel | undefined;
  /** The active display message, shown on the lit charger screen (null: none). */
  message?: string | null | undefined;
  /**
   * Parking lot or office or retail row: the stalls the station serves, in
   * its own frame (`stationStalls`): two for a dual-port AC pedestal on the
   * line between its spots, one widened vehicle space for the accessible
   * charging space. Absent: its own spot.
   */
  stalls?: readonly Stall[] | undefined;
  /** How far the charger stands from the middle of its spot along the row (a pedestal: on the pair line), in lot meters. */
  shiftX?: number | undefined;
  /** How far behind its spot point the charger stands, in its own z (`stationBackShift`: an AC pedestal behind the stall head). */
  backShift?: number | undefined;
  /** A dual-port pedestal: the vehicle in each stall (null: empty), EVSE order. */
  stallCars?: ReadonlyArray<SceneCar | null> | undefined;
  /**
   * A DC split system (`splitDispenserCount`, `SPLIT_SYSTEM`): the x of each
   * of its dispensers (satellites) in the station's own frame, EVSE order;
   * its power cabinet stands on the equipment pad (`withSplitCabinets`).
   */
  dispensers?: readonly number[] | undefined;
  /**
   * The connectors (holstered cables) of each dispenser, EVSE order for a
   * split system, else one entry for the station's one dispenser
   * (`dispenserHolsters`). Absent: two.
   */
  cables?: readonly number[] | undefined;
}

export interface SceneTransformer {
  id: string;
  x: number;
  z: number;
}

/**
 * A load management panel on the grass (site-layout-links.ts, placePanels): a
 * switchboard on the equipment pad, or a panelboard on a rack beside its AC
 * group.
 */
export interface ScenePanel {
  id: string;
  x: number;
  z: number;
  model: 'switchboard' | 'panelboard' | 'wall' | 'cabinet';
  /** The turn about the vertical axis, in radians (0: the front faces +z; a row end rack faces the lot edge). */
  turn: number;
}

/**
 * The panelboard on its rack beside an AC group: the nominal NEMA 3R
 * enclosure of a 225 A, 42 space panelboard interior, 20 in (0.51 m) wide,
 * 38 in (0.97 m) high and 6.5 in (0.165 m) deep (Schneider Electric NQ442L2C
 * product data sheet, June 2023,
 * https://cdn.shopify.com/s/files/1/0571/5899/2039/files/NQ442L2C_document.pdf),
 * its top 1.87 m above the pad, so the highest breaker handle stays under the
 * 6 ft 7 in (2.0 m) of NEC 240.24(A) and 404.8(A) (read in Mike Holt forum
 * threads, not the code text). On a building facade (`wallTopM`) it hangs
 * over a sidewalk, a circulation path: an object deeper than 4 in with its
 * leading edge more than 27 in above the ground breaks the protrusion limit
 * of 2010 ADA Standards 307.2
 * (https://www.access-board.gov/ada/chapter/ch03/), so its bottom stands at
 * 0.68 m (under 27 in, 0.686 m) and its top at 1.65 m. The rack and its pad
 * (1.2 by 0.6 m) have no source.
 */
const PANELBOARD = {
  widthM: 0.51,
  heightM: 0.97,
  depthM: 0.165,
  topM: 1.87,
  wallTopM: 1.65,
  padWM: 1.2,
  padDM: 0.6,
} as const;

/** A battery storage cabinet on the grass (information only). */
export interface SceneBattery {
  id: string;
  x: number;
  z: number;
}

/** A solar carport canopy over one row of the lot, or standing freely on a custom site (information only). */
export interface SceneSolar {
  id: string;
  row: number;
  /** Custom site: the middle of the canopy, its turn and size. */
  free?: (FreePlacement & { lengthM: number; depthM: number }) | undefined;
}

export interface SceneLayout {
  lot: Lot;
  stations: readonly SceneStation[];
  /** Shown on a parking lot only (the caller passes none for the other site types). */
  transformers: readonly SceneTransformer[];
  /** Battery storage on the grass (parking lot only). */
  batteries: readonly SceneBattery[];
  /** Solar canopies (parking lot only). */
  solar: readonly SceneSolar[];
  /** Load management switchboards (parking lot only). */
  panels: readonly ScenePanel[];
  links: LoadLinks;
  /** The site is in California: its stalls add the Vehicle Code 22511 tow-away sign (`site-layout-signs.ts`). */
  california?: boolean;
  /** The accessible charging space: its vehicle space and striped access aisle, in lot meters (null: none). */
  accessible?: AccessibleSpaceBoxes | null;
}

export interface SceneTheme {
  dark: boolean;
  /** The sign texts in the viewer's language (`site-layout-signs.ts` `signTexts`). */
  signs: SignTexts;
  /** The virtual Reserved and Maintenance sign colors (the CSMS state colors, CSS colors). */
  virtualColors: { reserved: string; maintenance: string };
  /** Edit grid and selection ring (a CSS color). */
  primary: string;
  /** A blocked drop (a CSS color). */
  destructive: string;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Normalized depth: smaller is nearer the camera. */
  depth: number;
  /** Distance from the camera in meters. */
  distance: number;
  /** On-screen pixels per world meter at that distance (`pixelsPerMeter`). */
  pxPerMeter: number;
  visible: boolean;
}

export interface SceneCallbacks {
  /** A click or tap on a station (null on the ground). */
  onPick: (stationId: string | null) => void;
  /** A drag in edit mode ended over this spot. */
  onDrop: (stationId: string, bay: LayoutBay) => void;
  /** Whether another station holds the spot. */
  isBayTaken: (bay: LayoutBay, exceptId: string) => boolean;
  /** Where a transformer dragged to a lot point may stand (on the grass). */
  snapTransformer: (p: Point) => Point;
  /** A transformer drag in edit mode ended at this lot point (already snapped). */
  onTransformerDrop: (transformerId: string, p: Point) => void;
  /** A battery drag in edit mode ended at this lot point (on the grass, like a transformer). */
  onBatteryDrop: (batteryId: string, p: Point) => void;
  /** Custom site: a dragged or turned position, snapped (`freeRotation`: Shift, any angle). */
  snapFree?: (p: FreePlacement, freeRotation: boolean) => FreePlacement;
  /** Custom site: whether a station there would stand on another's spots, and the alignment guides to draw. */
  freeDropState?: (
    stationId: string,
    p: FreePlacement,
  ) => { blocked: boolean; guides: AlignmentGuide[] };
  /** Custom site: a station drag or turn ended here (the caller refuses a blocked one). */
  onFreeDrop?: (stationId: string, p: FreePlacement) => void;
  /** Custom site: a solar canopy drag ended at this point (snapped). */
  onSolarDrop?: (solarId: string, p: Point) => void;
  /** Custom site in edit mode: a click on a solar canopy selects it (null: none). */
  onSolarPick?: (solarId: string | null) => void;
  /** A mouse or pen pointer over a station (null when it leaves): the station tooltip. Never on touch. */
  onHover?: (stationId: string | null) => void;
  /**
   * The power equipment whose label shows (no label is always on): a mouse or
   * pen pointer over it, or a tap on it (touch). The key is
   * `transformer:<id>`, `energy:<id>` (a battery or solar canopy) or a link
   * label id (`panel:<id>` for a switchboard or panelboard and the cable into
   * it, `circuit:<id>` for a circuit's cable run, `station:<id>` for a
   * station's branch) or `virtual:<stationId>` for a virtual status sign;
   * null when the pointer leaves it or a tap misses.
   */
  onEquipmentHover?: (key: string | null) => void;
  /** Runs after every rendered frame (labels and popup follow the models). */
  onFrame: () => void;
}

export interface SiteScene {
  setLayout: (layout: SceneLayout) => void;
  setTheme: (theme: SceneTheme) => void;
  setEditing: (editing: boolean) => void;
  setSelected: (stationId: string | null) => void;
  /** Custom site in edit mode: the selected solar canopy (outlined), or null. */
  setSelectedSolar: (solarId: string | null) => void;
  /** The company logo (a data or http(s) URL) for the back panels; null for plain panels. */
  setLogo: (url: string | null) => void;
  /**
   * The live power on the load management links, 0 to 1 by segment id
   * (`loadFlows`): brighter and thicker with more power. No rebuild.
   */
  setLinkFlow: (flow: ReadonlyMap<string, number>) => void;
  /** Where the label of a battery or solar canopy goes. */
  energyLabelPoint: (id: string) => ScreenPoint | null;
  /** Draw calls and triangles of the last frame (the large site benchmark). */
  stats: () => { calls: number; triangles: number };
  /** How far the camera stands from the point it looks at, in meters. */
  viewDistance: () => number;
  /** Turns the view to a station (keeps the camera's angle and distance). */
  focus: (stationId: string) => void;
  /** Where a driver avatar floats: above the car of a charging station, else above the charger. */
  avatarPoint: (stationId: string) => ScreenPoint | null;
  /**
   * Fit to View. `toggle`: the Fit to View button; on a narrow stage it
   * alternates the densest part of a wide site and the whole site.
   */
  fit: (toggle?: boolean) => void;
  /**
   * Renders while true. False stops the frame loop (the view is off screen or
   * the tab is hidden); true starts it again.
   */
  setActive: (active: boolean) => void;
  /** Where above a station its label goes, in px of the container. */
  labelPoint: (stationId: string) => ScreenPoint | null;
  /** Where above a transformer its label goes. */
  transformerLabelPoint: (transformerId: string) => ScreenPoint | null;
  /** Where a link label goes. */
  linkLabelPoint: (labelId: string) => ScreenPoint | null;
  /** Where the time window of a station's virtual status sign goes (null: none). */
  virtualSignPoint: (stationId: string) => ScreenPoint | null;
  dispose: () => void;
}

type Disposable = { dispose: () => void };

interface StationObject {
  group: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  light: THREE.MeshStandardMaterial;
  /** The charging glow: the strip and its halo (null when not charging). */
  glow: { strip: THREE.MeshStandardMaterial; halo: THREE.MeshBasicMaterial } | null;
  top: number;
  /** Where the label goes along the station's own z (a wall box hangs behind its spot). */
  labelZ: number;
  /** Above the middle of the car roof (station frame), or null without a car. */
  avatarAnchor: THREE.Vector3 | null;
  /** The virtual status sign (a sprite facing the camera), or null. */
  virtualSign: THREE.Sprite | null;
  /** Custom site: the rotation handle in front of the spots (shown on the selected station in Edit Layout). */
  handle: THREE.Group | null;
  station: SceneStation;
}

/** The meshes of one load management cable run, restyled by its live flow. */
interface LinkMeshes {
  core: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  curve: THREE.CurvePath<THREE.Vector3>;
  /** Tube segments along the run (about one per 20 cm, so the corners stay sharp). */
  tubular: number;
  kind: LinkKind;
  /** The load it carries (`LinkSegment.flowId`). */
  flowId: string;
  /** The flow step it is drawn at (0 to 10), -1 before the first style. */
  step: number;
}

/** The virtual status sign: how wide and how high its middle floats, in meters (its opacity: VIRTUAL_SIGN_OPACITY). */
const VIRTUAL_SIGN_WIDTH_M = 2.3;
const VIRTUAL_SIGN_Y_M = 2.4;

/** How far above the car roof a driver avatar floats, in meters. */
const AVATAR_ABOVE_ROOF_M = 0.5;

/**
 * Height of the load management cable runs above the ground, in meters: just
 * above the paving and its markings, so they never z-fight with them.
 */
export const LINK_Y = 0.08;
/** Height of a panel label, in meters. */
const PANEL_LABEL_Y = 2.75;

/** From this many stations, the fixed parts of the station models are merged (outside Edit Layout). */
export const MERGE_STATIONS_FROM = 60;

/** The distance from `p` to the segment from `a` to `b`, on the ground. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function mergesStations(stationCount: number): boolean {
  return stationCount >= MERGE_STATIONS_FROM;
}

/**
 * A copy of a geometry as plain triangles with a position, a normal and a uv
 * each (uv 0 where it had none), ready to concatenate; null for a geometry
 * that is not triangles with positions.
 */
function flatGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry | null {
  if (!source.hasAttribute('position')) return null;
  const g = source.index != null ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.hasAttribute('normal')) g.computeVertexNormals();
  if (!g.hasAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.clearGroups();
  return g;
}

/** One geometry from plain triangle geometries (flatGeometry). */
function concatGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'uv'] as const;
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = name === 'uv' ? 2 : 3;
    const total = parts.reduce((n, p) => n + p.getAttribute(name).count * size, 0);
    const data = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
      const attr = p.getAttribute(name);
      for (let i = 0; i < attr.count; i++) {
        data[offset++] = attr.getX(i);
        data[offset++] = attr.getY(i);
        if (size === 3) data[offset++] = attr.getZ(i);
      }
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(data, size));
  }
  out.computeBoundingSphere();
  return out;
}

const LOGO_PADDING = 0.03;

/** Loads a logo as a canvas (SVG rasterized), or null when it cannot load. */
function loadLogoCanvas(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // A logo on another origin needs CORS, or the canvas could not feed WebGL.
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      const scale = 512 / Math.max(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (ctx == null) {
        resolve(null);
        return;
      }
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Reading a pixel throws on a tainted canvas (a cross-origin logo without CORS).
        ctx.getImageData(0, 0, 1, 1);
        resolve(canvas);
      } catch (err) {
        console.warn('The company logo cannot be drawn on the 3D chargers', err);
        resolve(null);
      }
    };
    img.onerror = () => {
      console.warn('The company logo did not load for the 3D chargers');
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Where Fit to View puts the camera: `overview` looks down on the site from
 * the front right of the view (the Layout tab), `front` stands lower in front
 * of the chargers, turned with the facing (the dashboard widget, frontCamera),
 * still above the lowest orbit (MAX_POLAR_ANGLE).
 */
export type SceneCameraView = 'overview' | 'front';

export function createSiteScene(
  container: HTMLElement,
  options: { reducedMotion: boolean; view?: SceneCameraView },
  callbacks: SceneCallbacks,
): SiteScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.setAttribute('data-testid', 'site-layout-3d-canvas');
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !options.reducedMotion;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.minDistance = MIN_DISTANCE;
  // Panning moves along the ground, like a map, so the view never lifts off the site.
  controls.screenSpacePanning = false;
  controls.maxDistance = 400;
  const fog = new THREE.Fog(0xffffff, 100, 400);
  scene.fog = fog;

  // Reflections for the glossy car paint, glass and cabinets: a room
  // environment prefiltered once (no external files), disposed with the scene.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = environment;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  // A softer shadow edge (PCF filter radius).
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  // The car geometries of each body type (site-layout-car-geometry.ts), built
  // on first use and shared by every car of the type for the scene's life.
  const carKits = new Map<VehicleBodyType, CarKit>();
  function carKit(bodyType: VehicleBodyType): CarKit {
    let kit = carKits.get(bodyType);
    if (kit == null) {
      kit = createVehicleKit(bodyType);
      carKits.set(bodyType, kit);
    }
    return kit;
  }

  // Everything built per rebuild, disposed on the next one.
  let built: Disposable[] = [];
  const track = <T extends Disposable>(item: T): T => {
    built.push(item);
    return item;
  };
  const M = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    track(new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...extra }));
  const shadowed = <T extends THREE.Mesh>(mesh: T): T => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const box = (w: number, h: number, d: number, material: THREE.Material | THREE.Material[]) =>
    shadowed(new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), material));
  const cylinder = (r: number, h: number, segments: number, material: THREE.Material) =>
    shadowed(new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, h, segments)), material));
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
  function cable(
    points: Array<[number, number, number]>,
    material: THREE.Material,
    radius = 0.022,
  ) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    return shadowed(
      new THREE.Mesh(track(new THREE.TubeGeometry(curve, 48, radius, 8, false)), material),
    );
  }
  function handle(material: THREE.Material) {
    const g = new THREE.Group();
    const grip = box(0.06, 0.2, 0.08, material);
    const nozzle = cylinder(0.035, 0.12, 14, material);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(0, 0.09, 0.06);
    g.add(grip, nozzle);
    return g;
  }

  let theme: SceneTheme = {
    dark: false,
    signs: ENGLISH_SIGN_TEXTS,
    virtualColors: { reserved: '#f59e0b', maintenance: '#f59e0b' },
    primary: '#2563eb',
    destructive: '#ef4444',
  };
  let layout: SceneLayout = {
    lot: {
      siteType: 'parking_lot',
      rowLengths: [10, 10],
      cols: 10,
      rows: 2,
      spotW: 2.6,
      spotD: 5.5,
      lane: 7,
      pitch: 12.5,
      width: 26,
      depth: 18,
      facing: 0,
      mounting: 'wall',
      depot: null,
    },
    stations: [],
    transformers: [],
    batteries: [],
    solar: [],
    panels: [],
    links: { segments: [], labels: [] },
  };
  let frameBox: Box = { minX: 0, maxX: 26, minZ: 0, maxZ: 18 };
  // The same box before the facing turns it (the front camera frames it).
  let siteBox: Box = frameBox;
  // The lot and its stations only (lot coordinates): the front camera frames
  // the chargers, not the transformers and panels on the grass beside them.
  let lotBox: Box = frameBox;
  let pan: Box = panBox(frameBox);
  let editing = false;
  let selected: string | null = null;
  let selectedSolar: string | null = null;
  // Fit to View on a narrow stage alternates the densest part and the whole site.
  let lastFitDense = false;
  let logo: { texture: THREE.CanvasTexture; width: number; height: number } | null = null;
  let logoUrl: string | null = null;
  const objects = new Map<string, StationObject>();
  const transformerObjects = new Map<string, THREE.Group>();
  const batteryObjects = new Map<string, THREE.Group>();
  const solarObjects = new Map<string, THREE.Group>();
  // Scrolling display messages on charger screens (texture and its speed per second).
  const screenScrolls: Array<{ texture: THREE.Texture; speed: number }> = [];
  // Alignment guides while a station of a custom site is dragged.
  const guideGroup = new THREE.Group();
  // Label points of the batteries and solar canopies (lot coordinates).
  const energyLabels = new Map<string, THREE.Vector3>();
  // The virtual status signs by station (hover shows their time window).
  const virtualSprites = new Map<string, THREE.Sprite>();
  const linkLabels = new Map<string, THREE.Vector3>();
  const flowTextures: THREE.Texture[] = [];
  // The link meshes by segment id, so the live flow restyles them without a rebuild.
  const linkMeshes = new Map<string, LinkMeshes>();
  let linkFlow: ReadonlyMap<string, number> = new Map();
  // Faulted station beacons (pulsing unless reduced motion).
  const beacons: Array<{ core: THREE.MeshStandardMaterial; halo: THREE.MeshBasicMaterial }> = [];
  const site = new THREE.Group();
  const ground = new THREE.Group();
  const editGrid = new THREE.Group();
  scene.add(ground, site);

  const lotPoint = (p: Point, y = 0) => new THREE.Vector3(p.x, y, p.z);

  // Where a station stands and its turn about the vertical axis: its free
  // position on a custom site, else its spot (a turned row faces back).
  function poseOf(s: SceneStation): { point: Point; turn: number } {
    if (s.free != null) {
      return { point: { x: s.free.x, z: s.free.z }, turn: (-s.free.rotationDeg * Math.PI) / 180 };
    }
    const point = bayToLot(s.bay, layout.lot);
    const turn = bayTurn(s.bay, layout.lot);
    // Back along its own -z (a turned row: +z in lot meters).
    return {
      point: { x: point.x + (s.shiftX ?? 0), z: point.z - (s.backShift ?? 0) * Math.cos(turn) },
      turn,
    };
  }

  // A display message drawn for a charger screen: wrapped on the screen when
  // it fits, else one line on a wide canvas that scrolls across (`speed`, in
  // texture widths per second). Light text on the dark screen, unlit, so the
  // screen reads as lit from far away.
  function screenMessageTexture(
    text: string,
    kind: 'ac' | 'dc',
  ): { texture: THREE.CanvasTexture; speed: number | null } {
    const spec = SCREEN_MESSAGE[kind];
    const { width, height } = spec.canvas;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const background = '#0b1726';
    const ink = '#e6f2ff';
    const family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    const staticFont = Math.round(height / (spec.lines + 0.9));
    let speed: number | null = null;
    if (ctx == null) {
      canvas.width = width;
      canvas.height = height;
    } else {
      ctx.font = `600 ${String(staticFont)}px ${family}`;
      const layout = screenTextLayout(
        text,
        (t) => ctx.measureText(t).width,
        width * 0.9,
        spec.lines,
      );
      if (layout.kind === 'static') {
        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        ctx.font = `600 ${String(staticFont)}px ${family}`;
        ctx.fillStyle = ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lineHeight = staticFont * 1.18;
        const top = height / 2 - ((layout.lines.length - 1) * lineHeight) / 2;
        layout.lines.forEach((line, i) => {
          ctx.fillText(line, width / 2, top + i * lineHeight);
        });
      } else {
        // One big line: as large as the screen allows, the canvas no wider than 8192 px.
        ctx.font = `600 100px ${family}`;
        const per100 = Math.max(1, ctx.measureText(layout.text).width);
        const font = Math.max(
          24,
          Math.min(Math.round(height * 0.5), Math.floor((7600 * 100) / per100)),
        );
        ctx.font = `600 ${String(font)}px ${family}`;
        const textWidth = Math.ceil(ctx.measureText(layout.text).width);
        canvas.width = Math.min(8192, textWidth + width);
        canvas.height = height;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, height);
        ctx.font = `600 ${String(font)}px ${family}`;
        ctx.fillStyle = ink;
        ctx.textBaseline = 'middle';
        ctx.fillText(layout.text, width * 0.5, height / 2);
        // About a screen width every three seconds.
        speed = width / canvas.width / 3;
      }
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (speed != null) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.x = width / canvas.width;
    }
    return { texture, speed };
  }

  // The message on a lit charger screen: a plane just in front of the glass.
  function addScreenMessage(
    g: THREE.Group,
    s: SceneStation,
    kind: 'ac' | 'dc',
    position: [number, number, number],
  ): void {
    if (s.message == null || s.message === '' || !s.lit) return;
    const spec = SCREEN_MESSAGE[kind];
    const { texture, speed } = screenMessageTexture(s.message, kind);
    const plane = new THREE.Mesh(
      track(new THREE.PlaneGeometry(spec.width, spec.height)),
      track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })),
    );
    plane.position.set(...position);
    plane.userData['screenMessage'] = true;
    g.add(plane);
    if (speed != null) screenScrolls.push({ texture, speed });
  }

  // The spots of a station on a custom site, in its own frame (`freeSpotRects`):
  // a paved apron under the charger and its spots with a curb around it, and
  // the markings. Car spots and bus bays: a painted line on each side of each
  // spot. Truck pull-through lanes: no curb across the lane ends (trucks drive
  // through), a solid line along each lane edge, an entry and an exit arrow,
  // and a raised island under each dispenser with a bollard at each end.
  function addFreeSpots(g: THREE.Group, s: SceneStation, palette: Palette): void {
    // A depot paints every bay and lane on its yard, taken or not (buildDepotYard).
    if (layout.lot.depot != null) return;
    const spotType = freeSpotTypeOf(s.free);
    const e = freeSpotsExtent(s.spots ?? 1, spotType);
    const rects = freeSpotRects(s.spots ?? 1, spotType);
    const truck = spotType === 'truck_pull_through';
    const apron = FREE_LAYOUT.apronM;
    const behind = truck ? 0 : 0.9;
    const left = e.minX - apron;
    const right = e.maxX + apron;
    const w = right - left;
    const cx = (left + right) / 2;
    const front = Math.min(e.front, -behind) - apron;
    const back = e.back + apron;
    const paving = new THREE.Mesh(
      track(new THREE.BoxGeometry(w, 0.03, back - front)),
      M(palette.asphalt, { roughness: 0.95, metalness: 0 }),
    );
    paving.position.set(cx, 0.015, (front + back) / 2);
    paving.receiveShadow = true;
    g.add(paving);
    const edge = M(palette.curb, { roughness: 0.9 });
    const curbs: Array<readonly [number, number, number, number]> = [
      [cx, front, w + 0.1, 0.1],
      [cx, back, w + 0.1, 0.1],
    ];
    if (!truck) {
      curbs.push([left, (front + back) / 2, 0.1, back - front]);
      curbs.push([right, (front + back) / 2, 0.1, back - front]);
    }
    for (const [x, z, bw, bd] of curbs) {
      const strip = box(bw, 0.07, bd, edge);
      strip.position.set(x, 0.035, z);
      g.add(strip);
    }
    const paint = M(palette.paint, { roughness: 0.6 });
    if (!truck) {
      const lineLength = e.back - e.front - 0.3;
      const xs = new Set<number>();
      for (const r of rects) {
        xs.add(Math.round(r.minX * 100) / 100);
        xs.add(Math.round(r.maxX * 100) / 100);
      }
      for (const x of xs) {
        const line = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.006, lineLength)), paint);
        line.position.set(x, 0.034, e.front + 0.15 + lineLength / 2);
        g.add(line);
      }
      return;
    }
    const concrete = M(palette.concrete, { roughness: 0.95 });
    const bollardPaint = M(SCENE_COLORS.bollard, { roughness: 0.5 });
    const arrow = arrowGeometry();
    for (const r of rects) {
      for (const z of [r.minZ + 0.1, r.maxZ - 0.1]) {
        const line = new THREE.Mesh(
          track(new THREE.BoxGeometry(r.maxX - r.minX - 0.4, 0.006, 0.12)),
          paint,
        );
        line.position.set((r.minX + r.maxX) / 2, 0.034, z);
        g.add(line);
      }
      // Entry and exit arrows, pointing the way the trucks drive (+x).
      for (const x of [r.minX + 3.5, r.maxX - 2.2]) {
        const mark = new THREE.Mesh(arrow, paint);
        mark.rotation.x = -Math.PI / 2;
        mark.position.set(x, 0.034, (r.minZ + r.maxZ) / 2);
        g.add(mark);
      }
      // The raised island the dispenser stands on, a bollard at each end.
      const islandLength = 7;
      const island = box(islandLength, 0.15, FREE_LAYOUT.truckIslandM - 0.3, concrete);
      island.position.set(r.chargerX - 1, 0.075, r.chargerZ);
      g.add(island);
      for (const bx of [
        r.chargerX - 1 - islandLength / 2 + 0.3,
        r.chargerX - 1 + islandLength / 2 - 0.3,
      ]) {
        const post = cylinder(0.1, 1.0, 16, bollardPaint);
        post.position.set(bx, 0.65, r.chargerZ);
        g.add(post);
      }
    }
  }

  // A lane arrow painted on the ground: 3 m long, pointing +x (flat in x, y).
  let laneArrow: THREE.BufferGeometry | null = null;
  function arrowGeometry(): THREE.BufferGeometry {
    if (laneArrow != null) return laneArrow;
    const a = new THREE.Shape();
    a.moveTo(-1.5, -0.15);
    a.lineTo(0.5, -0.15);
    a.lineTo(0.5, -0.5);
    a.lineTo(1.5, 0);
    a.lineTo(0.5, 0.5);
    a.lineTo(0.5, 0.15);
    a.lineTo(-1.5, 0.15);
    a.lineTo(-1.5, -0.15);
    laneArrow = track(new THREE.ShapeGeometry(a));
    return laneArrow;
  }

  // The rotation handle of a station on a custom site: a ring on the ground
  // in front of its spots with a stem from the spots' back edge, in the edit
  // color, shown on the selected station in Edit Layout.
  function freeHandle(stationId: string, handleZ: number, spotsBack: number): THREE.Group {
    const g = new THREE.Group();
    const material = track(
      new THREE.MeshBasicMaterial({ color: theme.primary, transparent: true, opacity: 0.95 }),
    );
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.42, 0.07, 10, 36)), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.12, handleZ);
    const knob = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 16, 12)), material);
    knob.position.set(0, 0.2, handleZ);
    const stemLength = handleZ - 0.42 - spotsBack;
    const stem = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 0.03, stemLength)), material);
    stem.position.set(0, 0.08, handleZ - 0.42 - stemLength / 2);
    // A larger invisible disc makes the handle easy to grab on a touch screen.
    const grab = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 20)),
      track(new THREE.MeshBasicMaterial({ visible: false })),
    );
    grab.position.set(0, 0.15, handleZ);
    g.add(ring, knob, stem, grab);
    g.traverse((o) => {
      o.userData['rotateHandle'] = stationId;
    });
    g.visible = false;
    return g;
  }

  // Alignment guides: a dashed strip on the ground (dashes 0.6 m, gaps 0.4 m,
  // 15 cm wide, in the edit color) to each station the moved one lines up
  // with. The dashes share one geometry and material, kept for the scene's life.
  const guideDash = new THREE.BoxGeometry(1, 0.02, 1);
  const guideMaterial = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  function showGuides(guides: readonly AlignmentGuide[]): void {
    guideGroup.clear();
    for (const guide of guides) {
      const dx = guide.to.x - guide.from.x;
      const dz = guide.to.z - guide.from.z;
      const length = Math.hypot(dx, dz);
      const angle = Math.atan2(dx, dz);
      for (let d = 0; d < length; d += 1) {
        const dash = new THREE.Mesh(guideDash, guideMaterial);
        const run = Math.min(0.6, length - d);
        const mid = (d + run / 2) / length;
        dash.scale.set(0.15, 1, run);
        dash.rotation.y = angle;
        dash.position.set(guide.from.x + dx * mid, 0.06, guide.from.z + dz * mid);
        dash.raycast = () => undefined;
        dash.renderOrder = 4;
        guideGroup.add(dash);
      }
    }
  }

  // One spot of asphalt with its painted line on each side edge (half on each
  // side of the tile, so repeated tiles share one line) from the front gap to
  // the back gap, then the lane with a dashed center line.
  // `withLane` false: the spot alone (a parking lot row; its aisles and
  // islands are drawn apart, aisleTexture).
  function spotTexture(asphalt: string, paint: string, withLane = true): THREE.CanvasTexture {
    const { spotW, spotD, pitch } = layout.lot;
    const lane = withLane ? layout.lot.lane : 0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * TEXTURE_PX_PER_M);
    canvas.height = Math.round((withLane ? pitch : spotD) * TEXTURE_PX_PER_M);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const half = Math.round(0.05 * TEXTURE_PX_PER_M);
      const gap = Math.round(Math.min(BAY_LINE_GAP, spotD / 6) * TEXTURE_PX_PER_M);
      const lineEnd = Math.round(spotD * TEXTURE_PX_PER_M) - gap;
      ctx.fillRect(0, gap, half, lineEnd - gap);
      ctx.fillRect(canvas.width - half, gap, half, lineEnd - gap);
      if (lane >= 3) {
        const y = Math.round((spotD + lane / 2) * TEXTURE_PX_PER_M);
        const dash = Math.round(Math.min(1.5, spotW / 2) * TEXTURE_PX_PER_M);
        ctx.globalAlpha = 0.7;
        ctx.fillRect(Math.round((canvas.width - dash) / 2), y - half, dash, half * 2);
        ctx.globalAlpha = 1;
      }
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A drive aisle of a parking lot: asphalt with a dashed center line, one tile per spot width.
  function aisleTexture(asphalt: string, paint: string): THREE.CanvasTexture {
    const { spotW, lane } = layout.lot;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * TEXTURE_PX_PER_M);
    canvas.height = Math.round(lane * TEXTURE_PX_PER_M);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const half = Math.round(0.05 * TEXTURE_PX_PER_M);
      const dash = Math.round(Math.min(1.5, spotW / 2) * TEXTURE_PX_PER_M);
      ctx.globalAlpha = 0.7;
      ctx.fillRect(
        Math.round((canvas.width - dash) / 2),
        Math.round(canvas.height / 2) - half,
        dash,
        half * 2,
      );
      ctx.globalAlpha = 1;
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A parking lot: each row of spots with its painted lines, the drive aisles
  // between rows facing each other with a dashed center line, and a raised
  // curbed concrete island between rows back to back, where both rows'
  // chargers stand (parkingRowGaps).
  function buildParkingRows(palette: Palette): void {
    const lot = layout.lot;
    const plane = (w: number, d: number, material: THREE.Material, x: number, z: number) => {
      const geometry = track(new THREE.PlaneGeometry(w, d));
      geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, 0.012, z);
      mesh.receiveShadow = true;
      site.add(mesh);
    };
    const rows = spotTexture(palette.asphalt, palette.paint, false);
    rows.repeat.set(lot.cols, 1);
    const rowMaterial = M('#ffffff', { map: rows, roughness: 0.95, metalness: 0 });
    for (let r = 0; r < lot.rows; r++) {
      plane(lot.width, lot.spotD, rowMaterial, lot.width / 2, rowFrontZ(r, lot) + lot.spotD / 2);
    }
    const aisles = aisleTexture(palette.asphalt, palette.paint);
    aisles.repeat.set(lot.cols, 1);
    const aisleMaterial = M('#ffffff', { map: aisles, roughness: 0.95, metalness: 0 });
    const curb = M(palette.curb, { roughness: 0.9 });
    const top = M(palette.concrete, { roughness: 0.95 });
    const ISLAND_H = 0.15;
    for (const gap of parkingRowGaps(lot)) {
      const depth = gap.maxZ - gap.minZ;
      const z = (gap.minZ + gap.maxZ) / 2;
      if (gap.kind === 'aisle') {
        plane(lot.width, depth, aisleMaterial, lot.width / 2, z);
        continue;
      }
      // The island: 6 in curbs on its four sides around a concrete top.
      const body = box(lot.width, ISLAND_H, depth, top);
      body.position.set(lot.width / 2, ISLAND_H / 2, z);
      body.receiveShadow = true;
      site.add(body);
      for (const [w, d, x, cz] of [
        [lot.width, CURB_M / 2, lot.width / 2, gap.minZ + CURB_M / 4],
        [lot.width, CURB_M / 2, lot.width / 2, gap.maxZ - CURB_M / 4],
        [CURB_M / 2, depth, CURB_M / 4, z],
        [CURB_M / 2, depth, lot.width - CURB_M / 4, z],
      ] as const) {
        const edge = box(w, ISLAND_H + 0.01, d, curb);
        edge.position.set(x, (ISLAND_H + 0.01) / 2, cz);
        site.add(edge);
      }
    }
  }

  // The accessible charging space (`ACCESSIBLE_SPACE`, US Access Board EV
  // charging guidance): paint over its two spots, the widened vehicle space
  // and beside it the access aisle, its side lines and diagonal hatching
  // "to discourage parking". No International Symbol of Accessibility: the
  // Access Board recommends against it at EV spaces unless a state or local
  // code requires one. Hatch spacing and line width follow the spot lines
  // (no source gives one).
  function addAccessibleSpace(palette: Palette): void {
    const space = layout.accessible;
    if (space == null) return;
    const minX = Math.min(space.vehicle.minX, space.aisle.minX);
    const maxX = Math.max(space.vehicle.maxX, space.aisle.maxX);
    const { minZ, maxZ } = space.vehicle;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const px = (m: number): number => Math.round(m * TEXTURE_PX_PER_M);
    const canvas = document.createElement('canvas');
    canvas.width = px(w);
    canvas.height = px(d);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = palette.asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = palette.paint;
      ctx.strokeStyle = palette.paint;
      const line = px(0.1);
      const gap = px(Math.min(BAY_LINE_GAP, d / 6));
      const lineAt = (m: number): void => {
        const x = Math.min(canvas.width - line, Math.max(0, px(m - minX) - line / 2));
        ctx.fillRect(x, gap, line, canvas.height - 2 * gap);
      };
      for (const edge of new Set([minX, maxX, space.aisle.minX, space.aisle.maxX])) lineAt(edge);
      // Diagonal hatching across the aisle.
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        px(space.aisle.minX - minX),
        gap,
        px(space.aisle.maxX - space.aisle.minX),
        canvas.height - 2 * gap,
      );
      ctx.clip();
      ctx.lineWidth = line;
      const step = px(0.6);
      for (let y = -canvas.width; y < canvas.height + canvas.width; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y + canvas.width);
        ctx.stroke();
      }
      ctx.restore();
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const geometry = track(new THREE.PlaneGeometry(w, d));
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      M('#ffffff', { map: texture, roughness: 0.95, metalness: 0 }),
    );
    mesh.position.set((minX + maxX) / 2, 0.014, (minZ + maxZ) / 2);
    mesh.receiveShadow = true;
    site.add(mesh);
  }

  // Grass: speckles of lighter and darker blades on the base color, from a
  // fixed seed so it never flickers between rebuilds.
  function grassTexture(palette: Palette): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = palette.grass;
      ctx.fillRect(0, 0, 256, 256);
      let seed = 1234567;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = rand() < 0.5 ? palette.grassDark : palette.grassLight;
        ctx.globalAlpha = 0.35 + rand() * 0.4;
        ctx.fillRect(rand() * 256, rand() * 256, 1 + rand() * 2, 2 + rand() * 4);
      }
      ctx.globalAlpha = 1;
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A soft pulse that runs along a link (its u coordinate), offset every frame.
  function flowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const g = ctx.createLinearGradient(0, 0, 128, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.7, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 4);
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  // A soft round glow, white in the middle and clear at the edge, tinted by its material.
  let haloTexture: THREE.CanvasTexture | null = null;
  function glowTexture(): THREE.CanvasTexture {
    if (haloTexture != null) return haloTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }
    haloTexture = track(new THREE.CanvasTexture(canvas));
    return haloTexture;
  }

  type Palette = (typeof SCENE_COLORS)['light'] | (typeof SCENE_COLORS)['dark'];
  // Where a charging cable runs: from a DC charger, an AC pedestal or a wall
  // box to a car parked nose in, or from a curbside post to a car parked
  // parallel along the curb.
  type CableKind = 'ac' | 'dc' | 'wall' | 'curb-ac' | 'curb-dc';

  // The props and the transformer, built once per rebuild on first use and
  // cloned per station: the clones share their geometries and materials.
  interface Templates {
    /**
     * A car of its body type, nose to the charger, its body in its color; its
     * nose `noseZ` in front of the charger (against a wheel stop where the spot has one).
     */
    car: (look: SceneCar, noseZ?: number) => THREE.Group;
    /** The car parallel parked along a curb, in front of a curbside post. */
    carParallel: (look: SceneCar) => THREE.Group;
    /** A vehicle of its body type in its color in its own frame (nose at the origin facing -z). */
    vehicle: (look: SceneCar) => THREE.Group;
    /**
     * The cable to the charge port of a car of this (drawn) body type; `offsetX`
     * moves the car across the station (the right spot of a two-spot station
     * on a custom site takes the right holster).
     */
    cable: (
      kind: CableKind,
      bodyType: VehicleBodyType,
      offsetX?: number,
      noseZ?: number,
    ) => THREE.Mesh;
    /** A precast concrete wheel stop (WHEEL_STOP), centered on the origin, across x. */
    wheelStop: () => THREE.Mesh;
    /** The EV charging signs of a stall (R7-113, and the California tow-away sign), on a post or a wall. */
    evSigns: (mount: StationSigns) => THREE.Group;
    cone: () => THREE.Group;
    transformer: () => THREE.Group;
    battery: () => THREE.Group;
    switchboard: () => THREE.Group;
    /** A DC split system's power cabinet on a pad (`SPLIT_SYSTEM.cabinet`), its doors toward +z. */
    powerCabinet: () => THREE.Group;
    panelboard: () => THREE.Group;
    wallPanelboard: () => THREE.Group;
    terminal: (hasDisplay: boolean, online: boolean | null) => THREE.Group;
  }

  function templates(palette: Palette): Templates {
    const cache = new Map<string, THREE.Object3D>();
    const once = <T extends THREE.Object3D>(key: string, make: () => T): T => {
      let item = cache.get(key);
      if (item == null) {
        item = make();
        cache.set(key, item);
      }
      return item.clone() as T;
    };
    // The car parks nose to the charger, CAR_FRONT in front of it, inside its spot.
    const CAR_FRONT = 0.7;
    // The charge port on the front left fender of each body type.
    const portAt = (bodyType: VehicleBodyType, noseZ = CAR_FRONT): [number, number, number] => {
      const port = carKit(bodyType).port;
      return [port.x, port.y, noseZ + port.z];
    };
    // A car parallel parked along a curb (station local +z is the street): it
    // faces -x with its right side 0.3 m from the curb, its nose just past the
    // post, so its charge port (front left) is on the street side.
    const CURB_FACE_Z = CURB_POST_BACK_M;
    const parallelAt = (bodyType: VehicleBodyType): [number, number] => [
      -0.4,
      CURB_FACE_Z + 0.3 + vehicleSize(bodyType).width / 2,
    ];
    const parallelPortAt = (bodyType: VehicleBodyType): [number, number, number] => {
      const port = portAt(bodyType);
      const at = parallelAt(bodyType);
      return [port[2] + at[0], port[1], -port[0] + at[1] + 0.04];
    };
    // Shared by every car of one look: the glass, tires, rims, trim and lights.
    const glass = track(
      new THREE.MeshPhysicalMaterial({
        color: SCENE_COLORS.carGlass,
        roughness: 0.12,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.1,
        envMapIntensity: 0.55,
      }),
    );
    const carShared = {
      glass,
      tire: M(SCENE_COLORS.rubber, { roughness: 0.85 }),
      rim: M(SCENE_COLORS.rim, { roughness: 0.25, metalness: 0.9 }),
      trim: M(SCENE_COLORS.dark1, { roughness: 0.55 }),
      headlight: M(SCENE_COLORS.headlight, {
        emissive: SCENE_COLORS.headlight,
        emissiveIntensity: theme.dark ? 1.4 : 0.3,
      }),
      taillight: M(SCENE_COLORS.taillight, {
        emissive: SCENE_COLORS.taillight,
        emissiveIntensity: theme.dark ? 1.2 : 0.4,
      }),
      chargePort: M(SCENE_COLORS.chargePort, {
        emissive: SCENE_COLORS.chargePort,
        emissiveIntensity: 0.6,
      }),
      // A semi trailer's van body and bus roof pods: white, satin.
      panel: M(SCENE_COLORS.vehiclePanel, { roughness: 0.4, metalness: 0.2 }),
    };
    // A glossy paint with a clear coat, one material per color.
    const paints = new Map<string, THREE.Material>();
    const paintFor = (color: string): THREE.Material => {
      let paint = paints.get(color);
      if (paint == null) {
        paint = track(
          new THREE.MeshPhysicalMaterial({
            color,
            roughness: 0.35,
            metalness: 0.45,
            clearcoat: 1,
            clearcoatRoughness: 0.08,
          }),
        );
        paints.set(color, paint);
      }
      return paint;
    };
    const result: Templates = {
      vehicle: (look) =>
        once(`vehicle-${look.bodyType}-${look.color}`, () =>
          carKit(look.bodyType).build({ ...carShared, paint: paintFor(look.color) }),
        ),
      car: (look, noseZ = CAR_FRONT) =>
        once(`car-${look.bodyType}-${look.color}-${String(noseZ)}`, () => {
          const g = new THREE.Group();
          const car = carKit(look.bodyType).build({ ...carShared, paint: paintFor(look.color) });
          car.position.z = noseZ;
          g.add(car);
          return g;
        }),
      carParallel: (look) =>
        once(`carParallel-${look.bodyType}-${look.color}`, () => {
          const g = new THREE.Group();
          const car = result.car(look);
          const at = parallelAt(look.bodyType);
          car.rotation.y = Math.PI / 2;
          car.position.set(at[0], 0, at[1]);
          g.add(car);
          return g;
        }),
      // From the left holster of the charger to the charge port at the front left of the car.
      cable: (kind, bodyType, offsetX = 0, noseZ = CAR_FRONT) =>
        once(`cable-${kind}-${bodyType}-${String(offsetX)}-${String(noseZ)}`, () => {
          const port = portAt(bodyType, noseZ);
          const PORT: [number, number, number] = [port[0] + offsetX, port[1], port[2]];
          // The holster on the side of the car: the right one for a car in the right spot.
          const side = offsetX > 0 ? -1 : 1;
          const PARALLEL_PORT = parallelPortAt(bodyType);
          const rubber = M(SCENE_COLORS.rubber, { roughness: 0.9 });
          if (kind === 'curb-ac' || kind === 'curb-dc') {
            // Down the post, along the ground past the car's nose to its street side, up to the port.
            const start: [number, number, number] =
              kind === 'curb-dc' ? [-0.44, 1.02, 0.12] : [-0.17, 0.95, 0.04];
            return cable(
              [
                start,
                [start[0] + 0.02, 0.4, 0.35],
                [-0.02, 0.07, 1.0],
                [0.08, 0.07, PARALLEL_PORT[2] - 0.6],
                [0.3, 0.2, PARALLEL_PORT[2] + 0.18],
                PARALLEL_PORT,
              ],
              rubber,
            );
          }
          if (kind === 'wall') {
            // From the wall box holster on the facade, down across the sidewalk, to the car.
            const w = wallBoxOffset();
            return cable(
              [
                [0.24, 1.02, w + 0.2],
                [0.22, 0.3, w + 0.7],
                [-0.2, 0.1, -1.8],
                [-0.8, 0.12, 0.2],
                [-0.9, 0.4, noseZ + 0.3],
                PORT,
              ],
              rubber,
            );
          }
          return kind === 'dc'
            ? cable(
                [
                  [-0.44 * side, 1.02, 0.12],
                  [-0.55 * side, 0.5, 0.3],
                  [-0.7 * side + offsetX * 0.4, 0.12, 0.62],
                  [-0.9 + offsetX, 0.4, noseZ + 0.4],
                  PORT,
                ],
                rubber,
              )
            : cable(
                [
                  [-0.17 * side, 0.95, 0.04],
                  [-0.32 * side, 0.45, 0.25],
                  [-0.6 * side + offsetX * 0.4, 0.12, 0.6],
                  [-0.9 + offsetX, 0.4, noseZ + 0.4],
                  PORT,
                ],
                rubber,
              );
        }),
      wheelStop: () =>
        once('wheelStop', () => {
          // The precast stop: a low concrete bar, its top a little narrower than its base.
          const stop = new THREE.Mesh(
            track(new THREE.BoxGeometry(WHEEL_STOP.lengthM, WHEEL_STOP.heightM, WHEEL_STOP.depthM)),
            M(palette.concrete, { roughness: 0.95 }),
          );
          stop.position.y = WHEEL_STOP.heightM / 2;
          stop.castShadow = true;
          stop.receiveShadow = true;
          stop.raycast = () => undefined;
          return stop;
        }),
      evSigns: (mount: StationSigns) =>
        once(`evSigns:${String(mount.onWall)}:${String(mount.towAwayBottomM)}`, () => {
          // A wall sign is placed at the facade by the caller (mount.z).
          const g = new THREE.Group();
          const backing = M(SCENE_COLORS.signBack, { roughness: 0.6, metalness: 0.5 });
          // A sign panel: a thin aluminum blank with its face in front.
          const panel = (w: number, h: number, bottom: number, face: THREE.CanvasTexture): void => {
            const blank = box(w, h, 0.004, backing);
            blank.position.set(0, bottom + h / 2, mount.onWall ? 0.004 : 0.03);
            const plate = new THREE.Mesh(
              track(new THREE.PlaneGeometry(w, h)),
              M('#ffffff', { map: face, roughness: 0.5, metalness: 0 }),
            );
            plate.position.set(0, bottom + h / 2, mount.onWall ? 0.0065 : 0.0325);
            g.add(blank, plate);
          };
          panel(
            EV_SIGNS.chargingOnly.widthM,
            EV_SIGNS.chargingOnly.heightM,
            mount.chargingOnlyBottomM,
            evSignTexture('chargingOnly'),
          );
          if (mount.towAwayBottomM != null) {
            panel(
              EV_SIGNS.towAway.widthM,
              EV_SIGNS.towAway.heightM,
              mount.towAwayBottomM,
              evSignTexture('towAway'),
            );
          }
          const support = signSupport(mount);
          if (support.kind === 'post') {
            const steel = M(SCENE_COLORS.signPost, { roughness: 0.5, metalness: 0.7 });
            // The galvanized square tube from the ground to the top sign.
            const post = box(
              EV_SIGNS.postWidthM,
              support.topM - support.bottomM,
              EV_SIGNS.postWidthM,
              steel,
            );
            post.position.y = (support.topM + support.bottomM) / 2;
            // The anchor post it slides into, driven into the ground.
            const anchor = box(
              EV_SIGNS.anchorWidthM,
              support.anchorTopM,
              EV_SIGNS.anchorWidthM,
              steel,
            );
            anchor.position.y = support.anchorTopM / 2;
            g.add(post, anchor);
          }
          return g;
        }),
      cone: () =>
        once('cone', () => {
          const g = new THREE.Group();
          const orange = M(SCENE_COLORS.cone, { roughness: 0.6 });
          const white = M(SCENE_COLORS.coneBand, { roughness: 0.5 });
          const base = box(0.42, 0.04, 0.42, orange);
          base.position.y = 0.02;
          const height = 0.62;
          const radius = 0.17;
          const cone = shadowed(
            new THREE.Mesh(track(new THREE.ConeGeometry(radius, height, 24)), orange),
          );
          cone.position.y = 0.04 + height / 2;
          g.add(base, cone);
          for (const [from, to] of [
            [0.3, 0.4],
            [0.55, 0.63],
          ] as const) {
            const r = (f: number) => radius * (1 - f) + 0.004;
            const band = shadowed(
              new THREE.Mesh(
                track(
                  new THREE.CylinderGeometry(r(to), r(from), (to - from) * height, 24, 1, true),
                ),
                white,
              ),
            );
            band.position.y = 0.04 + ((from + to) / 2) * height;
            g.add(band);
          }
          g.position.set(0.15, 0, 2.2);
          return g;
        }),
      // A pad-mounted transformer: cabinet on a concrete pad, cooling fins on
      // both sides, door seams and a warning sign on the front.
      // A containerized battery: a long cabinet on a pad with door seams, a
      // vent grille, an air conditioner on its end and a green status strip.
      battery: () =>
        once('battery', () => {
          const g = new THREE.Group();
          const concrete = M(palette.concrete, { roughness: 0.95 });
          const body = M(palette.battery, { roughness: 0.5, metalness: 0.25 });
          const seam = M(SCENE_COLORS.dark1, { roughness: 0.7 });
          const grille = M(palette.batteryVent, { roughness: 0.6, metalness: 0.4 });
          const strip = M(SCENE_COLORS.chargePort, {
            emissive: SCENE_COLORS.chargePort,
            emissiveIntensity: 0.6,
          });
          const pad = box(4.0, 0.16, 2.0, concrete);
          pad.position.y = 0.08;
          const cabinet = roundedPrism(3.4, 1.4, 2.2, 0.05, body);
          cabinet.position.y = 0.16;
          const roof = box(3.5, 0.08, 1.5, body);
          roof.position.y = 2.4;
          g.add(pad, cabinet, roof);
          for (const x of [-1.13, 0, 1.13]) {
            const door = box(0.02, 1.9, 0.01, seam);
            door.position.set(x + 0.56, 1.2, 0.71);
            const handle = box(0.03, 0.22, 0.03, seam);
            handle.position.set(x + 0.42, 1.2, 0.73);
            g.add(door, handle);
          }
          const vent = box(0.9, 0.32, 0.02, grille);
          vent.position.set(-1.1, 2.0, 0.71);
          const status = box(0.5, 0.05, 0.02, strip);
          status.position.set(1.1, 2.05, 0.72);
          // The air conditioner on the right end, with a round fan grille.
          const hvac = box(0.4, 1.0, 1.0, grille);
          hvac.position.set(1.9, 1.0, 0);
          const fan = cylinder(0.3, 0.04, 24, seam);
          fan.rotation.z = Math.PI / 2;
          fan.position.set(2.11, 1.0, 0);
          g.add(vent, status, hvac, fan);
          return g;
        }),
      transformer: () =>
        once('transformer', () => {
          const g = new THREE.Group();
          const concrete = M(palette.concrete, { roughness: 0.95 });
          const paint = M(palette.transformer, { roughness: 0.55, metalness: 0.3 });
          const fin = M(palette.transformerFin, { roughness: 0.5, metalness: 0.35 });
          const seam = M(SCENE_COLORS.dark1, { roughness: 0.7 });
          const pad = box(2.9, 0.16, 2.5, concrete);
          pad.position.y = 0.08;
          const cabinet = roundedPrism(2.0, 1.6, 1.55, 0.06, paint);
          cabinet.position.y = 0.16;
          const lid = box(2.12, 0.06, 1.72, paint);
          lid.position.y = 1.74;
          g.add(pad, cabinet, lid);
          for (const side of [-1, 1]) {
            for (let i = 0; i < 9; i++) {
              const f = box(0.16, 1.2, 0.03, fin);
              f.position.set(side * 1.08, 0.86, -0.6 + i * 0.15);
              g.add(f);
            }
          }
          const middle = box(0.02, 1.4, 0.01, seam);
          middle.position.set(0, 0.92, 0.81);
          const handleBar = box(0.04, 0.18, 0.04, seam);
          handleBar.position.set(0.12, 0.95, 0.83);
          const sign = box(0.42, 0.36, 0.02, [
            seam,
            seam,
            seam,
            seam,
            M('#ffffff', { map: warningTexture(), roughness: 0.5 }),
            seam,
          ]);
          sign.position.set(-0.5, 1.2, 0.82);
          g.add(middle, handleBar, sign);
          return g;
        }),
      // A free-standing switchboard on a concrete pad: three doors with
      // handles, vents at the top and bottom of each door, a nameplate and a
      // warning label. The front faces +z.
      powerCabinet: () =>
        once('powerCabinet', () => {
          // Kempower C-Series double cabinet: 1250 x 2195 x 841 mm (SPLIT_SYSTEM.cabinet),
          // two doors with air inlets and an outlet under the roof.
          const g = new THREE.Group();
          const c = SPLIT_SYSTEM.cabinet;
          const concrete = M(palette.concrete, { roughness: 0.95 });
          const body = M(palette.switchboard, { roughness: 0.45, metalness: 0.35 });
          const door = M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 });
          const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const pad = box(c.widthM + 0.4, 0.15, c.depthM + 0.6, concrete);
          pad.position.y = 0.075;
          const plinth = box(c.widthM, 0.1, c.depthM, dark);
          plinth.position.y = 0.2;
          const cabinet = box(c.widthM, c.heightM - 0.15, c.depthM, body);
          cabinet.position.y = 0.25 + (c.heightM - 0.15) / 2;
          const roof = box(c.widthM + 0.05, 0.05, c.depthM + 0.05, dark);
          roof.position.y = 0.25 + c.heightM - 0.15 + 0.025;
          g.add(pad, plinth, cabinet, roof);
          for (const x of [-c.widthM / 4, c.widthM / 4]) {
            const leaf = box(c.widthM / 2 - 0.04, c.heightM - 0.35, 0.02, door);
            leaf.position.set(x, 0.25 + (c.heightM - 0.15) / 2, c.depthM / 2 + 0.01);
            g.add(leaf);
            for (let i = 0; i < 4; i++) {
              const inlet = box(0.32, 0.18, 0.02, dark);
              inlet.position.set(x, 1.9 - i * 0.26, c.depthM / 2 + 0.025);
              g.add(inlet);
            }
          }
          return g;
        }),
      switchboard: () =>
        once('switchboard', () => {
          const g = new THREE.Group();
          const concrete = M(palette.concrete, { roughness: 0.95 });
          const body = M(palette.switchboard, { roughness: 0.45, metalness: 0.35 });
          const door = M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 });
          const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const pad = box(2.3, 0.15, 1.5, concrete);
          pad.position.y = 0.075;
          const plinth = box(1.94, 0.12, 0.86, dark);
          plinth.position.y = 0.21;
          const cabinet = box(1.9, 2.0, 0.8, body);
          cabinet.position.y = 1.27;
          const cap = box(2.0, 0.06, 0.92, body);
          cap.position.y = 2.3;
          g.add(pad, plinth, cabinet, cap);
          for (const x of [-0.62, 0, 0.62]) {
            const leaf = box(0.58, 1.86, 0.02, door);
            leaf.position.set(x, 1.27, 0.41);
            const grip = box(0.03, 0.22, 0.04, dark);
            grip.position.set(x + 0.22, 1.25, 0.43);
            g.add(leaf, grip);
            for (const y0 of [0.45, 1.86]) {
              for (let i = 0; i < 4; i++) {
                const louver = box(0.4, 0.022, 0.02, dark);
                louver.position.set(x, y0 + i * 0.055, 0.425);
                g.add(louver);
              }
            }
          }
          const nameplate = box(0.34, 0.12, 0.01, M(palette.signPlate, { roughness: 0.4 }));
          nameplate.position.set(0, 1.72, 0.425);
          const warning = box(0.2, 0.18, 0.01, [
            dark,
            dark,
            dark,
            dark,
            M('#ffffff', { map: warningTexture(), roughness: 0.5 }),
            dark,
          ]);
          warning.position.set(0.62, 1.55, 0.425);
          g.add(nameplate, warning);
          return g;
        }),
      // A panelboard on a two-post strut rack on a small pad (PANELBOARD): the
      // enclosure with its door seam and a warning label. The front faces +z.
      panelboard: () =>
        once('panelboard', () => {
          const g = new THREE.Group();
          const concrete = M(palette.concrete, { roughness: 0.95 });
          const body = M(palette.switchboard, { roughness: 0.45, metalness: 0.35 });
          const strut = M(SCENE_COLORS.signPost, { roughness: 0.5, metalness: 0.6 });
          const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const pb = PANELBOARD;
          const pad = box(pb.padWM, 0.12, pb.padDM, concrete);
          pad.position.y = 0.06;
          g.add(pad);
          for (const x of [-0.35, 0.35]) {
            const post = box(0.042, pb.topM + 0.1, 0.042, strut);
            post.position.set(x, 0.12 + (pb.topM + 0.1) / 2, -0.12);
            g.add(post);
          }
          for (const y of [pb.topM - 0.15, pb.topM - pb.heightM + 0.15]) {
            const bar = box(0.8, 0.042, 0.042, strut);
            bar.position.set(0, y, -0.12);
            g.add(bar);
          }
          const enclosure = box(pb.widthM, pb.heightM, pb.depthM, body);
          enclosure.position.set(0, pb.topM - pb.heightM / 2, -0.12 + 0.021 + pb.depthM / 2);
          g.add(enclosure);
          const front = -0.12 + 0.021 + pb.depthM;
          const seam = box(0.006, pb.heightM - 0.08, 0.004, dark);
          seam.position.set(pb.widthM / 2 - 0.08, pb.topM - pb.heightM / 2, front + 0.002);
          const warning = box(0.16, 0.12, 0.004, [
            dark,
            dark,
            dark,
            dark,
            M('#ffffff', { map: warningTexture(), roughness: 0.5 }),
            dark,
          ]);
          warning.position.set(0, pb.topM - 0.2, front + 0.003);
          g.add(seam, warning);
          return g;
        }),
      // A panelboard on the building facade (PANELBOARD, an office or retail
      // site): the enclosure on the wall, its back at z 0, the front +z.
      wallPanelboard: () =>
        once('wall-panelboard', () => {
          const g = new THREE.Group();
          const body = M(palette.switchboard, { roughness: 0.45, metalness: 0.35 });
          const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const pb = PANELBOARD;
          const enclosure = box(pb.widthM, pb.heightM, pb.depthM, body);
          enclosure.position.set(0, pb.wallTopM - pb.heightM / 2, pb.depthM / 2);
          const seam = box(0.006, pb.heightM - 0.08, 0.004, dark);
          seam.position.set(pb.widthM / 2 - 0.08, pb.wallTopM - pb.heightM / 2, pb.depthM + 0.002);
          const warning = box(0.16, 0.12, 0.004, [
            dark,
            dark,
            dark,
            dark,
            M('#ffffff', { map: warningTexture(), roughness: 0.5 }),
            dark,
          ]);
          warning.position.set(0, pb.wallTopM - 0.2, pb.depthM + 0.003);
          g.add(enclosure, seam, warning);
          return g;
        }),
      // A compact card reader on a short bracket; a screen only for a model with a display.
      terminal: (hasDisplay, online) =>
        once(`terminal-${String(hasDisplay)}-${String(online)}`, () => {
          const g = new THREE.Group();
          const bodyMaterial = M(SCENE_COLORS.terminalBody, { roughness: 0.45 });
          const bracket = box(0.04, 0.04, 0.09, M(SCENE_COLORS.signPost, { metalness: 0.6 }));
          bracket.position.set(0, 0, -0.045);
          const body = roundedPrism(0.1, 0.035, 0.17, 0.012, bodyMaterial);
          body.position.set(0, -0.085, 0.015);
          g.add(bracket, body);
          if (hasDisplay) {
            const screen = box(
              0.075,
              0.06,
              0.004,
              M(SCENE_COLORS.glass, {
                emissive: online === true ? SCENE_COLORS.terminalScreen : '#000000',
                emissiveIntensity: online === true ? 1.1 : 0,
              }),
            );
            screen.position.set(0, 0.03, 0.034);
            g.add(screen);
          } else {
            // The contactless area of a reader without a screen.
            const tap = box(0.07, 0.07, 0.003, M(palette.signPlate, { roughness: 0.4 }));
            tap.position.set(0, 0.02, 0.034);
            g.add(tap);
          }
          const statusColor =
            online === true ? SCENE_COLORS.terminalOnline : SCENE_COLORS.terminalOffline;
          const status = box(
            0.02,
            0.012,
            0.004,
            M(statusColor, {
              emissive: statusColor,
              emissiveIntensity: online === true ? 1 : 0.1,
            }),
          );
          status.position.set(0, -0.045, 0.034);
          g.add(status);
          return g;
        }),
    };
    return result;
  }

  // An EV charging sign face, drawn in code at the sign's proportions: the
  // R7-113 (No Parking Except While Charging: red legend and border on white,
  // 12 by 18 in, MUTCD 11th Edition Section 2B.53) or the California
  // tow-away sign of Vehicle Code 22511(d)(1) (17 by 22 in, its required
  // statement; the reclaim place and telephone are the operator's, left blank).
  function evSignTexture(kind: 'chargingOnly' | 'towAway'): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    const ink = kind === 'chargingOnly' ? SCENE_COLORS.signRegulatoryRed : SCENE_COLORS.signInk;
    canvas.width = kind === 'chargingOnly' ? 240 : 340;
    canvas.height = kind === 'chargingOnly' ? 360 : 440;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 10;
      ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // The legend in the viewer's language (`signTexts`), line by line,
      // each as large as the sign's letter height allows (`signLetterPx`).
      const lines = signLines(
        kind === 'chargingOnly' ? theme.signs.chargingOnly : theme.signs.towAway,
      );
      const step = (canvas.height - 70) / lines.length;
      lines.forEach((line, i) => {
        let size = signLetterPx(kind, step);
        ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
        while (size > 12 && ctx.measureText(line).width > canvas.width - 50) {
          size -= 2;
          ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
        }
        ctx.fillText(line, canvas.width / 2, 35 + step * (i + 0.5));
      });
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A virtual status sign (`VirtualSign`): not a physical sign, so it looks
  // like an overlay: a translucent rounded panel in the CSMS state color with
  // a soft glow and a light outline, the word in the viewer's language. The
  // sprite material draws it at VIRTUAL_SIGN_OPACITY, always facing the camera.
  function virtualSignTexture(kind: VirtualSign): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 176;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      const color = theme.virtualColors[kind];
      const r = 44;
      const path = (inset: number): void => {
        const x = 24 + inset;
        const y = 24 + inset;
        const w = canvas.width - 48 - inset * 2;
        const h = canvas.height - 48 - inset * 2;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r - inset);
      };
      ctx.shadowColor = color;
      ctx.shadowBlur = 22;
      path(0);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
      path(4);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
      const text = (
        kind === 'reserved' ? theme.signs.reserved : theme.signs.maintenance
      ).toLocaleUpperCase();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 64;
      ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
      while (size > 22 && ctx.measureText(text).width > canvas.width - 110) {
        size -= 2;
        ctx.font = `700 ${String(size)}px ${SIGN_FONT_FAMILY}`;
      }
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The virtual status sign of a station: a sprite over its spot (station frame).
  function virtualSignSprite(kind: VirtualSign, stationId: string): THREE.Sprite {
    const material = track(
      new THREE.SpriteMaterial({
        map: virtualSignTexture(kind),
        transparent: true,
        opacity: VIRTUAL_SIGN_OPACITY,
        depthWrite: false,
      }),
    );
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(VIRTUAL_SIGN_WIDTH_M, (VIRTUAL_SIGN_WIDTH_M * 176) / 512, 1);
    sprite.renderOrder = 3;
    sprite.userData['virtualSign'] = stationId;
    virtualSprites.set(stationId, sprite);
    return sprite;
  }

  // The transformer warning sign: a yellow plate with a high voltage triangle.
  function warningTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 220;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = SCENE_COLORS.warning;
      ctx.fillRect(0, 0, 256, 220);
      ctx.strokeStyle = SCENE_COLORS.warningInk;
      ctx.lineWidth = 14;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(128, 24);
      ctx.lineTo(232, 196);
      ctx.lineTo(24, 196);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = SCENE_COLORS.warningInk;
      ctx.beginPath();
      ctx.moveTo(138, 70);
      ctx.lineTo(104, 136);
      ctx.lineTo(130, 136);
      ctx.lineTo(116, 180);
      ctx.lineTo(154, 116);
      ctx.lineTo(128, 116);
      ctx.closePath();
      ctx.fill();
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The logo panel of a charger model (`CHARGER_LOGO_PANELS`): a plain plate
  // with the logo fitted on it, padded, never stretched. `at`: the cabinet
  // center of a large model, the wall box offset of a wall box.
  function logoPanel(
    model: ChargerLogoModel,
    palette: Palette,
    at: { x: number; z: number } = { x: 0, z: 0 },
  ): THREE.Group {
    const spec = CHARGER_LOGO_PANELS[model];
    const g = new THREE.Group();
    g.position.set(at.x + spec.x, 0, at.z + spec.z);
    g.userData['logoPanel'] = model;
    const plate = box(spec.width, spec.height, 0.012, M(palette.signPlate, { roughness: 0.4 }));
    plate.position.set(0, spec.y, 0);
    g.add(plate);
    if (logo != null) {
      const size = logoFit(spec, { width: logo.width, height: logo.height }, LOGO_PADDING);
      if (size.width > 0) {
        const face = new THREE.Mesh(
          track(new THREE.PlaneGeometry(size.width, size.height)),
          track(
            new THREE.MeshStandardMaterial({
              map: logo.texture,
              transparent: true,
              roughness: 0.5,
            }),
          ),
        );
        // The plane faces +z: turned to the back for a back panel.
        if (spec.facing < 0) face.rotation.y = Math.PI;
        face.position.set(0, spec.y, spec.facing * 0.008);
        face.userData['logo'] = true;
        g.add(face);
      }
    }
    return g;
  }

  // The charging glow of a station front: an emissive strip (the frame or
  // ring meshes given) and a soft halo in front of it, both in the state color.
  function addGlow(
    g: THREE.Group,
    s: SceneStation,
    strips: Array<{ geometry: THREE.BufferGeometry; position: [number, number, number] }>,
    halo: { size: number; position: [number, number, number] },
  ): StationObject['glow'] {
    if (!s.glow) return null;
    const level = chargingGlowLevel(null);
    const strip = M(s.lightColor, {
      emissive: s.lightColor,
      emissiveIntensity: level.intensity,
      roughness: 0.3,
    });
    for (const part of strips) {
      const mesh = new THREE.Mesh(track(part.geometry), strip);
      mesh.position.set(...part.position);
      g.add(mesh);
    }
    const haloMaterial = track(
      new THREE.MeshBasicMaterial({
        color: s.lightColor,
        map: glowTexture(),
        transparent: true,
        opacity: level.halo,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const glowPlane = new THREE.Mesh(
      track(new THREE.PlaneGeometry(halo.size, halo.size)),
      haloMaterial,
    );
    glowPlane.position.set(...halo.position);
    glowPlane.raycast = () => undefined;
    glowPlane.renderOrder = 3;
    g.add(glowPlane);
    return { strip, halo: haloMaterial };
  }

  // A ring around a round socket, facing +z.
  const socketRing = (radius: number) => new THREE.TorusGeometry(radius, 0.012, 8, 32);

  interface StationMaterials {
    shell: THREE.Material;
    dark: THREE.Material;
    rubber: THREE.Material;
    glass: THREE.Material;
    light: THREE.Material;
    accent: THREE.Material;
  }

  // Where the vehicle of a large spot stands, in the station frame: nose to
  // the charger in a bus bay (or a car spot), driving through a truck lane
  // with its charge inlet just past the dispenser and its left side to the
  // island.
  const LARGE_NOSE_Z = 0.9;
  const TRUCK_INLET_PAST_DISPENSER_M = 0.8;
  const TRUCK_SIDE_FROM_ISLAND_M = 0.4;
  function largeVehiclePose(
    rect: FreeSpotRect,
    bodyType: VehicleBodyType,
  ): { x: number; z: number; turn: number; port: THREE.Vector3; roof: THREE.Vector3 | null } {
    const kit = carKit(bodyType);
    const size = vehicleSize(bodyType);
    if (rect.heading === '+x') {
      // Turned -90 degrees: the vehicle's -z (forward) becomes +x, its left side -z.
      const x = Math.min(
        rect.maxX - 0.3,
        rect.chargerX + TRUCK_INLET_PAST_DISPENSER_M + kit.port.z,
      );
      const z = rect.minZ + TRUCK_SIDE_FROM_ISLAND_M + size.width / 2;
      const port = new THREE.Vector3(x - kit.port.z, kit.port.y, z + kit.port.x);
      const roof =
        kit.roofContact != null
          ? new THREE.Vector3(x - kit.roofContact.z, kit.roofContact.y, z + kit.roofContact.x)
          : null;
      return { x, z, turn: -Math.PI / 2, port, roof };
    }
    const x = (rect.minX + rect.maxX) / 2;
    const z = LARGE_NOSE_Z;
    const port = new THREE.Vector3(x + kit.port.x, kit.port.y, z + kit.port.z);
    const roof =
      kit.roofContact != null
        ? new THREE.Vector3(x + kit.roofContact.x, kit.roofContact.y, z + kit.roofContact.z)
        : null;
    return { x, z, turn: 0, port, roof };
  }

  // The contact point of a bay's pantograph: over the middle of the bay, where
  // a bus's roof rails stop (LARGE_NOSE_Z plus the rails' distance from its nose).
  function pantographPoint(rect: FreeSpotRect): THREE.Vector3 {
    const roof = carKit('bus').roofContact ?? new THREE.Vector3(0, 3.38, 2.7);
    return new THREE.Vector3((rect.minX + rect.maxX) / 2, roof.y, LARGE_NOSE_Z + roof.z);
  }

  /**
   * The depot pantograph pole (ABB HVC-PD data sheet: 5.24 m high, the
   * pantograph 4.67 m out from the pole; Schunk SLS 201: mounted at 5.12 m):
   * the boom height, the pole height and how far the pole stands behind a
   * bay's contact point.
   */
  const MAST_BOOM_Y = 5.1;
  const MAST_HEIGHT_M = 5.24;
  const MAST_OUTREACH_M = 4.67;
  /** The contact hood of a pantograph up mast: the bus roof pantograph rises 1.5 m into it (Schunk SLS 102: 1.5 to 1.8 m). */
  const HOOD_Y = 4.9;
  /** The cable management arm of a bus depot dispenser: high enough over a 3.4 m bus. */
  const BUS_BOOM_Y = 4.5;

  // A heavy charger cabinet facing +z: a body, a dark plinth, the screen
  // with its bezel, the light bar, an RFID reader, accent stripes. Returns the
  // screen center (the message and the glow frame go there).
  function cabinet(
    g: THREE.Group,
    at: { x: number; z: number },
    size: { w: number; d: number; h: number },
    m: StationMaterials,
  ): [number, number, number] {
    const body = roundedPrism(size.w, size.d, size.h, 0.08, m.shell);
    body.position.set(at.x, 0.12, at.z);
    const plinth = box(size.w + 0.06, 0.12, size.d + 0.06, m.dark);
    plinth.position.set(at.x, 0.12, at.z);
    const front = at.z + size.d / 2;
    const screenY = 0.12 + size.h * 0.74;
    const bezel = box(0.5, 0.42, 0.02, m.dark);
    bezel.position.set(at.x, screenY, front + 0.01);
    const screen = box(0.44, 0.34, 0.02, m.glass);
    screen.position.set(at.x, screenY, front + 0.02);
    const bar = box(size.w * 0.7, 0.035, 0.02, m.light);
    bar.position.set(at.x, 0.12 + size.h - 0.12, front + 0.01);
    const reader = box(0.12, 0.12, 0.02, m.dark);
    reader.position.set(at.x + 0.2, screenY - 0.36, front + 0.01);
    const cap = box(size.w + 0.08, 0.06, size.d + 0.08, m.dark);
    cap.position.set(at.x, 0.12 + size.h + 0.03, at.z);
    g.add(body, plinth, bezel, screen, bar, reader, cap);
    for (const side of [-1, 1]) {
      const stripe = box(0.01, size.h * 0.6, 0.18, m.accent);
      stripe.position.set(at.x + side * (size.w / 2 + 0.005), 0.12 + size.h * 0.55, front - 0.12);
      g.add(stripe);
    }
    return [at.x, screenY, front + 0.03];
  }

  // The glow frame around a cabinet screen.
  function cabinetGlow(
    g: THREE.Group,
    s: SceneStation,
    c: [number, number, number],
  ): StationObject['glow'] {
    const [x, y, z] = c;
    return addGlow(
      g,
      s,
      [
        { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [x, y + 0.225, z] },
        { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [x, y - 0.225, z] },
        { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [x - 0.277, y, z] },
        { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [x + 0.277, y, z] },
      ],
      { size: 1.0, position: [x, y, z + 0.01] },
    );
  }

  // A heavy connector (MCS or high-power CCS) and its handle, facing +z.
  function heavyHandle(material: THREE.Material): THREE.Group {
    const h = new THREE.Group();
    const grip = box(0.1, 0.32, 0.12, material);
    const head = box(0.16, 0.14, 0.2, material);
    head.position.set(0, 0.16, 0.06);
    h.add(grip, head);
    return h;
  }

  // The large chargers of a custom site (`FreeChargerModel`), in the station
  // frame. Truck: a megawatt dispenser on each lane island with a cable
  // management arm over the lane. Bus: a depot pantograph mast with a boom
  // over each bay (the power cabinet at its foot), or a tall dispenser with a
  // cable boom. Each has the screen (with the display message) and the
  // charging glow on its cabinet.
  function buildLargeCharger(
    g: THREE.Group,
    s: SceneStation,
    model: Exclude<FreeChargerModel, 'standard'>,
    palette: Palette,
    m: StationMaterials,
  ): { top: number; glow: StationObject['glow'] } {
    const concrete = M(palette.concrete, { roughness: 0.95 });
    const steel = M(SCENE_COLORS.signPost, { roughness: 0.45, metalness: 0.6 });
    const spotType = freeSpotTypeOf(s.free);
    const rects = freeSpotRects(s.spots ?? 1, spotType);
    let glow: StationObject['glow'] = null;
    let top = 2.6;
    if (model === 'truck_mcs') {
      rects.forEach((r, i) => {
        // An MCS dispenser on its island facing the lane, 2.32 m tall
        // (alpitronic HYC1000 MCS dispenser: 2320 by 260 by 780 mm; the ABB
        // MCS1200 charge post and the Kempower Mega Satellite are posts of
        // the same kind). The short heavy cable (Kempower: 2.7 m) hangs from
        // the lane face; no overhead arm.
        const screen = cabinet(
          g,
          { x: r.chargerX, z: r.chargerZ },
          { w: 0.78, d: 0.42, h: 2.2 },
          m,
        );
        if (i === 0) {
          addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
          glow = cabinetGlow(g, s, screen);
        }
        g.add(logoPanel('truck_mcs', palette, { x: r.chargerX, z: r.chargerZ }));
        // The cable outlet low on the lane face, the connector holster above it.
        const outlet = box(0.14, 0.14, 0.06, m.dark);
        outlet.position.set(r.chargerX + 0.22, 0.75, r.chargerZ + 0.24);
        const holster = box(0.16, 0.36, 0.14, m.dark);
        holster.position.set(r.chargerX - 0.2, 1.25, r.chargerZ + 0.28);
        g.add(outlet, holster);
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        if (!charging) {
          const h = heavyHandle(m.rubber);
          h.position.set(r.chargerX - 0.2, 1.3, r.chargerZ + 0.36);
          g.add(
            h,
            cable(
              [
                [r.chargerX + 0.22, 0.75, r.chargerZ + 0.28],
                [r.chargerX + 0.15, 0.35, r.chargerZ + 0.55],
                [r.chargerX - 0.1, 0.5, r.chargerZ + 0.6],
                [r.chargerX - 0.2, 1.15, r.chargerZ + 0.42],
              ],
              m.rubber,
              0.04,
            ),
          );
        }
      });
      top = 2.44;
    } else if (model === 'bus_dispenser') {
      // A dispenser at the head of the bays with a cable management arm over
      // each bay, above the bus roof (depot dispensers hang their cable from
      // a pole and arm or an overhead reel, as the Kempower Cable Arm).
      const screen = cabinet(g, { x: 0, z: 0 }, { w: 0.9, d: 0.7, h: 2.3 }, m);
      addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
      glow = cabinetGlow(g, s, screen);
      g.add(logoPanel('bus_dispenser', palette));
      const mast = box(0.18, BUS_BOOM_Y + 0.1, 0.18, steel);
      mast.position.set(0, (BUS_BOOM_Y + 0.1) / 2, -0.5);
      g.add(mast);
      rects.forEach((r, i) => {
        const cx = (r.minX + r.maxX) / 2;
        const tipX = cx - 1.3;
        const boomLength = Math.hypot(tipX, 1.8);
        const boom = box(0.12, 0.12, boomLength, steel);
        boom.position.set(tipX / 2, BUS_BOOM_Y, -0.5 + 0.9);
        boom.rotation.y = Math.atan2(tipX, 1.8);
        g.add(boom);
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        if (!charging) {
          const h = heavyHandle(m.rubber);
          h.position.set(i === 0 ? -0.3 : 0.3, 1.2, 0.42);
          g.add(
            h,
            cable(
              [
                [tipX, BUS_BOOM_Y - 0.08, 1.3],
                [tipX * 0.7, 2.6, 1.0],
                [(i === 0 ? -0.3 : 0.3) * 1.5, 1.2, 0.7],
                [i === 0 ? -0.3 : 0.3, 1.35, 0.48],
              ],
              m.rubber,
              0.035,
            ),
          );
        }
      });
      top = BUS_BOOM_Y + 0.2;
    } else {
      // A depot pantograph pole at the head of the bays: the control module
      // with the screen on the pole (the power cabinet stands apart, up to
      // 100 m away), a steel pole to 5.24 m, a boom out over the bays and a
      // crossbar over two. Pantograph down (OppCharge): a scissor pantograph
      // under the boom over each bay, lowered onto the roof rails of a bus
      // that charges, raised otherwise (its contact head at about 4.6 m).
      // Pantograph up: a contact hood the bus roof pantograph rises into.
      const points = rects.map((r) => pantographPoint(r));
      const reachZ = points[0]?.z ?? 3.6;
      const columnZ = reachZ - MAST_OUTREACH_M;
      // The control module (ABB HVC-PD: 1600 by 1000 by 477 mm) on the bay side of the pole.
      const screen = cabinet(g, { x: 0, z: columnZ + 0.4 }, { w: 1.0, d: 0.48, h: 1.5 }, m);
      addScreenMessage(g, s, 'dc', [screen[0], screen[1], screen[2] + 0.002]);
      glow = cabinetGlow(g, s, screen);
      g.add(logoPanel(model, palette, { x: 0, z: columnZ + 0.4 }));
      const pad = box(1.4, 0.1, 1.2, concrete);
      pad.position.set(0, 0.05, columnZ + 0.4);
      const column = box(0.32, MAST_HEIGHT_M, 0.32, steel);
      column.position.set(0, MAST_HEIGHT_M / 2, columnZ);
      g.add(pad, column);
      const boom = box(0.24, 0.3, reachZ - columnZ + 0.5, steel);
      boom.position.set(0, MAST_BOOM_Y, (reachZ + columnZ) / 2);
      const strut = box(0.12, 0.12, 2.4, steel);
      strut.position.set(0, MAST_BOOM_Y - 0.75, columnZ + 0.85);
      strut.rotation.x = Math.atan2(1.4, 1.9);
      g.add(boom, strut);
      if (points.length > 1) {
        const xs = points.map((pt) => pt.x);
        const span = Math.max(...xs) - Math.min(...xs) + 0.4;
        const cross = box(span, 0.26, 0.24, steel);
        cross.position.set(0, MAST_BOOM_Y, reachZ);
        g.add(cross);
      }
      const head = M(SCENE_COLORS.rim, { roughness: 0.3, metalness: 0.8 });
      points.forEach((pt, i) => {
        const charging = s.prop === 'car' && (s.propSpot ?? 0) === i;
        if (model === 'pantograph_down') {
          // The pantograph kit, 1.3 m across and 0.9 m deep (ABB HVC-PD).
          const housing = box(1.3, 0.3, 0.9, steel);
          housing.position.set(pt.x, MAST_BOOM_Y - 0.25, pt.z);
          g.add(housing);
          // The scissor arms from the housing down to the contact head.
          const headY = charging ? pt.y + 0.04 : 4.55;
          const drop = MAST_BOOM_Y - 0.4 - headY;
          for (const side of [-1, 1]) {
            const arm = box(0.06, Math.hypot(drop, 0.5), 0.06, steel);
            arm.position.set(pt.x + side * 0.3, headY + drop / 2, pt.z);
            arm.rotation.z = side * Math.atan2(0.5, drop) * 0.6;
            const arm2 = box(0.06, Math.hypot(drop, 0.5), 0.06, steel);
            arm2.position.set(pt.x, headY + drop / 2, pt.z + side * 0.25);
            arm2.rotation.x = side * Math.atan2(0.5, drop) * 0.6;
            g.add(arm, arm2);
          }
          const contact = box(1.1, 0.06, 0.6, head);
          contact.position.set(pt.x, headY, pt.z);
          g.add(contact);
        } else {
          // The contact hood: an inverted channel the roof pantograph rises into.
          const hood = box(1.4, 0.12, 0.7, head);
          hood.position.set(pt.x, HOOD_Y + 0.06, pt.z);
          const hangerLength = MAST_BOOM_Y - 0.15 - (HOOD_Y + 0.12);
          const hanger = box(0.12, hangerLength, 0.12, steel);
          hanger.position.set(pt.x, HOOD_Y + 0.12 + hangerLength / 2, pt.z);
          g.add(hood, hanger);
        }
      });
      top = MAST_HEIGHT_M + 0.05;
    }
    return { top, glow };
  }

  // The vehicle, sign or cone in a bus bay or a truck lane (`rect`), and the
  // charging connection: the cable from the dispenser boom down to the charge
  // inlet, a pantograph on the bus roof rails, or the cable of a standard
  // charger. Returns where a driver avatar floats (above the vehicle roof).
  function placeLargeSpotProp(
    g: THREE.Group,
    s: SceneStation,
    t: Templates,
    rect: FreeSpotRect,
    model: FreeChargerModel,
  ): THREE.Vector3 | null {
    const truckLane = rect.heading === '+x';
    if (s.prop === 'cone') {
      const item = t.cone();
      // The templates stand 2.2 to 2.4 m into a car spot: move them into this one.
      if (truckLane) item.position.set(rect.chargerX - 2, 0, rect.minZ + 1.2 - 2.4);
      else item.position.set((rect.minX + rect.maxX) / 2, 0, 0.4);
      g.add(item);
      return null;
    }
    if (s.prop !== 'car') return null;
    const look = s.car ?? sceneCar(null);
    const pose = largeVehiclePose(rect, look.bodyType);
    const vehicle = t.vehicle(look);
    vehicle.position.set(pose.x, 0, pose.z);
    vehicle.rotation.y = pose.turn;
    g.add(vehicle);
    const rubber = M(SCENE_COLORS.rubber, { roughness: 0.9 });
    const p = pose.port;
    const portOut: [number, number, number] = truckLane
      ? [p.x, p.y, p.z - 0.15]
      : [p.x - 0.15, p.y, p.z];
    if (model === 'truck_mcs') {
      // From the outlet low on the dispenser across the island to the inlet.
      const out: [number, number, number] = [rect.chargerX + 0.22, 0.75, rect.chargerZ + 0.28];
      g.add(
        cable(
          [
            out,
            [(out[0] + p.x) / 2, 0.45, (out[2] + p.z) / 2],
            [p.x, p.y - 0.3, p.z - 0.45],
            portOut,
            [p.x, p.y, p.z],
          ],
          rubber,
          0.04,
        ),
      );
    } else if (model === 'bus_dispenser') {
      const tipX = (rect.minX + rect.maxX) / 2 - 1.3;
      g.add(
        cable(
          [
            [tipX, BUS_BOOM_Y - 0.08, 1.3],
            [(tipX + p.x) / 2, 2.8, (1.3 + p.z) / 2],
            [p.x - 0.4, p.y + 0.5, p.z],
            portOut,
            [p.x, p.y, p.z],
          ],
          rubber,
          0.035,
        ),
      );
    } else if (model === 'pantograph_up' && pose.roof != null) {
      // The bus roof pantograph raised into the hood.
      const steel = M(SCENE_COLORS.signPost, { roughness: 0.45, metalness: 0.6 });
      const rise = HOOD_Y - 0.06 - pose.roof.y;
      for (const side of [-1, 1]) {
        const arm = box(0.05, Math.hypot(rise, 0.4), 0.05, steel);
        arm.position.set(pose.roof.x + side * 0.25, pose.roof.y + rise / 2, pose.roof.z);
        arm.rotation.z = side * Math.atan2(0.4, rise) * 0.6;
        g.add(arm);
      }
      const bow = box(1.0, 0.05, 0.3, M(SCENE_COLORS.rim, { roughness: 0.3, metalness: 0.8 }));
      bow.position.set(pose.roof.x, HOOD_Y - 0.06, pose.roof.z);
      g.add(bow);
    } else if (model === 'standard') {
      // A standard charger at the head of the spot: down to the ground and along to the inlet.
      const start: [number, number, number] =
        s.kind === 'dc' ? [-0.44, 1.02, 0.12] : [-0.17, 0.95, 0.04];
      g.add(
        cable(
          [
            start,
            [start[0] - 0.1, 0.3, 0.35],
            [(start[0] + p.x) / 2, 0.08, (0.35 + p.z) / 2],
            [p.x - 0.35, 0.3, p.z],
            portOut,
            [p.x, p.y, p.z],
          ],
          rubber,
        ),
      );
    }
    vehicle.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vehicle);
    if (bounds.isEmpty()) return null;
    // Above the cab or the front of the body, not the middle of a long trailer.
    const front = truckLane
      ? new THREE.Vector3(pose.x - 2, bounds.max.y, pose.z)
      : new THREE.Vector3(pose.x, bounds.max.y, pose.z + 3);
    return new THREE.Vector3(front.x, front.y + AVATAR_ABOVE_ROOF_M, front.z);
  }

  // Sign posts placed so far in this build, in lot meters: two dual-port
  // pedestals side by side share the post on the line between their pairs
  // (its sign stands adjacent to both stalls).
  const signPosts: Point[] = [];

  function buildModel(s: SceneStation, palette: Palette, t: Templates): StationObject {
    const g = new THREE.Group();
    if (s.free != null) addFreeSpots(g, s, palette);
    const shell = M(palette.shell, { roughness: 0.35, metalness: 0.25 });
    const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
    const rubber = M(SCENE_COLORS.rubber, { roughness: 0.9 });
    const glass = M(SCENE_COLORS.glass, {
      roughness: 0.08,
      metalness: 0.3,
      emissive: s.lit ? SCENE_COLORS.screenGlow : '#000000',
      emissiveIntensity: s.lit ? 0.55 : 0,
    });
    const light = M(s.lightColor, {
      emissive: s.lightColor,
      emissiveIntensity: s.lit ? 0.9 : 0.05,
    });
    const accent = M(s.kind === 'dc' ? SCENE_COLORS.dc : SCENE_COLORS.ac, { roughness: 0.4 });
    const dc = s.kind === 'dc';
    const wall = s.wall && !dc;
    const large = s.charger != null && s.charger !== 'standard' ? s.charger : null;
    if (!wall && large == null) {
      const pad = box(
        dc ? 1.6 : 1.0,
        0.08,
        dc ? 1.2 : 0.9,
        M(palette.concrete, { roughness: 0.95 }),
      );
      pad.position.y = 0.04;
      g.add(pad);
    }
    let top: number;
    let labelZ = 0;
    let glow: StationObject['glow'] = null;
    // The wall box hangs on the facade behind its spot.
    const w = wallBoxOffset();
    if (large != null) {
      const built = buildLargeCharger(g, s, large, palette, {
        shell,
        dark,
        rubber,
        glass,
        light,
        accent,
      });
      top = built.top;
      glow = built.glow;
    } else if (wall) {
      const back = box(0.4, 0.54, 0.02, dark);
      back.position.set(0, 1.18, w + 0.01);
      const body = roundedPrism(0.34, 0.15, 0.48, 0.04, shell);
      body.position.set(0, 0.94, w + 0.095);
      const face = box(0.29, 0.42, 0.01, accent);
      face.position.set(0, 1.18, w + 0.176);
      const screen = box(0.13, 0.07, 0.01, glass);
      screen.position.set(0, 1.31, w + 0.183);
      addScreenMessage(g, s, 'ac', [0, 1.31, w + 0.1895]);
      const socket = cylinder(0.042, 0.03, 18, dark);
      socket.rotation.x = Math.PI / 2;
      socket.position.set(0, 1.1, w + 0.19);
      const bar = box(0.2, 0.022, 0.01, light);
      bar.position.set(0, 1.4, w + 0.183);
      const holster = box(0.05, 0.16, 0.08, dark);
      holster.position.set(0.24, 1.08, w + 0.08);
      const h = handle(rubber);
      h.position.set(0.24, 1.05, w + 0.13);
      const conduit = cylinder(0.025, 0.94, 10, M(SCENE_COLORS.signPost, { metalness: 0.5 }));
      conduit.position.set(-0.12, 0.47, w + 0.04);
      g.add(back, body, face, screen, socket, bar, holster, h, conduit);
      for (let i = 0; i < 3; i++) {
        const coil = shadowed(
          new THREE.Mesh(track(new THREE.TorusGeometry(0.11, 0.016, 8, 28)), rubber),
        );
        coil.position.set(0.0, 0.66, w + 0.07 + i * 0.02);
        g.add(coil);
      }
      glow = addGlow(g, s, [{ geometry: socketRing(0.062), position: [0, 1.1, w + 0.2] }], {
        size: 0.55,
        position: [0, 1.18, w + 0.21],
      });
      // The status marker floats above the R7-113 on the facade over the wall
      // box (its top 2.59 m, 2.9 m with the California tow-away sign below).
      top = 3.0;
      labelZ = w + 0.2;
    } else if (dc && s.dispensers != null && s.dispensers.length > 1) {
      // A DC split system: a slim satellite dispenser in the head of each of
      // its stalls (Kempower S-Series: 300 x 1518 x 300 mm), one holstered
      // cable per connector of its EVSE; the power cabinet that feeds them
      // stands on the equipment pad. The screen message and the glow are on
      // the first; status and power are the station's.
      const sat = SPLIT_SYSTEM.dispenser;
      s.dispensers.forEach((dx, i) => {
        const unit = new THREE.Group();
        unit.position.x = dx;
        const body = roundedPrism(sat.widthM, sat.depthM, sat.heightM, 0.04, shell);
        body.position.y = 0.1;
        const foot = box(sat.widthM + 0.08, 0.1, sat.depthM + 0.08, dark);
        foot.position.y = 0.05;
        const roof = box(sat.widthM + 0.04, 0.05, sat.depthM + 0.04, accent);
        roof.position.y = 0.1 + sat.heightM;
        const screen = box(0.2, 0.15, 0.015, glass);
        screen.position.set(0, 1.3, sat.depthM / 2 + 0.008);
        unit.add(body, foot, roof, screen);
        if (i === 0) addScreenMessage(unit, s, 'ac', [0, 1.3, sat.depthM / 2 + 0.017]);
        for (const { side, dropM } of dispenserHolsters(s.cables?.[i] ?? 1)) {
          const x = side * (sat.widthM / 2 + 0.03);
          const holster = box(0.05, 0.2, 0.1, dark);
          holster.position.set(x, 1.0 - dropM, 0.05);
          const h = handle(rubber);
          h.position.set(x + side * 0.03, 0.98 - dropM, 0.08);
          h.rotation.z = side * -0.15;
          unit.add(
            holster,
            h,
            cable(
              [
                [x, 1.2 - dropM, -0.08],
                [x + side * 0.1, 0.8 - dropM * 0.5, -0.03],
                [x + side * 0.16, 0.3, 0.05],
                [x + side * 0.14, 0.14, 0.15],
                [x + side * 0.1, 0.5, 0.15],
                [x + side * 0.04, 0.9 - dropM, 0.08],
              ],
              rubber,
            ),
          );
        }
        const bollardPaint = M(SCENE_COLORS.bollard, { roughness: 0.5 });
        for (const bx of [-0.45, 0.45]) {
          const post = cylinder(0.07, 0.9, 16, bollardPaint);
          post.position.set(bx, 0.45, 0.5);
          unit.add(post);
        }
        g.add(unit);
      });
      const first = s.dispensers[0] ?? 0;
      glow = addGlow(
        g,
        s,
        [
          {
            geometry: new THREE.BoxGeometry(0.26, 0.02, 0.012),
            position: [first, 1.39, sat.depthM / 2 + 0.012],
          },
          {
            geometry: new THREE.BoxGeometry(0.26, 0.02, 0.012),
            position: [first, 1.21, sat.depthM / 2 + 0.012],
          },
        ],
        { size: 0.7, position: [first, 1.3, sat.depthM / 2 + 0.03] },
      );
      top = 1.8;
    } else if (dc) {
      const body = roundedPrism(0.78, 0.55, 1.78, 0.08, shell);
      body.position.y = 0.08;
      g.add(body);
      const plinth = box(0.82, 0.08, 0.59, dark);
      plinth.position.y = 0.12;
      g.add(plinth);
      for (const side of [-1, 1]) {
        const stripe = box(0.01, 1.2, 0.18, accent);
        stripe.position.set(side * 0.405, 1.05, 0.12);
        g.add(stripe);
      }
      const bezel = box(0.5, 0.42, 0.02, dark);
      bezel.position.set(0, 1.42, 0.29);
      const screen = box(0.44, 0.34, 0.02, glass);
      screen.position.set(0, 1.42, 0.3);
      addScreenMessage(g, s, 'dc', [0, 1.42, 0.3115]);
      const reader = box(0.12, 0.12, 0.02, dark);
      reader.position.set(0.16, 1.08, 0.29);
      const bar = box(0.6, 0.035, 0.02, light);
      bar.position.set(0, 1.74, 0.29);
      const cap = box(0.86, 0.06, 0.62, dark);
      cap.position.y = 1.9;
      g.add(bezel, screen, reader, bar, cap);
      // The charging glow: a frame around the screen bezel.
      glow = addGlow(
        g,
        s,
        [
          { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [0, 1.645, 0.302] },
          { geometry: new THREE.BoxGeometry(0.58, 0.026, 0.012), position: [0, 1.195, 0.302] },
          { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [-0.277, 1.42, 0.302] },
          { geometry: new THREE.BoxGeometry(0.026, 0.476, 0.012), position: [0.277, 1.42, 0.302] },
        ],
        { size: 1.0, position: [0, 1.42, 0.315] },
      );
      // One holstered cable per connector (`dispenserHolsters`): a CCS and
      // CHAdeMO dispenser two, a triple-outlet one three.
      for (const { side, dropM } of dispenserHolsters(s.cables?.[0] ?? 2)) {
        const x = side * 0.39;
        const holster = box(0.06, 0.24, 0.14, dark);
        holster.position.set(x + side * 0.035, 1.05 - dropM, 0.08);
        const h = handle(rubber);
        h.position.set(x + side * 0.08, 1.03 - dropM, 0.1);
        h.rotation.z = side * -0.15;
        g.add(
          holster,
          h,
          cable(
            [
              [x, 1.32 - dropM, -0.12],
              [x + side * 0.12, 0.9 - dropM * 0.5, -0.05],
              [x + side * 0.22, 0.3, 0.05],
              [x + side * 0.2, 0.14, 0.18],
              [x + side * 0.16, 0.5, 0.2],
              [x + side * 0.09, 0.93 - dropM, 0.12],
            ],
            rubber,
          ),
        );
      }
      const bollardPaint = M(SCENE_COLORS.bollard, { roughness: 0.5 });
      for (const bx of [-0.62, 0.62]) {
        const post = cylinder(0.07, 0.9, 16, bollardPaint);
        post.position.set(bx, 0.45, 0.62);
        g.add(post);
      }
      top = 2.15;
    } else {
      const post = roundedPrism(0.2, 0.16, 0.95, 0.04, shell);
      post.position.y = 0.08;
      const head = roundedPrism(0.34, 0.18, 0.5, 0.05, shell);
      head.position.y = 1.0;
      const face = box(0.3, 0.44, 0.012, accent);
      face.position.set(0, 1.25, 0.097);
      const screen = box(0.14, 0.09, 0.012, glass);
      screen.position.set(0, 1.38, 0.105);
      addScreenMessage(g, s, 'ac', [0, 1.38, 0.1115]);
      const socket = cylinder(0.045, 0.03, 18, dark);
      socket.rotation.x = Math.PI / 2;
      socket.position.set(0, 1.16, 0.11);
      const bar = box(0.22, 0.025, 0.012, light);
      bar.position.set(0, 1.47, 0.105);
      const hook = cylinder(0.025, 0.12, 10, dark);
      hook.rotation.z = Math.PI / 2;
      hook.position.set(0.16, 0.85, 0);
      g.add(post, head, face, screen, socket, bar, hook);
      // The charging glow: a ring around the socket.
      glow = addGlow(g, s, [{ geometry: socketRing(0.066), position: [0, 1.16, 0.122] }], {
        size: 0.55,
        position: [0, 1.22, 0.13],
      });
      for (let i = 0; i < 3; i++) {
        const coil = shadowed(
          new THREE.Mesh(track(new THREE.TorusGeometry(0.13, 0.018, 8, 28)), rubber),
        );
        coil.rotation.y = Math.PI / 2;
        coil.position.set(0.2 + i * 0.022, 0.73, 0);
        g.add(coil);
      }
      const holster = box(0.05, 0.18, 0.1, dark);
      holster.position.set(-0.13, 0.98, 0.02);
      const h = handle(rubber);
      h.position.set(-0.17, 0.97, 0.03);
      g.add(
        holster,
        h,
        cable(
          [
            [0.0, 1.0, -0.06],
            [0.15, 0.92, -0.04],
            [0.2, 0.86, 0.0],
          ],
          rubber,
        ),
      );
      top = 1.7;
    }
    // The logo: on the back of a dispenser or pedestal, on the front of a wall
    // box (its back is on the wall); the large models carry theirs on their cabinet.
    if (wall) g.add(logoPanel('wall', palette, { x: 0, z: w }));
    else if (large == null) g.add(logoPanel(dc ? 'dc' : 'ac', palette));
    // Payment terminals on the front: on the side of their connector, or centered for the station.
    s.terminals.forEach((terminal, i) => {
      const reader = t.terminal(terminal.hasDisplay, terminal.online);
      // Where real installs mount it, its card interface within reach (`readerMount`).
      const at = readerMount(dc ? 'dc' : 'ac', wall, terminal.side, i, w);
      reader.position.set(at.x, at.y, at.z);
      // A little larger than life, so the reader reads at site scale.
      reader.scale.setScalar(1.5);
      reader.userData['terminalId'] = terminal.id;
      g.add(reader);
    });
    const ringMaterial = track(
      new THREE.MeshBasicMaterial({
        color: theme.primary,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      }),
    );
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(1.0, 1.12, 48)), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    // Under a wall box, on the sidewalk in front of it.
    ring.position.set(0, wall ? 0.14 : 0.09, wall ? w + 0.7 : 0);
    ring.userData['ring'] = true;
    g.add(ring);
    if (s.beacon) g.add(buildBeacon(top, labelZ));
    // Where a driver avatar floats: above the middle of the car roof, measured
    // on the model in the station's own frame (before the group moves or merges).
    let avatarAnchor: THREE.Vector3 | null = null;
    const curbside = layout.lot.siteType === 'curbside' && isSpot(s.bay, layout.lot);
    const largeSpot = s.free != null && freeSpotTypeOf(s.free) !== 'car';
    // A concrete wheel stop in front of each AC spot (WHEEL_STOP, wheelStopMount).
    const stopMount = wheelStopMount({
      siteType: layout.lot.siteType,
      kind: s.kind,
      wall,
      onSpot: isSpot(s.bay, layout.lot),
      largeSpot,
      curb: chargerAtCurb(s.bay, layout.lot, s.kind, wall),
    });
    // The EV charging signs of the stall (site-layout-signs.ts).
    const signMount = stationSignMount({
      siteType: layout.lot.siteType,
      onSpot: isSpot(s.bay, layout.lot),
      wall,
      freeSpots: s.free != null ? (s.spots ?? 1) : null,
      largeSpot,
      california: layout.california === true,
      wallZ: wallBoxOffset() + FACADE_SIGN_STANDOFF_M,
    });
    if (signMount != null) {
      // One R7-113 per stall: a pedestal's two stalls put their posts at the
      // outer side lines (clear of the pedestal on the line between them),
      // the accessible space at the side line of its vehicle space.
      const stalls = s.free == null && !wall ? s.stalls : undefined;
      const postXs =
        stalls == null || layout.lot.siteType === 'curbside'
          ? [signMount.x]
          : stalls.map((st, i) =>
              stalls.length > 1 && i === stalls.length - 1
                ? st.x + st.width / 2 - SIGN_POST_INSET_M
                : st.x - st.width / 2 + SIGN_POST_INSET_M,
            );
      const pose = poseOf(s);
      for (const x of postXs) {
        // The post in lot meters (the station turns by 0 or a half turn on a grid site).
        const at = {
          x: pose.point.x + x * Math.cos(pose.turn),
          z: pose.point.z - x * Math.sin(pose.turn),
        };
        if (
          s.free == null &&
          signPosts.some((o) => Math.abs(o.x - at.x) < 0.5 && Math.abs(o.z - at.z) < 0.5)
        ) {
          continue;
        }
        signPosts.push(at);
        const signs = t.evSigns(signMount);
        signs.position.set(x, 0, signMount.z);
        g.add(signs);
      }
    }
    if (stopMount != null) {
      const spotXs =
        s.free != null
          ? freeSpotRects(s.spots ?? 1, 'car').map((r) => (r.minX + r.maxX) / 2)
          : (s.stalls?.map((st) => st.x) ?? [0]);
      for (const x of spotXs) {
        const stop = t.wheelStop();
        stop.position.x = x;
        stop.position.z = wheelStopCenterZ(stopMount);
        g.add(stop);
      }
    }
    if (largeSpot && s.free != null) {
      const rects = freeSpotRects(s.spots ?? 1, freeSpotTypeOf(s.free));
      const rect = rects[Math.min(rects.length - 1, s.propSpot ?? 0)] ?? rects[0];
      if (rect != null) {
        const anchor = placeLargeSpotProp(g, s, t, rect, s.charger ?? 'standard');
        if (anchor != null) avatarAnchor = anchor;
      }
    } else if (s.stallCars != null && s.stalls != null && !curbside && !wall) {
      // A dual-port pedestal: a vehicle in each stall with a session, each on its own cable.
      s.stallCars.forEach((look, i) => {
        const stall = s.stalls?.[i];
        if (look == null || stall == null) return;
        const noseZ =
          stopMount != null && !isLargeBodyType(look.bodyType)
            ? carNoseAtStop(stopMount, CAR_PROFILES[look.bodyType])
            : undefined;
        const car = t.car(look, noseZ);
        car.position.x += stall.x;
        g.add(car, t.cable(s.kind, look.bodyType, stall.x, noseZ));
        if (avatarAnchor == null) {
          car.updateMatrixWorld(true);
          const roof = new THREE.Box3().setFromObject(car);
          if (!roof.isEmpty()) {
            const c = roof.getCenter(new THREE.Vector3());
            avatarAnchor = new THREE.Vector3(c.x, roof.max.y + AVATAR_ABOVE_ROOF_M, c.z);
          }
        }
      });
    } else if (s.prop === 'car') {
      const look = s.car ?? sceneCar(null);
      // Against the wheel stop where the spot has one (AC spots), else nose to the charger.
      const noseZ =
        stopMount != null && !isLargeBodyType(look.bodyType)
          ? carNoseAtStop(stopMount, CAR_PROFILES[look.bodyType])
          : undefined;
      const car = curbside ? t.carParallel(look) : t.car(look, noseZ);
      const offsetX = curbside || wall ? 0 : (s.carOffsetX ?? 0);
      car.position.x += offsetX;
      g.add(
        car,
        t.cable(
          curbside ? `curb-${s.kind}` : wall ? 'wall' : s.kind,
          look.bodyType,
          offsetX,
          noseZ,
        ),
      );
      car.updateMatrixWorld(true);
      const roof = new THREE.Box3().setFromObject(car);
      if (!roof.isEmpty()) {
        const c = roof.getCenter(new THREE.Vector3());
        avatarAnchor = new THREE.Vector3(c.x, roof.max.y + AVATAR_ABOVE_ROOF_M, c.z);
      }
    }
    if (largeSpot) {
      // Placed with the vehicle above.
    } else if (s.prop === 'cone') {
      const cone = t.cone();
      // At a curb the cone stands in the parking lane in front of the post.
      if (curbside) cone.position.set(2.2, 0, CURB_POST_BACK_M + 1.2);
      else cone.position.x += s.carOffsetX ?? 0;
      g.add(cone);
    }
    // The virtual status sign floats over the spot (a large spot: over its
    // middle; at a curb: over the parking lane), clear of the charger and a car.
    let virtualSign: THREE.Sprite | null = null;
    if (s.virtualSign != null) {
      virtualSign = virtualSignSprite(s.virtualSign, s.id);
      if (largeSpot && s.free != null) {
        const rects = freeSpotRects(s.spots ?? 1, freeSpotTypeOf(s.free));
        const rect = rects[Math.min(rects.length - 1, s.propSpot ?? 0)] ?? rects[0];
        virtualSign.position.set(
          rect != null ? (rect.minX + rect.maxX) / 2 : 0,
          VIRTUAL_SIGN_Y_M + 1.5,
          rect != null ? (rect.minZ + rect.maxZ) / 2 : 2.6,
        );
      } else if (curbside) {
        virtualSign.position.set(2.2, VIRTUAL_SIGN_Y_M, CURB_POST_BACK_M + 1.2);
      } else {
        virtualSign.position.set(
          s.stallCars != null ? 0 : (s.carOffsetX ?? 0),
          VIRTUAL_SIGN_Y_M,
          2.6,
        );
      }
      g.add(virtualSign);
    }
    g.traverse((o) => {
      o.userData['stationId'] = s.id;
    });
    // The rotation handle is picked apart from the station (its own userData).
    const rotateHandle =
      s.free != null && layout.lot.siteType === 'custom'
        ? freeHandle(
            s.id,
            rotationHandleZ(s.spots ?? 1, freeSpotTypeOf(s.free)),
            freeSpotsExtent(s.spots ?? 1, freeSpotTypeOf(s.free)).back,
          )
        : null;
    if (rotateHandle != null) g.add(rotateHandle);
    // A turned row faces the lane before it, a free station turns by its own
    // turn: the charger, its props, card readers and back panel all turn with the group.
    const pose = poseOf(s);
    g.position.copy(lotPoint(pose.point));
    g.rotation.y = pose.turn;
    return {
      group: g,
      ring,
      light,
      glow,
      top,
      labelZ,
      avatarAnchor,
      virtualSign,
      handle: rotateHandle,
      station: s,
    };
  }

  // A solar carport canopy (site-layout-solar.ts): a single cantilever over
  // one row or a double cantilever "T" over an island's two rows, of
  // galvanized steel. Concrete piers rise above the paving as the columns'
  // bollards, each with a base plate and a W-shape column; a tapered girder
  // on top of each column runs across the stalls, C-channel purlins run
  // along the row on top of the girders, and the module plane rests on the
  // purlins, rising from the column line at the canopy tilt. Built in the
  // canopy frame: x along the row, z = u across it, y up.
  function buildCarport(frame: CarportFrame, palette: Palette): THREE.Group {
    const g = new THREE.Group();
    const c = SOLAR_CARPORT;
    const steel = M(SCENE_COLORS.galvanizedSteel, { roughness: 0.55, metalness: 0.6 });
    const concrete = M(palette.concrete, { roughness: 0.9 });
    const columnBottom = frame.pierTopY + c.basePlateThickM;
    const columnH = frame.columnTopY - columnBottom;
    const flangeT = 0.02;
    const webT = 0.012;
    for (const x of frame.columnXs) {
      const u = frame.columnU;
      const pier = cylinder(c.pierDiameterM / 2, frame.pierTopY, 24, concrete);
      pier.position.set(x, frame.pierTopY / 2, u);
      const plate = box(c.basePlateM, c.basePlateThickM, c.basePlateM, steel);
      plate.position.set(x, frame.pierTopY + c.basePlateThickM / 2, u);
      g.add(pier, plate);
      // W-shape column: the web across the stalls (the strong axis carries
      // the cantilever), the flanges at its back and front.
      for (const side of [-1, 1]) {
        const flange = box(c.columnFlangeM, columnH, flangeT, steel);
        flange.position.set(
          x,
          columnBottom + columnH / 2,
          u + side * (c.columnDepthM / 2 - flangeT / 2),
        );
        g.add(flange);
      }
      const web = box(webT, columnH, c.columnDepthM - 2 * flangeT, steel);
      web.position.set(x, columnBottom + columnH / 2, u);
      g.add(web);
      // The girder over the full depth, its bottom on the column top, tapered
      // to the tip of each cantilever (one for a single cantilever, two for a
      // double cantilever on an island).
      const shape = new THREE.Shape();
      shape.moveTo(0, frame.girderBottomAt(0));
      shape.lineTo(frame.columnU, frame.girderBottomAt(frame.columnU));
      shape.lineTo(frame.depthM, frame.girderBottomAt(frame.depthM));
      shape.lineTo(frame.depthM, frame.girderTopAt(frame.depthM));
      shape.lineTo(0, frame.girderTopAt(0));
      shape.closePath();
      const geometry = track(
        new THREE.ExtrudeGeometry(shape, { depth: c.girderWidthM, bevelEnabled: false }),
      );
      // Shape x becomes u (z), the extrusion runs along x, centered on the column.
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(x + c.girderWidthM / 2, 0, 0);
      g.add(shadowed(new THREE.Mesh(geometry, steel)));
    }
    const length = frame.maxX - frame.minX;
    for (const p of frame.purlins) {
      const purlin = box(length, p.topY - p.bottomY, c.purlinWidthM, steel);
      purlin.position.set((frame.minX + frame.maxX) / 2, (p.topY + p.bottomY) / 2, p.u);
      g.add(purlin);
    }
    const panelTexture = solarTexture(palette).clone();
    track(panelTexture);
    panelTexture.needsUpdate = true;
    // Texture only: portrait modules about a meter wide along the row.
    panelTexture.repeat.set(Math.max(1, Math.round(length)), frame.moduleRows);
    const slant = frame.depthM / Math.cos(frame.tiltRad);
    const roof = new THREE.Mesh(
      track(new THREE.BoxGeometry(length, c.moduleThicknessM, slant)),
      M('#ffffff', { map: panelTexture, roughness: 0.25, metalness: 0.55 }),
    );
    roof.castShadow = true;
    roof.receiveShadow = true;
    roof.rotation.x = -frame.tiltRad;
    roof.position.set(
      (frame.minX + frame.maxX) / 2,
      frame.moduleBottomAt(frame.depthM / 2) + c.moduleThicknessM / 2 / Math.cos(frame.tiltRad),
      frame.depthM / 2,
    );
    g.add(roof);
    return g;
  }

  // The stations of a custom site or depot (their chargers and spots) in the
  // frame of a free canopy: x along it, u across from its back edge.
  function freeCanopyObstacles(
    free: FreePlacement & { lengthM: number; depthM: number },
  ): CanopyObstacle[] {
    const turn = (free.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    return layout.stations.flatMap((s) => {
      if (s.free == null) return [];
      return [
        freeFootprint(s.free, s.spots ?? 1).map((p) => {
          const dx = p.x - free.x;
          const dz = p.z - free.z;
          return { x: dx * cos + dz * sin, u: -dx * sin + dz * cos + free.depthM / 2 };
        }),
      ];
    });
  }

  // A solar carport canopy standing freely (custom site): the columns along
  // its back long side, clear of the stations under it, the canopy over its
  // full size, turned by its turn.
  function buildFreeSolarCanopy(
    free: FreePlacement & { lengthM: number; depthM: number },
    palette: Palette,
  ): THREE.Group {
    const g = new THREE.Group();
    const half = SOLAR_CARPORT.columnDepthM / 2;
    const frame = carportFrame(
      -free.lengthM / 2,
      free.lengthM / 2,
      free.depthM,
      clearColumnXs(
        freeColumnXs(free.lengthM),
        half,
        -free.lengthM / 2,
        free.lengthM / 2,
        freeCanopyObstacles(free),
      ),
    );
    const carport = buildCarport(frame, palette);
    carport.position.z = -free.depthM / 2;
    g.add(carport);
    g.position.set(free.x, 0, free.z);
    g.rotation.y = (-free.rotationDeg * Math.PI) / 180;
    return g;
  }

  // The middle of a row of spots across the rows (lot z).
  function rowCenterZ(row: number): number {
    return rowFrontZ(row, layout.lot) + layout.lot.spotD / 2;
  }

  // The stall lines of `rows` no canopy column may stand on: the line of a
  // dual-port pedestal between its two spots, and the lines across the
  // accessible charging space and its access aisle.
  function blockedColumnLines(rows: readonly number[]): Set<number> {
    const lot = layout.lot;
    const lines = new Set<number>();
    for (const s of layout.stations) {
      if (s.free != null || !rows.includes(s.bay.row) || (s.stalls?.length ?? 0) < 2) continue;
      const line = poseOf(s).point.x / lot.spotW;
      if (Math.abs(line - Math.round(line)) < 0.01) lines.add(Math.round(line));
    }
    const a = layout.accessible;
    if (a != null) {
      const minZ = Math.min(a.vehicle.minZ, a.aisle.minZ);
      const maxZ = Math.max(a.vehicle.maxZ, a.aisle.maxZ);
      const inRows = rows.some((r) => {
        const front = rowFrontZ(r, lot);
        return maxZ > front + 0.01 && minZ < front + lot.spotD - 0.01;
      });
      if (inRows) {
        const minX = Math.min(a.vehicle.minX, a.aisle.minX);
        const maxX = Math.max(a.vehicle.maxX, a.aisle.maxX);
        for (let l = Math.ceil(minX / lot.spotW - 0.01); l * lot.spotW <= maxX + 0.01; l++) {
          lines.add(l);
        }
      }
    }
    return lines;
  }

  // The canopy over a row of spots (`rowCarport`), clear of the pedestals
  // and accessible space on its stall lines: a single cantilever, or a
  // double cantilever over both rows of an island.
  function solarRowCarport(row: number): RowCarport {
    const first = rowCarport(row, layout.lot);
    return rowCarport(row, layout.lot, blockedColumnLines(first.rows));
  }

  // A solar carport canopy over a row of spots: its columns at the head of
  // the stalls, on the island middle or past the lot edge, the canopy over
  // the stalls up to the drive aisle.
  function buildSolarCanopy(carport: RowCarport, palette: Palette): THREE.Group {
    const g = buildCarport(carport.frame, palette);
    g.position.z = carport.backZ;
    // u grows toward the aisle: a row whose head is at its back edge mirrors.
    g.scale.z = carport.dirZ;
    return g;
  }

  let solarTextureCache: THREE.CanvasTexture | null = null;
  function solarTexture(palette: Palette): THREE.CanvasTexture {
    if (solarTextureCache != null) return solarTextureCache;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = palette.solarFrame;
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = palette.solarCell;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) ctx.fillRect(2 + x * 15.5, 2 + y * 15.5, 13.5, 13.5);
      }
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    solarTextureCache = texture;
    return texture;
  }

  // A faulted station's beacon: a red lamp on a short mast above the charger,
  // with a soft additive halo. Never picked apart from its station.
  function buildBeacon(top: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const mast = cylinder(0.02, 0.28, 8, M(SCENE_COLORS.dark1, { roughness: 0.6 }));
    mast.position.set(0, top + 0.14, z * 0.2);
    const core = M(SCENE_COLORS.beacon, {
      emissive: SCENE_COLORS.beacon,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    });
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.11, 16, 12)), core);
    lamp.position.set(0, top + 0.36, z * 0.2);
    const haloMaterial = track(
      new THREE.MeshBasicMaterial({
        color: SCENE_COLORS.beacon,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const halo = new THREE.Mesh(track(new THREE.SphereGeometry(0.32, 16, 12)), haloMaterial);
    halo.position.copy(lamp.position);
    halo.raycast = () => undefined;
    halo.renderOrder = 2;
    g.add(mast, lamp, halo);
    g.userData['beacon'] = true;
    beacons.push({ core, halo: haloMaterial });
    return g;
  }

  // The building of an office or retail site along the front of the lot: a
  // solid ground floor with a high window strip above the wall boxes, a
  // window band with mullions on the upper floor, a cornice, the entrance with
  // glass doors and a canopy on the part right of the lot, and the sidewalk
  // with its curb in front of it.
  function buildBuilding(palette: Palette): void {
    const b = buildingBox(layout.lot);
    const width = b.maxX - b.minX;
    const depth = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const H = BUILDING_HEIGHT_M;
    const wallMaterial = M(palette.building, { roughness: 0.85 });
    const baseMaterial = M(palette.buildingBase, { roughness: 0.8 });
    const trim = M(palette.buildingTrim, { roughness: 0.6, metalness: 0.2 });
    const glassMaterial = M(palette.window, {
      roughness: 0.1,
      metalness: 0.5,
      emissive: theme.dark ? SCENE_COLORS.windowLight : '#000000',
      emissiveIntensity: theme.dark ? 0.35 : 0,
    });
    const concrete = M(palette.sidewalk, { roughness: 0.95 });
    const mass = box(width, H, depth, wallMaterial);
    mass.position.set(cx, H / 2, b.minZ + depth / 2);
    site.add(mass);
    const base = box(width, 3.2, 0.06, baseMaterial);
    base.position.set(cx, 1.6, FACADE_Z + 0.03);
    site.add(base);
    const strip = box(width - 1, 0.6, 0.04, glassMaterial);
    strip.position.set(cx, 2.6, FACADE_Z + 0.08);
    site.add(strip);
    const slab = box(width, 0.26, 0.3, trim);
    slab.position.set(cx, 3.4, FACADE_Z + 0.15);
    site.add(slab);
    const band = box(width - 1, 2.1, 0.04, glassMaterial);
    band.position.set(cx, 5.05, FACADE_Z + 0.03);
    site.add(band);
    const mullions = Math.floor((width - 1) / 1.6);
    for (let i = 0; i <= mullions; i++) {
      const m = box(0.08, 2.1, 0.08, trim);
      m.position.set(b.minX + 0.5 + i * 1.6, 5.05, FACADE_Z + 0.06);
      site.add(m);
    }
    const cornice = box(width + 0.4, 0.45, 0.6, trim);
    cornice.position.set(cx, H + 0.1, FACADE_Z - 0.2);
    site.add(cornice);
    // The entrance, on the building part right of the lot.
    const ex = layout.lot.width + (b.maxX - layout.lot.width) / 2;
    const doors = box(3.0, 2.5, 0.06, glassMaterial);
    doors.position.set(ex, 1.25, FACADE_Z + 0.09);
    const frameTop = box(3.2, 0.12, 0.1, trim);
    frameTop.position.set(ex, 2.56, FACADE_Z + 0.1);
    site.add(doors, frameTop);
    for (const dx of [-1.55, 0, 1.55]) {
      const post = box(0.1, 2.5, 0.1, trim);
      post.position.set(ex + dx, 1.25, FACADE_Z + 0.1);
      site.add(post);
    }
    const canopy = box(4.6, 0.18, 2.4, trim);
    canopy.position.set(ex, 3.05, FACADE_Z + 1.2);
    const fascia = box(4.6, 0.36, 0.06, M(SCENE_COLORS.ac, { roughness: 0.4 }));
    fascia.position.set(ex, 3.05, FACADE_Z + 2.42);
    site.add(canopy, fascia);
    for (const dx of [-2.1, 2.1]) {
      const rod = cylinder(0.045, 2.96, 10, trim);
      rod.position.set(ex + dx, 1.48, FACADE_Z + 2.2);
      site.add(rod);
    }
    // The sidewalk from the facade to the front curb of the lot.
    const walk = box(width, 0.12, -CURB_M - FACADE_Z, concrete);
    walk.position.set(cx, 0.06, (FACADE_Z - CURB_M) / 2);
    site.add(walk);
  }

  // A depot yard (`depotLayout`): the paved yard, the concrete
  // strip behind the bus bay heads, the bay lines, the truck lanes with their
  // edge lines and entry and exit arrows (trucks drive through in +x), the
  // raised dispenser islands with bollards, the one-way arrows of the truck
  // entry road (away from the drive lane) and exit road (back to it), the
  // dashed center line of the two-way drive lane and the curbed median
  // between the areas.
  function buildDepotYard(palette: Palette, depot: DepotLayout): void {
    const shape = new THREE.Shape();
    depot.outline.forEach((p, i) => {
      // The shape lies in x, y; turned flat, y becomes -z.
      if (i === 0) shape.moveTo(p.x, -p.z);
      else shape.lineTo(p.x, -p.z);
    });
    const yardGeometry = track(new THREE.ShapeGeometry(shape));
    yardGeometry.rotateX(-Math.PI / 2);
    const yard = new THREE.Mesh(
      yardGeometry,
      M(palette.asphalt, { roughness: 0.95, metalness: 0 }),
    );
    yard.position.y = 0.012;
    yard.receiveShadow = true;
    site.add(yard);
    const paint = M(palette.paint, { roughness: 0.6 });
    const concrete = M(palette.concrete, { roughness: 0.95 });
    const curb = M(palette.curb, { roughness: 0.9 });
    const line = (w: number, d: number, x: number, z: number): void => {
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.006, d)), paint);
      m.position.set(x, 0.026, z);
      m.receiveShadow = true;
      site.add(m);
    };
    const arrow = arrowGeometry();
    // An arrow on the ground pointing along `turn` (0: +x; three.js turn about y).
    const mark = (x: number, z: number, turn: number): void => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(arrow, paint);
      m.rotation.x = -Math.PI / 2;
      g.add(m);
      g.position.set(x, 0.027, z);
      g.rotation.y = turn;
      site.add(g);
    };
    if (depot.busHead != null) {
      const h = depot.busHead;
      const strip = box(h.maxX - h.minX, 0.04, h.maxZ - h.minZ, concrete);
      strip.position.set((h.minX + h.maxX) / 2, 0.02, (h.minZ + h.maxZ) / 2);
      strip.receiveShadow = true;
      site.add(strip);
      const edge = box(h.maxX - h.minX, 0.14, 0.2, curb);
      edge.position.set((h.minX + h.maxX) / 2, 0.07, h.maxZ - 0.1);
      site.add(edge);
    }
    // A line on each side of each bus bay.
    const bayXs = new Set<number>();
    for (const b of depot.bays) {
      bayXs.add(b.minX);
      bayXs.add(b.maxX);
    }
    for (const x of bayXs) line(0.12, 13.2, x, 0.3 + 6.6);
    depot.lanes.forEach((lane, i) => {
      const cz = (lane.minZ + lane.maxZ) / 2;
      const length = lane.maxX - lane.minX;
      // The edge line on the drive lane side of the first lane; the others meet an island.
      if (i === 0) line(length - 0.6, 0.12, (lane.minX + lane.maxX) / 2, lane.maxZ - 0.15);
      mark(lane.minX + 3.5, cz, 0);
      mark(lane.maxX - 2.2, cz, 0);
    });
    const bollardPaint = M(SCENE_COLORS.bollard, { roughness: 0.5 });
    for (const island of depot.islands) {
      const cz = (island.minZ + island.maxZ) / 2;
      const length = island.maxX - island.minX - 2;
      const slab = box(length, 0.15, island.maxZ - island.minZ - 0.3, concrete);
      slab.position.set((island.minX + island.maxX) / 2, 0.075, cz);
      site.add(slab);
      for (const bx of [island.minX + 1.3, island.maxX - 1.3]) {
        const post = cylinder(0.1, 1.0, 16, bollardPaint);
        post.position.set(bx, 0.65, cz);
        site.add(post);
      }
    }
    if (depot.entryRoad != null) {
      const r = depot.entryRoad;
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.maxZ - 4; z > r.minZ + 2; z -= 12) mark(cx, z, Math.PI / 2);
    }
    if (depot.exitRoad != null) {
      const r = depot.exitRoad;
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.minZ + 4; z < r.maxZ - 2; z += 12) mark(cx, z, -Math.PI / 2);
    }
    // The drive lane: a dashed center line (3 m dashes every 6 m), two-way,
    // on each stretch (the truck stretch is wider).
    for (const lane of depot.driveLanes) {
      const centerZ = (lane.minZ + lane.maxZ) / 2;
      for (let x = lane.minX + 3; x + 3 <= lane.maxX; x += 6) line(3, 0.12, x + 1.5, centerZ);
    }
    if (depot.median != null) {
      const m = depot.median;
      const kerb = box(m.maxX - m.minX, 0.15, m.maxZ - m.minZ, curb);
      kerb.position.set((m.minX + m.maxX) / 2, 0.075, (m.minZ + m.maxZ) / 2);
      const planting = box(m.maxX - m.minX - 0.3, 0.02, m.maxZ - m.minZ - 0.3, M(palette.grass));
      planting.position.set((m.minX + m.maxX) / 2, 0.16, (m.minZ + m.maxZ) / 2);
      site.add(kerb, planting);
    }
  }

  // A street (curbside): a parallel parking lane along each curb around two
  // travel lanes, edge lines, a dashed center line and the spot marks, curbs
  // and sidewalks on both sides. It runs far past the chargers both ways, so
  // its ends fade into the haze.
  function buildStreet(palette: Palette, along: Box): void {
    const lot = layout.lot;
    const tile = lot.spotW;
    const minX = Math.floor(along.minX / tile) * tile;
    const maxX = Math.ceil(along.maxX / tile) * tile;
    const length = maxX - minX;
    const cx = (minX + maxX) / 2;
    const marks = streetTexture(palette.asphalt, palette.paint);
    marks.repeat.set(length / tile, 1);
    const roadGeometry = track(new THREE.PlaneGeometry(length, lot.depth));
    roadGeometry.rotateX(-Math.PI / 2);
    const road = new THREE.Mesh(roadGeometry, M('#ffffff', { map: marks, roughness: 0.95 }));
    road.position.set(cx, 0.012, lot.depth / 2);
    road.receiveShadow = true;
    road.frustumCulled = false;
    site.add(road);
    const curb = M(palette.curb, { roughness: 0.9 });
    const concrete = M(palette.sidewalk, { roughness: 0.95 });
    for (const [curbZ, walkZ] of [
      [-CURB_M / 2, -CURB_M - SIDEWALK_M / 2],
      [lot.depth + CURB_M / 2, lot.depth + CURB_M + SIDEWALK_M / 2],
    ] as const) {
      const strip = box(length, 0.14, CURB_M, curb);
      strip.position.set(cx, 0.07, curbZ);
      const walk = box(length, 0.12, SIDEWALK_M, concrete);
      walk.position.set(cx, 0.06, walkZ);
      site.add(strip, walk);
    }
  }

  // One parallel spot length of the street, curb to curb: the parking lane
  // edge lines, a tick at the spot boundary in each parking lane, and the
  // dashed center line (a 3 m dash every 6 m).
  function streetTexture(asphalt: string, paint: string): THREE.CanvasTexture {
    const { spotW, spotD, depth } = layout.lot;
    const px = TEXTURE_PX_PER_M;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * px);
    canvas.height = Math.round(depth * px);
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = paint;
      const line = Math.round(0.12 * px);
      for (const z of [spotD, depth - spotD]) {
        ctx.fillRect(0, Math.round(z * px - line / 2), canvas.width, line);
      }
      const tick = Math.round(0.1 * px);
      ctx.fillRect(0, 0, tick, Math.round(spotD * px));
      ctx.fillRect(0, Math.round((depth - spotD) * px), tick, Math.round(spotD * px));
      ctx.globalAlpha = 0.85;
      const center = Math.round((depth / 2) * px);
      ctx.fillRect(
        Math.round(spotW * 0.25 * px),
        center - line / 2,
        Math.round(spotW * 0.5 * px),
        line,
      );
      ctx.globalAlpha = 1;
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // A glowing cable run on the ground along an orthogonal path of lot
  // points: a thin bright core with a moving pulse and a wide faint halo.
  // Links never take clicks or drags.
  function buildLink(
    points: readonly THREE.Vector3[],
    kind: LinkKind,
    id: string,
    flowId: string,
  ): THREE.Group {
    const g = new THREE.Group();
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a != null && b != null && a.distanceTo(b) > 1e-6) {
        curve.add(new THREE.LineCurve3(a, b));
      }
    }
    if (curve.curves.length === 0) return g;
    const length = curve.getLength();
    const tubular = Math.min(400, Math.max(2, Math.ceil(length / 0.2)));
    const color = kind === 'station' ? SCENE_COLORS.linkStation : SCENE_COLORS.linkFeeder;
    const flow = flowTexture();
    flow.repeat.set(Math.max(1, length / 3), 1);
    flowTextures.push(flow);
    const core = new THREE.Mesh(
      track(new THREE.TubeGeometry(curve, tubular, kind === 'station' ? 0.035 : 0.05, 8, false)),
      track(
        new THREE.MeshBasicMaterial({
          color,
          map: flow,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    const halo = new THREE.Mesh(
      track(new THREE.TubeGeometry(curve, tubular, kind === 'station' ? 0.1 : 0.14, 8, false)),
      track(
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    for (const m of [core, halo]) {
      m.raycast = () => undefined;
      m.renderOrder = 2;
    }
    g.add(halo, core);
    const entry: LinkMeshes = { core, halo, curve, tubular, kind, flowId, step: -1 };
    linkMeshes.set(id, entry);
    styleLink(entry, linkFlow.get(flowId) ?? null);
    return g;
  }

  // The live flow of a link: brightness and thickness grow with the power.
  // Without load data (null) the link keeps its plain look. Thickness changes
  // in steps of a tenth, so a small change rebuilds no geometry.
  function styleLink(entry: LinkMeshes, flow: number | null): void {
    const step = flow == null ? -1 : Math.round(Math.min(1, Math.max(0, flow)) * 10);
    if (step === entry.step) return;
    entry.step = step;
    const level = step < 0 ? 0.5 : step / 10;
    const base = entry.kind === 'station' ? 0.035 : 0.05;
    const haloBase = entry.kind === 'station' ? 0.1 : 0.14;
    const scale = 0.6 + level * 1.1;
    entry.core.material.opacity = step < 0 ? 0.85 : 0.3 + 0.65 * level;
    entry.halo.material.opacity = step < 0 ? 0.16 : 0.05 + 0.3 * level;
    if (step < 0 && entry.core.geometry.parameters.radius === base) return;
    const core = new THREE.TubeGeometry(entry.curve, entry.tubular, base * scale, 8, false);
    const halo = new THREE.TubeGeometry(entry.curve, entry.tubular, haloBase * scale, 8, false);
    entry.core.geometry.dispose();
    entry.halo.geometry.dispose();
    entry.core.geometry = track(core);
    entry.halo.geometry = track(halo);
  }

  function rebuild(): void {
    for (const item of built) item.dispose();
    built = [];
    haloTexture = null;
    solarTextureCache = null;
    flowTextures.length = 0;
    linkMeshes.clear();
    beacons.length = 0;
    screenScrolls.length = 0;
    objects.clear();
    transformerObjects.clear();
    batteryObjects.clear();
    solarObjects.clear();
    energyLabels.clear();
    linkLabels.clear();
    virtualSprites.clear();
    ground.clear();
    site.clear();
    editGrid.clear();
    const { lot } = layout;
    site.rotation.y = lot.facing;
    site.add(editGrid);
    showGuides([]);
    guideMaterial.color.set(theme.primary);
    site.add(guideGroup);
    const palette = theme.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
    // The fog and the background are the grass haze: the ground fades into
    // itself toward the horizon and fills the whole stage at any zoom and angle.
    scene.background = new THREE.Color(palette.haze);
    // The room light reads as daylight on a light theme, as a dim glow at night.
    scene.environmentIntensity = theme.dark ? 0.25 : 0.6;
    fog.color.set(palette.haze);

    const office = lot.siteType === 'office_retail';
    const street = lot.siteType === 'curbside';
    const custom = lot.siteType === 'custom';
    const outside: Point[] = [
      ...layout.transformers.map((tr) => ({ x: tr.x, z: tr.z })),
      ...layout.batteries.map((b) => ({ x: b.x, z: b.z })),
      ...layout.solar.flatMap((pv) => (pv.free != null ? [{ x: pv.free.x, z: pv.free.z }] : [])),
      ...layout.stations.map((s) => poseOf(s).point),
      ...layout.panels.map((p) => ({ x: p.x, z: p.z })),
      ...(office ? buildingFramePoints(lot) : []),
    ];
    if (custom) {
      // No lot: the ground is the spots of every station and what stands beside them.
      const freeStations = layout.stations.flatMap((s) =>
        s.free != null ? [{ placement: s.free, spots: s.spots ?? 1 }] : [],
      );
      siteBox = customSceneBox(freeStations, outside);
      lotBox = customSceneBox(freeStations, []);
    } else {
      siteBox = sceneBox(lot, outside);
      lotBox = sceneBox(
        lot,
        layout.stations.map((s) => bayToLot(s.bay, lot)),
      );
    }
    frameBox = rotateBox(siteBox, lot.facing);
    pan = panBox(frameBox);

    // Grass under everything, far past the fog.
    const gb = groundBox(frameBox, pan);
    const grass = grassTexture(palette);
    grass.repeat.set((gb.maxX - gb.minX) / 6, (gb.maxZ - gb.minZ) / 6);
    const grassGeometry = track(new THREE.PlaneGeometry(gb.maxX - gb.minX, gb.maxZ - gb.minZ));
    grassGeometry.rotateX(-Math.PI / 2);
    const grassMesh = new THREE.Mesh(
      grassGeometry,
      M('#ffffff', {
        map: grass,
        roughness: 1,
        metalness: 0,
        // The bottom layer: drawn first and without depth, so the lot, its paint
        // and every model always draw over it at any distance.
        depthWrite: false,
      }),
    );
    grassMesh.position.set((gb.minX + gb.maxX) / 2, 0, (gb.minZ + gb.maxZ) / 2);
    grassMesh.receiveShadow = true;
    grassMesh.renderOrder = -1;
    ground.add(grassMesh);

    if (street) {
      buildStreet(palette, gb);
    } else if (custom) {
      // Grass only: each station brings its own apron and spots (addFreeSpots).
    } else if (lot.depot != null) {
      buildDepotYard(palette, lot.depot);
    } else {
      if (lot.siteType === 'parking_lot') {
        // Its rows, aisles and islands cover the whole lot.
        buildParkingRows(palette);
        addAccessibleSpace(palette);
      } else {
        // The paved row of an office or retail site with its aisle: one plane,
        // its spot tile repeated once per spot.
        const paving = spotTexture(palette.asphalt, palette.paint);
        // One tile per spot and lane; the last row has no lane behind it, so the
        // tiles start at the front edge (v = 1) and end part way into a tile.
        const tileRows = lot.depth / lot.pitch;
        paving.repeat.set(lot.cols, tileRows);
        paving.offset.set(0, Math.ceil(tileRows - 1e-9) - tileRows);
        const lotGeometry = track(new THREE.PlaneGeometry(lot.width, lot.depth));
        lotGeometry.rotateX(-Math.PI / 2);
        const lotMesh = new THREE.Mesh(
          lotGeometry,
          M('#ffffff', { map: paving, roughness: 0.95, metalness: 0 }),
        );
        lotMesh.position.set(lot.width / 2, 0.012, lot.depth / 2);
        lotMesh.receiveShadow = true;
        lotMesh.frustumCulled = false;
        site.add(lotMesh);
        addAccessibleSpace(palette);
      }
      // The curb around the lot.
      const curb = M(palette.curb, { roughness: 0.9 });
      const c = CURB_M;
      for (const [w, d, x, z] of [
        [lot.width + 2 * c, c, lot.width / 2, -c / 2],
        [lot.width + 2 * c, c, lot.width / 2, lot.depth + c / 2],
        [c, lot.depth, -c / 2, lot.depth / 2],
        [c, lot.depth, lot.width + c / 2, lot.depth / 2],
      ] as const) {
        const strip = box(w, 0.14, d, curb);
        strip.position.set(x, 0.07, z);
        site.add(strip);
      }
    }

    // The edit grid: one outline per spot, in one geometry (a custom site
    // shows each station's own spots instead).
    const outline: number[] = [];
    for (let r = 0; r < (custom ? 0 : lot.rows); r++) {
      for (let col = 0; col < (lot.rowLengths[r] ?? 0); col++) {
        const rect = spotRect({ col, row: r }, lot);
        const x0 = rect.minX + 0.08;
        const z0 = rect.minZ + 0.08;
        const x1 = rect.maxX - 0.08;
        const z1 = rect.maxZ - 0.08;
        outline.push(x0, 0.03, z0, x1, 0.03, z0, x1, 0.03, z0, x1, 0.03, z1);
        outline.push(x1, 0.03, z1, x0, 0.03, z1, x0, 0.03, z1, x0, 0.03, z0);
      }
    }
    const outlineGeometry = track(new THREE.BufferGeometry());
    outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
    const gridMaterial = track(
      new THREE.LineBasicMaterial({ color: theme.primary, transparent: true, opacity: 0.55 }),
    );
    editGrid.add(new THREE.LineSegments(outlineGeometry, gridMaterial));
    editGrid.visible = editing;

    // Shadows cover the site.
    const cx = (frameBox.minX + frameBox.maxX) / 2;
    const cz = (frameBox.minZ + frameBox.maxZ) / 2;
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx - 14, 26, cz + 18);
    const extent = Math.max(frameBox.maxX - frameBox.minX, frameBox.maxZ - frameBox.minZ) / 2 + 6;
    Object.assign(sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      near: 1,
      far: 160,
    });
    sun.shadow.camera.updateProjectionMatrix();

    const t = templates(palette);
    if (office) buildBuilding(palette);
    signPosts.length = 0;
    for (const s of layout.stations) {
      const obj = buildModel(s, palette, t);
      site.add(obj.group);
      objects.set(s.id, obj);
    }
    // A large site draws its stations' fixed parts as a few merged meshes
    // (one per look), outside Edit Layout, where stations move one by one.
    if (!editing && mergesStations(layout.stations.length)) mergeStations();
    for (const tr of layout.transformers) {
      const g = t.transformer();
      g.position.set(tr.x, 0, tr.z);
      g.traverse((o) => {
        o.userData['transformerId'] = tr.id;
      });
      site.add(g);
      transformerObjects.set(tr.id, g);
    }
    // Transformers, batteries and switchboards stand behind bollards where a
    // vehicle could hit them (equipmentBollards, EWEB ED5-1.0800): a depot
    // yard has no curb (bollards on every side facing it); a parking lot is
    // curbed (bollards on a side closer than 5 ft to it); a custom site's
    // station aprons are curbed except the open lane ends of a truck
    // pull-through. Office or retail and curbside sites show no equipment.
    const equipmentGrounds: EquipmentGround[] =
      lot.depot != null
        ? [{ box: layoutGroundBox(lot), curbed: false }]
        : lot.siteType === 'parking_lot'
          ? [{ box: layoutGroundBox(lot), curbed: true }]
          : custom
            ? layout.stations.flatMap((s) => {
                if (s.free == null) return [];
                const footprint = pointsBox(
                  freeFootprint(s.free, s.spots ?? 1),
                  FREE_LAYOUT.apronM,
                );
                return footprint == null
                  ? []
                  : [{ box: footprint, curbed: freeSpotTypeOf(s.free) !== 'truck_pull_through' }];
              })
            : [];
    if (equipmentGrounds.length > 0) {
      const pad = (x: number, z: number, w: number, d: number): Box => ({
        minX: x - w / 2,
        maxX: x + w / 2,
        minZ: z - d / 2,
        maxZ: z + d / 2,
      });
      const equipmentPads: Box[] = [
        ...layout.transformers.map((tr) => equipmentPadBox(tr, 'transformer')),
        ...layout.batteries.map((b) => equipmentPadBox(b, 'battery')),
        ...layout.panels.flatMap((p) =>
          p.model === 'wall'
            ? []
            : p.model === 'panelboard'
              ? // A quarter turn swaps the pad's sides.
                Math.abs(Math.sin(p.turn)) > 0.5
                ? [pad(p.x, p.z, PANELBOARD.padDM, PANELBOARD.padWM)]
                : [pad(p.x, p.z, PANELBOARD.padWM, PANELBOARD.padDM)]
              : p.model === 'cabinet'
                ? [
                    pad(
                      p.x,
                      p.z,
                      SPLIT_SYSTEM.cabinet.widthM + 0.4,
                      SPLIT_SYSTEM.cabinet.depthM + 0.6,
                    ),
                  ]
                : [pad(p.x, p.z, 2.3, 1.5)],
        ),
      ];
      const postPaint = M(SCENE_COLORS.bollard, { roughness: 0.5 });
      for (const padBox of equipmentPads) {
        for (const p of equipmentBollards(padBox, equipmentGrounds)) {
          const post = cylinder(
            EQUIPMENT_BOLLARD.radiusM,
            EQUIPMENT_BOLLARD.heightM,
            16,
            postPaint,
          );
          post.position.set(p.x, EQUIPMENT_BOLLARD.heightM / 2, p.z);
          post.raycast = () => undefined;
          site.add(post);
        }
      }
    }
    for (const b of layout.batteries) {
      const g = t.battery();
      g.position.set(b.x, 0, b.z);
      g.traverse((o) => {
        o.userData['batteryId'] = b.id;
      });
      site.add(g);
      batteryObjects.set(b.id, g);
      energyLabels.set(b.id, lotPoint({ x: b.x, z: b.z }, 3.1));
    }
    const builtRowCanopies = new Set<string>();
    for (const pv of layout.solar) {
      if (pv.free != null) {
        const g = buildFreeSolarCanopy(pv.free, palette);
        g.traverse((o) => {
          o.userData['solarId'] = pv.id;
        });
        site.add(g);
        solarObjects.set(pv.id, g);
        const top = carportTopY(carportFrame(0, pv.free.lengthM, pv.free.depthM, []));
        energyLabels.set(pv.id, lotPoint({ x: pv.free.x, z: pv.free.z }, top + 0.6));
        continue;
      }
      // Both rows of an island share one double cantilever: two canopies on
      // them build it once, each keeps its label over its own row.
      const carport = solarRowCarport(pv.row);
      const key = carport.rows.join(':');
      if (!builtRowCanopies.has(key)) {
        builtRowCanopies.add(key);
        const canopy = buildSolarCanopy(carport, palette);
        // Its label: the canopy of the row nearest the pointer (`pickEquipment`).
        const ids = layout.solar
          .filter((o) => o.free == null && solarRowCarport(o.row).rows.join(':') === key)
          .map((o) => o.id);
        canopy.traverse((o) => {
          o.userData['solarRowIds'] = ids;
        });
        site.add(canopy);
      }
      const top = carportTopY(carport.frame);
      const middle = lotPoint({ x: lot.width / 2, z: rowCenterZ(pv.row) }, top + 0.6);
      energyLabels.set(pv.id, middle);
    }
    // Panels: switchboards in a row beside the transformer, AC panelboards on
    // racks beside their AC group (site-layout-links.ts).
    for (const p of layout.panels) {
      const g =
        p.model === 'wall'
          ? t.wallPanelboard()
          : p.model === 'panelboard'
            ? t.panelboard()
            : p.model === 'cabinet'
              ? t.powerCabinet()
              : t.switchboard();
      g.position.set(p.x, 0, p.z);
      g.rotation.y = p.turn;
      g.traverse((o) => {
        o.userData['panelId'] = p.id;
      });
      site.add(g);
    }
    // Links: cable runs on the ground from the transformer to the
    // switchboards, from a switchboard along its circuit's lane and row to a
    // short branch at the back of each charger.
    const nodeY = 1.0;
    for (const seg of layout.links.segments) {
      const points = seg.points.map((p: Point) => lotPoint(p, LINK_Y));
      site.add(buildLink(points, seg.kind, seg.id, seg.flowId));
    }
    const nodeMaterial = track(
      new THREE.MeshBasicMaterial({
        color: SCENE_COLORS.linkFeeder,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const nodeGeometry = track(new THREE.SphereGeometry(0.16, 16, 12));
    for (const label of layout.links.labels) {
      if (label.kind === 'circuit') {
        // A junction where the circuit's trunk turns onto its row, on the ground.
        const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
        node.position.copy(lotPoint(label.point, LINK_Y));
        node.raycast = () => undefined;
        site.add(node);
      }
      const y =
        label.kind === 'station' ? 1.6 : label.kind === 'panel' ? PANEL_LABEL_Y : nodeY + 0.5;
      linkLabels.set(label.id, lotPoint(label.point, y));
    }
    applySelection();
  }

  function applySelection(): void {
    for (const [id, obj] of objects) {
      obj.ring.material.color.set(theme.primary);
      obj.ring.material.opacity = id === selected ? 0.9 : 0;
      // An unselected ring costs a draw call for nothing.
      obj.ring.visible = id === selected || editing;
      if (obj.handle != null) obj.handle.visible = editing && id === selected;
    }
    for (const [id, g] of solarObjects) {
      // A selected canopy (Edit Layout) shows in the edit color.
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData['solarOutline'] === true) {
          o.visible = editing && id === selectedSolar;
        }
      });
      if (editing && id === selectedSolar && !g.children.some((c) => c.userData['solarOutline'])) {
        const box3 = new THREE.Box3().setFromObject(g);
        const size = box3.getSize(new THREE.Vector3());
        const outline = new THREE.Mesh(
          track(new THREE.RingGeometry(0.98, 1, 4, 1)),
          track(
            new THREE.MeshBasicMaterial({
              color: theme.primary,
              transparent: true,
              opacity: 0.9,
              side: THREE.DoubleSide,
            }),
          ),
        );
        outline.rotation.x = -Math.PI / 2;
        outline.rotation.z = Math.PI / 4;
        const local = Math.max(size.x, size.z);
        outline.scale.set(local * 0.75, local * 0.75, 1);
        outline.position.y = 0.05;
        outline.userData['solarOutline'] = true;
        outline.raycast = () => undefined;
        g.add(outline);
      }
    }
  }

  // What makes two materials draw the same: merged meshes share the first one.
  function materialKey(m: THREE.Material): string {
    // Only standard materials carry these; a basic material leaves them out.
    const std = m as Partial<
      Pick<
        THREE.MeshStandardMaterial,
        'color' | 'emissive' | 'emissiveIntensity' | 'roughness' | 'metalness' | 'map'
      >
    >;
    return [
      m.type,
      std.color?.getHexString() ?? '',
      std.emissive?.getHexString() ?? '',
      String(std.emissiveIntensity ?? ''),
      String(std.roughness ?? ''),
      String(std.metalness ?? ''),
      std.map?.uuid ?? '',
      String(m.transparent),
      String(m.opacity),
      String(m.side),
      String(m.depthWrite),
      String(m.blending),
      String(m.polygonOffset),
    ].join('|');
  }

  // Merges the fixed parts of every station model into one mesh per look,
  // so a site of 200 stations takes a few dozen draw calls instead of
  // thousands. A pulsing status light, the charging glow, the beacon lamp,
  // the selection ring and every additive halo stay separate (they animate or
  // change). Each station keeps an invisible box to pick it by; its group
  // stays where it was, so labels and the popup still follow it.
  function mergeStations(): void {
    site.updateMatrixWorld(true);
    const siteInverse = new THREE.Matrix4().copy(site.matrixWorld).invert();
    const animated = new Set<THREE.Material>(beacons.map((b) => b.core));
    const buckets = new Map<
      string,
      { material: THREE.Material; parts: THREE.BufferGeometry[]; cast: boolean }
    >();
    const hitMaterial = track(new THREE.MeshBasicMaterial({ visible: false }));
    for (const [id, obj] of objects) {
      // A steady status light merges too; a pulsing one (charging) animates.
      const keep = new Set<THREE.Material>([obj.ring.material, ...animated]);
      if (obj.station.pulsing) keep.add(obj.light);
      if (obj.glow != null) keep.add(obj.glow.strip).add(obj.glow.halo);
      const groupInverse = new THREE.Matrix4().copy(obj.group.matrixWorld).invert();
      const bounds = new THREE.Box3();
      const merged: THREE.Object3D[] = [];
      obj.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const material = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material) || keep.has(material)) return;
        if (material.blending === THREE.AdditiveBlending || o.userData['ring'] === true) return;
        // The rotation handle shows only in Edit Layout, where stations are not merged.
        if (o.userData['rotateHandle'] != null) return;
        const part = flatGeometry(o.geometry as THREE.BufferGeometry);
        if (part == null) return;
        part.computeBoundingBox();
        if (part.boundingBox != null) {
          bounds.union(
            part.boundingBox.clone().applyMatrix4(groupInverse.clone().multiply(o.matrixWorld)),
          );
        }
        part.applyMatrix4(siteInverse.clone().multiply(o.matrixWorld));
        const key = materialKey(material);
        const bucket = buckets.get(key) ?? { material, parts: [], cast: false };
        bucket.parts.push(part);
        bucket.cast ||= o.castShadow;
        buckets.set(key, bucket);
        merged.push(o);
      });
      for (const o of merged) o.removeFromParent();
      if (!bounds.isEmpty()) {
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const hit = new THREE.Mesh(
          track(new THREE.BoxGeometry(size.x, size.y, size.z)),
          hitMaterial,
        );
        hit.position.copy(center);
        hit.userData['stationId'] = id;
        obj.group.add(hit);
      }
    }
    for (const bucket of buckets.values()) {
      const geometry = track(concatGeometries(bucket.parts));
      for (const part of bucket.parts) part.dispose();
      const mesh = new THREE.Mesh(geometry, bucket.material);
      mesh.castShadow = bucket.cast;
      mesh.receiveShadow = true;
      mesh.raycast = () => undefined;
      site.add(mesh);
    }
  }

  // `toggle`: an explicit Fit to View; on a narrow stage it alternates the
  // densest part and the whole site. Otherwise a narrow stage frames the
  // densest part of a wide site (denseFrameBox) and a wide stage the whole.
  function fit(toggle = false): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    applyZoomLimit();
    const narrow = container.clientWidth > 0 && width < NARROW_STAGE_PX;
    const wantDense = narrow && !(toggle && lastFitDense);
    const points = layout.stations.map((s) => poseOf(s).point);
    const framed = (box: Box): Box => (wantDense ? denseFrameBox(box, points, width) : box);
    const viewBox = options.view === 'front' ? lotBox : siteBox;
    lastFitDense = wantDense && framed(viewBox) !== viewBox;
    // The front camera, and the overview of an office or retail site (the
    // building stays behind the lot), turn with the facing.
    if (options.view === 'front' || layout.lot.siteType === 'office_retail') {
      const front = frontCamera(
        framed(viewBox),
        layout.lot.facing,
        width / height,
        options.view === 'front' ? FRONT_CAMERA_OFFSET : OVERVIEW_CAMERA_OFFSET,
      );
      controls.target.set(front.target.x, front.target.y, front.target.z);
      camera.position.set(front.position.x, front.position.y, front.position.z);
    } else {
      const { target, distance } = fitFrame(
        rotateBox(framed(siteBox), layout.lot.facing),
        width / height,
      );
      controls.target.set(target.x, target.y, target.z);
      camera.position.set(
        target.x + distance * 0.22,
        distance * 0.62,
        target.z - 0.6 + distance * 0.86,
      );
    }
    controls.update();
    updateFog();
  }

  // The zoom-out limit and the far plane follow the site, so a large site can
  // be seen whole and the fogged ground never ends inside the view.
  function applyZoomLimit(): void {
    controls.maxDistance = maxZoomDistance(frameBox);
    camera.far = fogRange(controls.maxDistance).far + 100;
    camera.updateProjectionMatrix();
  }

  function updateFog(): void {
    const range = fogRange(camera.position.distanceTo(controls.target));
    fog.near = range.near;
    fog.far = range.far;
  }

  function resize(): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function project(v: THREE.Vector3): ScreenPoint {
    const distance = v.distanceTo(camera.position);
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * container.clientHeight,
      depth: v.z,
      distance,
      pxPerMeter: pixelsPerMeter(distance, camera.fov, container.clientHeight),
      visible: v.z < 1,
    };
  }

  function labelPoint(stationId: string): ScreenPoint | null {
    const obj = objects.get(stationId);
    if (obj == null) return null;
    // The label point in the station's own frame (a wall box hangs behind its spot).
    const v = new THREE.Vector3(0, obj.top + 0.45, obj.labelZ);
    obj.group.localToWorld(v);
    return project(v);
  }

  function avatarPoint(stationId: string): ScreenPoint | null {
    const obj = objects.get(stationId);
    if (obj == null) return null;
    // Above the car roof while charging (the car parks nose to the charger), else above the charger.
    const v =
      obj.avatarAnchor != null
        ? obj.avatarAnchor.clone()
        : new THREE.Vector3(0, obj.top + 1.1, obj.labelZ);
    obj.group.localToWorld(v);
    return project(v);
  }

  function virtualSignPoint(stationId: string): ScreenPoint | null {
    const sprite = virtualSprites.get(stationId);
    if (sprite == null) return null;
    const v = new THREE.Vector3(0, (VIRTUAL_SIGN_WIDTH_M * 176) / 512 / 2 + 0.1, 0);
    sprite.localToWorld(v);
    return project(v);
  }

  function focusStation(stationId: string): void {
    const obj = objects.get(stationId);
    if (obj == null) return;
    const p = new THREE.Vector3(0, 0.8, 0);
    obj.group.localToWorld(p);
    const shift = p.sub(controls.target);
    controls.target.add(shift);
    camera.position.add(shift);
    controls.update();
    updateFog();
  }

  function transformerLabelPoint(id: string): ScreenPoint | null {
    const g = transformerObjects.get(id);
    if (g == null) return null;
    const v = g.position.clone();
    v.y = 2.3;
    return project(site.localToWorld(v));
  }

  function energyLabelPoint(id: string): ScreenPoint | null {
    const p = energyLabels.get(id);
    return p == null ? null : project(site.localToWorld(p.clone()));
  }

  function linkLabelPoint(id: string): ScreenPoint | null {
    const p = linkLabels.get(id);
    return p == null ? null : project(site.localToWorld(p.clone()));
  }

  // Picking and dragging.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  type PickKind = 'station' | 'transformer' | 'battery' | 'solar' | 'handle';
  let drag: {
    kind: PickKind;
    id: string;
    pointerId: number;
    /** Ground point minus the object's position at the grab (custom site moves). */
    grab: Point;
    start: { x: number; y: number };
    moved: boolean;
  } | null = null;
  let downAt: { x: number; y: number } | null = null;
  const canvas = renderer.domElement;
  function setRay(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, camera);
  }
  function pick(e: PointerEvent): { kind: PickKind; id: string } | null {
    setRay(e);
    const groups = [...objects.values()].map((o) => o.group);
    groups.push(
      ...transformerObjects.values(),
      ...batteryObjects.values(),
      ...solarObjects.values(),
    );
    const hits = ray
      .intersectObjects(groups, true)
      .filter(
        (h) =>
          h.object.type === 'Mesh' &&
          h.object.userData['ring'] !== true &&
          (h.object.userData['rotateHandle'] == null || editing),
      );
    // A visible rotation handle wins over the station under it.
    const handleHit = hits.find((h) => {
      const id: unknown = h.object.userData['rotateHandle'];
      return typeof id === 'string' && objects.get(id)?.handle?.visible === true;
    });
    if (handleHit != null)
      return { kind: 'handle', id: String(handleHit.object.userData['rotateHandle']) };
    // A station under a solar canopy wins over the roof above it.
    const rest = hits.filter((h) => h.object.userData['rotateHandle'] == null);
    const hit = rest.find((h) => typeof h.object.userData['stationId'] === 'string') ?? rest[0];
    if (hit == null) return null;
    const stationId: unknown = hit.object.userData['stationId'];
    if (typeof stationId === 'string') return { kind: 'station', id: stationId };
    const transformerId: unknown = hit.object.userData['transformerId'];
    if (typeof transformerId === 'string') return { kind: 'transformer', id: transformerId };
    const batteryId: unknown = hit.object.userData['batteryId'];
    if (typeof batteryId === 'string') return { kind: 'battery', id: batteryId };
    const solarId: unknown = hit.object.userData['solarId'];
    if (typeof solarId === 'string') return { kind: 'solar', id: solarId };
    return null;
  }
  /** The station whose virtual status sign is under the pointer, or null. */
  function pickVirtualSign(e: PointerEvent): string | null {
    if (virtualSprites.size === 0) return null;
    setRay(e);
    const hit = ray.intersectObjects([...virtualSprites.values()], false)[0];
    const id: unknown = hit?.object.userData['virtualSign'];
    return typeof id === 'string' ? id : null;
  }

  /** How near the pointer's ground point must be to a cable run to hover it, in meters. */
  const LINK_HOVER_M = 0.45;
  /**
   * The power equipment under the pointer (its label key, `onEquipmentHover`):
   * a transformer, battery, solar canopy or switchboard model, else a cable
   * run within `LINK_HOVER_M` of the pointer's ground point.
   */
  function pickEquipment(e: PointerEvent): string | null {
    setRay(e);
    const groups: THREE.Object3D[] = [
      ...transformerObjects.values(),
      ...batteryObjects.values(),
      ...solarObjects.values(),
    ];
    site.traverse((o) => {
      if (
        o !== site &&
        (o.userData['panelId'] != null || o.userData['solarRowIds'] != null) &&
        o.parent === site
      ) {
        groups.push(o);
      }
    });
    const hit = ray.intersectObjects(groups, true).find((h) => h.object.type === 'Mesh');
    if (hit != null) {
      const d = hit.object.userData;
      if (typeof d['transformerId'] === 'string') return `transformer:${d['transformerId']}`;
      if (typeof d['batteryId'] === 'string') return `energy:${d['batteryId']}`;
      if (typeof d['solarId'] === 'string') return `energy:${d['solarId']}`;
      if (typeof d['panelId'] === 'string') return `panel:${d['panelId']}`;
      const rowIds: unknown = d['solarRowIds'];
      if (Array.isArray(rowIds) && rowIds.length > 0) {
        const at = site.worldToLocal(hit.point.clone());
        let best: string | null = null;
        let bestD = Infinity;
        for (const id of rowIds as string[]) {
          const p = energyLabels.get(id);
          const dist = p == null ? Infinity : Math.abs(p.z - at.z);
          if (dist < bestD) {
            bestD = dist;
            best = id;
          }
        }
        return best != null ? `energy:${best}` : null;
      }
    }
    if (ray.ray.intersectPlane(floor, new THREE.Vector3()) == null) return null;
    const ground = groundPoint(e);
    if (ground == null) return null;
    let best: string | null = null;
    let bestD = LINK_HOVER_M;
    for (const seg of layout.links.segments) {
      for (let i = 1; i < seg.points.length; i++) {
        const a = seg.points[i - 1];
        const b = seg.points[i];
        if (a == null || b == null) continue;
        const d = distanceToSegment({ x: ground.x, z: ground.z }, a, b);
        if (d < bestD) {
          bestD = d;
          best = seg.flowId;
        }
      }
    }
    // A run whose label is a link label (a station branch without an allocated limit has none).
    return best != null && linkLabels.has(best) ? best : null;
  }

  // The pointer on the ground, in lot coordinates.
  function groundPoint(e: PointerEvent): THREE.Vector3 | null {
    setRay(e);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(floor, p) == null) return null;
    return site.worldToLocal(p);
  }
  // Stations move freely on a custom site only; a depot station moves by slot.
  function freeMoves(): boolean {
    return layout.lot.siteType === 'custom';
  }
  // The free position a station's group shows now (custom site).
  function groupPlacement(g: THREE.Object3D): FreePlacement {
    const id = g.userData['stationId'] as string | undefined;
    const spotType = id != null ? objects.get(id)?.station.free?.spotType : undefined;
    return {
      x: g.position.x,
      z: g.position.z,
      rotationDeg: (-g.rotation.y * 180) / Math.PI,
      ...(spotType != null ? { spotType } : {}),
    };
  }
  function showFreeState(obj: StationObject, p: FreePlacement): void {
    const state = callbacks.freeDropState?.(obj.station.id, p) ?? { blocked: false, guides: [] };
    obj.ring.material.color.set(state.blocked ? theme.destructive : theme.primary);
    obj.ring.material.opacity = 0.9;
    showGuides(state.guides);
  }
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
    if (!editing) return;
    const hit = pick(e);
    if (hit == null) return;
    // A grid site's canopy covers a row: it does not move.
    if (hit.kind === 'solar' && !solarObjects.has(hit.id)) return;
    const p = groundPoint(e);
    let grab: Point = { x: 0, z: 0 };
    const g =
      hit.kind === 'station' || hit.kind === 'handle'
        ? objects.get(hit.id)?.group
        : hit.kind === 'solar'
          ? solarObjects.get(hit.id)
          : undefined;
    if (p != null && g != null) grab = { x: p.x - g.position.x, z: p.z - g.position.z };
    drag = {
      ...hit,
      pointerId: e.pointerId,
      grab,
      start: { x: e.clientX, y: e.clientY },
      moved: false,
    };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
  // The station under a mouse or pen pointer, reported once per change.
  let hovered: string | null = null;
  function hoverStation(id: string | null): void {
    if (id === hovered) return;
    hovered = id;
    callbacks.onHover?.(id);
  }
  // The equipment whose label shows, reported once per change.
  let hoveredEquipment: string | null = null;
  function hoverEquipment(key: string | null): void {
    if (key === hoveredEquipment) return;
    hoveredEquipment = key;
    callbacks.onEquipmentHover?.(key);
  }
  function onPointerLeave(): void {
    hoverStation(null);
    hoverEquipment(null);
  }
  function onPointerMove(e: PointerEvent): void {
    if (drag == null) {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        const hit = pick(e);
        canvas.style.cursor = hit != null ? (editing ? 'grab' : 'pointer') : 'default';
        // A virtual status sign shows its time window instead of the station tooltip.
        const sign = pickVirtualSign(e);
        hoverStation(sign == null && hit?.kind === 'station' ? hit.id : null);
        hoverEquipment(
          sign != null
            ? `virtual:${sign}`
            : hit?.kind === 'station' || hit?.kind === 'handle'
              ? null
              : pickEquipment(e),
        );
      }
      return;
    }
    hoverStation(null);
    hoverEquipment(null);
    if (!drag.moved && Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) <= 5) return;
    drag.moved = true;
    const p = groundPoint(e);
    if (p == null) return;
    if (drag.kind === 'transformer' || drag.kind === 'battery') {
      const g = (drag.kind === 'battery' ? batteryObjects : transformerObjects).get(drag.id);
      if (g == null) return;
      const snapped = callbacks.snapTransformer({ x: p.x, z: p.z });
      g.position.set(snapped.x, 0, snapped.z);
      return;
    }
    if (drag.kind === 'solar') {
      const g = solarObjects.get(drag.id);
      if (g == null || callbacks.snapFree == null) return;
      const snapped = callbacks.snapFree(
        { x: p.x - drag.grab.x, z: p.z - drag.grab.z, rotationDeg: 0 },
        false,
      );
      g.position.set(snapped.x, 0, snapped.z);
      return;
    }
    const obj = objects.get(drag.id);
    if (obj == null) return;
    if (obj.station.free != null && freeMoves() && callbacks.snapFree != null) {
      if (drag.kind === 'handle') {
        // Turn toward the pointer; Shift turns to any angle.
        const deg = handleRotation(
          { x: obj.group.position.x, z: obj.group.position.z },
          p,
          e.shiftKey,
        );
        obj.group.rotation.y = (-deg * Math.PI) / 180;
      } else {
        const snapped = callbacks.snapFree(
          {
            x: p.x - drag.grab.x,
            z: p.z - drag.grab.z,
            rotationDeg: groupPlacement(obj.group).rotationDeg,
          },
          true,
        );
        obj.group.position.set(snapped.x, 0, snapped.z);
      }
      showFreeState(obj, groupPlacement(obj.group));
      return;
    }
    const clamped = clampToLot(p.x, p.z, layout.lot);
    obj.group.position.x = clamped.x;
    obj.group.position.z = clamped.z;
    const over = lotToBay(obj.group.position.x, obj.group.position.z, layout.lot);
    if (over == null) return;
    // Turn with the row it is over, so the drop preview faces its lane.
    obj.group.rotation.y = bayTurn(over, layout.lot);
    const blocked = callbacks.isBayTaken(over, drag.id);
    obj.ring.material.color.set(blocked ? theme.destructive : theme.primary);
    obj.ring.material.opacity = 0.9;
  }
  function onPointerUp(e: PointerEvent): void {
    if (drag != null) {
      const { id, kind, moved } = drag;
      drag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      showGuides([]);
      // A click without a move selects (Edit Layout).
      if (!moved) {
        if (kind === 'station' || kind === 'handle') {
          callbacks.onSolarPick?.(null);
          callbacks.onPick(id);
        } else if (kind === 'solar') {
          callbacks.onPick(null);
          callbacks.onSolarPick?.(id);
        }
        return;
      }
      if (kind === 'transformer') {
        const g = transformerObjects.get(id);
        if (g != null) callbacks.onTransformerDrop(id, { x: g.position.x, z: g.position.z });
        return;
      }
      if (kind === 'battery') {
        const g = batteryObjects.get(id);
        if (g != null) callbacks.onBatteryDrop(id, { x: g.position.x, z: g.position.z });
        return;
      }
      if (kind === 'solar') {
        const g = solarObjects.get(id);
        if (g != null) callbacks.onSolarDrop?.(id, { x: g.position.x, z: g.position.z });
        return;
      }
      const obj = objects.get(id);
      if (obj != null) {
        if (obj.station.free != null && freeMoves()) {
          const placement = groupPlacement(obj.group);
          // Back to its position until the new layout arrives (or for good when refused).
          const pose = poseOf(obj.station);
          obj.group.position.copy(lotPoint(pose.point));
          obj.group.rotation.y = pose.turn;
          applySelection();
          callbacks.onFreeDrop?.(id, placement);
          return;
        }
        const bay = lotToBay(obj.group.position.x, obj.group.position.z, layout.lot);
        // Back to its spot until the new positions arrive.
        const home = poseOf(obj.station);
        obj.group.position.copy(lotPoint(home.point));
        obj.group.rotation.y = home.turn;
        applySelection();
        if (bay != null) callbacks.onDrop(id, bay);
      }
      return;
    }
    if (downAt != null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const hit = pick(e);
    if (editing) callbacks.onSolarPick?.(null);
    callbacks.onPick(hit?.kind === 'station' ? hit.id : null);
    // A tap (touch) shows the label of the equipment under it; a tap elsewhere hides it.
    if (e.pointerType === 'touch') {
      const sign = pickVirtualSign(e);
      hoverEquipment(
        sign != null ? `virtual:${sign}` : hit?.kind === 'station' ? null : pickEquipment(e),
      );
    }
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerUp);

  const observer = new ResizeObserver(() => {
    resize();
  });
  observer.observe(container);
  resize();

  const t0 = performance.now();
  let animationFrame = 0;
  let disposed = false;
  let active = true;
  const panned = new THREE.Vector3();
  // Panning stops at the grass around the site.
  function keepTargetOnSite(): void {
    const target = controls.target;
    const c = clampTarget(target.x, target.z, pan);
    if (c.x === target.x && c.z === target.z) return;
    panned.set(c.x - target.x, 0, c.z - target.z);
    target.add(panned);
    camera.position.add(panned);
  }

  // Orbit, zoom and pan keep the camera at eye height or above (MIN_CAMERA_HEIGHT),
  // so a low orbit looks across the lot and never goes under the ground.
  function keepCameraAboveGround(): void {
    camera.position.y = clampCameraHeight(camera.position.y);
  }

  function loop(now: number): void {
    if (disposed || !active) return;
    controls.update();
    keepTargetOnSite();
    keepCameraAboveGround();
    updateFog();
    if (!options.reducedMotion) {
      const time = (now - t0) / 1000;
      const level = chargingGlowLevel(time);
      for (const obj of objects.values()) {
        if (obj.station.pulsing) obj.light.emissiveIntensity = 0.55 + 0.4 * Math.sin(time * 3);
        if (obj.glow != null) {
          obj.glow.strip.emissiveIntensity = level.intensity;
          obj.glow.halo.opacity = level.halo;
        }
      }
      // A gentle flow from the transformer toward the stations.
      for (const tex of flowTextures) tex.offset.x = -time * 0.35;
      // Long display messages scroll across the charger screens.
      for (const scroll of screenScrolls) scroll.texture.offset.x = time * scroll.speed;
      const beat = beaconLevel(time);
      for (const b of beacons) {
        b.core.emissiveIntensity = beat.intensity;
        b.halo.opacity = beat.halo;
      }
    }
    renderer.render(scene, camera);
    callbacks.onFrame();
    animationFrame = requestAnimationFrame(loop);
  }
  animationFrame = requestAnimationFrame(loop);

  let hasFitted = false;
  return {
    setLayout(next) {
      // Lot coordinates are anchored at spot (0, 0), so a move never shifts the
      // view; only the first stations to arrive, a new lot or a new site type refit it.
      const lotChanged =
        next.lot.width !== layout.lot.width ||
        next.lot.depth !== layout.lot.depth ||
        next.lot.facing !== layout.lot.facing ||
        next.lot.siteType !== layout.lot.siteType ||
        next.lot.rowLengths.join(',') !== layout.lot.rowLengths.join(',');
      const first = !hasFitted && next.stations.length > 0;
      layout = next;
      rebuild();
      applyZoomLimit();
      if (first || (hasFitted && lotChanged)) {
        hasFitted = true;
        fit();
      }
    },
    setTheme(next) {
      theme = next;
      rebuild();
    },
    setEditing(next) {
      const remerge = next !== editing && mergesStations(layout.stations.length);
      editing = next;
      // A merged site splits its stations again to drag them (and merges them after).
      if (remerge) rebuild();
      editGrid.visible = next;
      // The rotation handle shows only in Edit Layout.
      applySelection();
      if (!next && drag != null) {
        drag = null;
        controls.enabled = true;
      }
    },
    setSelected(id) {
      selected = id;
      applySelection();
    },
    setSelectedSolar(id) {
      selectedSolar = id;
      applySelection();
    },
    setLogo(url) {
      if (url === logoUrl) return;
      logoUrl = url;
      if (url == null) {
        logo?.texture.dispose();
        logo = null;
        rebuild();
        return;
      }
      void loadLogoCanvas(url).then((canvasImage) => {
        if (disposed || logoUrl !== url) return;
        logo?.texture.dispose();
        if (canvasImage == null) {
          logo = null;
        } else {
          const texture = new THREE.CanvasTexture(canvasImage);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          logo = { texture, width: canvasImage.width, height: canvasImage.height };
        }
        rebuild();
      });
    },
    fit(toggle) {
      hasFitted = true;
      fit(toggle === true);
    },
    setActive(next) {
      if (next === active || disposed) return;
      active = next;
      cancelAnimationFrame(animationFrame);
      if (next) animationFrame = requestAnimationFrame(loop);
    },
    setLinkFlow(next) {
      linkFlow = next;
      for (const entry of linkMeshes.values()) styleLink(entry, next.get(entry.flowId) ?? null);
    },
    focus: focusStation,
    viewDistance: () => camera.position.distanceTo(controls.target),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    avatarPoint,
    labelPoint,
    energyLabelPoint,
    transformerLabelPoint,
    linkLabelPoint,
    virtualSignPoint,
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      showGuides([]);
      guideDash.dispose();
      guideMaterial.dispose();
      for (const item of built) item.dispose();
      built = [];
      for (const kit of carKits.values()) for (const g of kit.geometries) g.dispose();
      carKits.clear();
      environment.dispose();
      logo?.texture.dispose();
      logo = null;
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
