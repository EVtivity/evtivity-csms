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

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LayoutBay } from '@evtivity/lib/site-layout';
import { SCENE_COLORS } from './site-layout-colors';
import {
  BAY_LINE_GAP,
  BUILDING_HEIGHT_M,
  CAMERA_FOV,
  CURB_M,
  FACADE_Z,
  MAX_POLAR_ANGLE,
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
  fitFrame,
  fogRange,
  FRONT_CAMERA_OFFSET,
  FRONT_MAX_POLAR_ANGLE,
  frontCamera,
  groundBox,
  logoFit,
  maxZoomDistance,
  panBox,
  rotateBox,
  sceneBox,
  wallBoxOffset,
  worldToBay as lotToBay,
  type Box,
  type Lot,
  type Point,
  type StationProp,
} from './site-layout-grid';
import type { LinkKind, LoadLinks, PanelMount } from './site-layout-links';

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
  /** An AC wall box on the building facade (office or retail, first row), not a pedestal. */
  wall: boolean;
  /** What stands in the spot (`stationProp`): a car on a cable, a Reserved sign or a cone. */
  prop: StationProp;
  /** Payment terminals paired to the station. */
  terminals: readonly SceneTerminal[];
  /** A faulted station: a red beacon above it, pulsing unless reduced motion is on. */
  beacon: boolean;
}

export interface SceneTransformer {
  id: string;
  x: number;
  z: number;
}

/** A load management panel model (site-layout-links.ts, placePanels). */
export interface ScenePanel {
  id: string;
  x: number;
  z: number;
  mount: PanelMount;
}

/** A battery storage cabinet on the grass (information only). */
export interface SceneBattery {
  id: string;
  x: number;
  z: number;
}

/** A solar carport canopy over one row of the lot (information only, parking lot only). */
export interface SceneSolar {
  id: string;
  row: number;
}

export interface SceneLayout {
  lot: Lot;
  stations: readonly SceneStation[];
  /** Shown on a parking lot only (the caller passes none for an office or retail site). */
  transformers: readonly SceneTransformer[];
  /** Battery storage on the grass (both site types). */
  batteries: readonly SceneBattery[];
  /** Solar canopies (the caller passes none for an office or retail site). */
  solar: readonly SceneSolar[];
  panels: readonly ScenePanel[];
  links: LoadLinks;
}

export interface SceneTheme {
  dark: boolean;
  /** The word on the Reserved sign, in the UI language. */
  reservedLabel: string;
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
  /** Runs after every rendered frame (labels and popup follow the models). */
  onFrame: () => void;
}

export interface SiteScene {
  setLayout: (layout: SceneLayout) => void;
  setTheme: (theme: SceneTheme) => void;
  setEditing: (editing: boolean) => void;
  setSelected: (stationId: string | null) => void;
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
  fit: () => void;
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
  station: SceneStation;
}

/** The meshes of one load management link, restyled by its live flow. */
interface LinkMeshes {
  core: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  curve: THREE.QuadraticBezierCurve3;
  kind: LinkKind;
  /** The flow step it is drawn at (0 to 10), -1 before the first style. */
  step: number;
}

/** How far above the car roof a driver avatar floats, in meters. */
const AVATAR_ABOVE_ROOF_M = 0.5;

/** Height of a panel link end and of a panel label, by mount, in meters. */
const PANEL_LINK_Y: Record<PanelMount, number> = { pad: 1.7, wall: 1.5 };
const PANEL_LABEL_Y: Record<PanelMount, number> = { pad: 2.75, wall: 2.4 };

/** From this many stations, the fixed parts of the station models are merged (outside Edit Layout). */
export const MERGE_STATIONS_FROM = 60;

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

/** Back panel of each model: size and where its center sits on the body. */
export const LOGO_PANELS = {
  dc: { width: 0.62, height: 0.62, y: 1.2, z: -0.29 },
  ac: { width: 0.28, height: 0.4, y: 1.25, z: -0.1 },
} as const;
const LOGO_PADDING = 0.04;

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
  controls.maxPolarAngle = options.view === 'front' ? FRONT_MAX_POLAR_ANGLE : MAX_POLAR_ANGLE;
  controls.minDistance = MIN_DISTANCE;
  // Panning moves along the ground, like a map, so the view never lifts off the site.
  controls.screenSpacePanning = false;
  controls.maxDistance = 400;
  const fog = new THREE.Fog(0xffffff, 100, 400);
  scene.fog = fog;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

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
  // A side profile (x along the length from 0 at the front, y up) extruded
  // across `width`, centered on x = 0 with the front at z = front.
  function profileSolid(
    points: Array<[number, number]>,
    width: number,
    front: number,
    material: THREE.Material,
  ) {
    const s = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
    const g = track(
      new THREE.ExtrudeGeometry(s, {
        depth: width,
        bevelEnabled: true,
        bevelThickness: 0.06,
        bevelSize: 0.05,
        bevelSegments: 3,
        curveSegments: 8,
      }),
    );
    // Shape x becomes the length (z), the extrusion becomes the width (x).
    g.rotateY(-Math.PI / 2);
    g.translate(width / 2, 0, front);
    return shadowed(new THREE.Mesh(g, material));
  }
  function cable(points: Array<[number, number, number]>, material: THREE.Material) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    return shadowed(
      new THREE.Mesh(track(new THREE.TubeGeometry(curve, 48, 0.022, 8, false)), material),
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
    reservedLabel: 'Reserved',
    primary: '#2563eb',
    destructive: '#ef4444',
  };
  let layout: SceneLayout = {
    lot: {
      cols: 10,
      rows: 2,
      spotW: 3.2,
      spotD: 5.6,
      lane: 6,
      pitch: 11.6,
      width: 32,
      depth: 23.2,
      facing: 0,
      siteType: 'parking_lot',
    },
    stations: [],
    transformers: [],
    batteries: [],
    solar: [],
    panels: [],
    links: { segments: [], labels: [] },
  };
  let frameBox: Box = { minX: 0, maxX: 32, minZ: 0, maxZ: 23.2 };
  // The same box before the facing turns it (the front camera frames it).
  let siteBox: Box = frameBox;
  // The lot and its stations only (lot coordinates): the front camera frames
  // the chargers, not the transformers and panels on the grass beside them.
  let lotBox: Box = frameBox;
  let pan: Box = panBox(frameBox);
  let editing = false;
  let selected: string | null = null;
  let logo: { texture: THREE.CanvasTexture; width: number; height: number } | null = null;
  let logoUrl: string | null = null;
  const objects = new Map<string, StationObject>();
  const transformerObjects = new Map<string, THREE.Group>();
  const batteryObjects = new Map<string, THREE.Group>();
  // Label points of the batteries and solar canopies (lot coordinates).
  const energyLabels = new Map<string, THREE.Vector3>();
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

  // One spot of asphalt with its painted line on each side edge (half on each
  // side of the tile, so repeated tiles share one line) from the front gap to
  // the back gap, then the lane with a dashed center line.
  function spotTexture(asphalt: string, paint: string): THREE.CanvasTexture {
    const { spotW, spotD, lane, pitch } = layout.lot;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spotW * TEXTURE_PX_PER_M);
    canvas.height = Math.round(pitch * TEXTURE_PX_PER_M);
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

  // The props and the transformer, built once per rebuild on first use and
  // cloned per station: the clones share their geometries and materials.
  interface Templates {
    car: () => THREE.Group;
    cable: (kind: 'ac' | 'dc' | 'wall') => THREE.Mesh;
    sign: () => THREE.Group;
    cone: () => THREE.Group;
    transformer: () => THREE.Group;
    battery: () => THREE.Group;
    switchboard: () => THREE.Group;
    wallPanel: () => THREE.Group;
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
    const CAR_LENGTH = 4.5;
    const CAR_WIDTH = 1.82;
    const PORT: [number, number, number] = [-0.86, 0.72, CAR_FRONT + 0.62];
    return {
      car: () =>
        once('car', () => {
          const g = new THREE.Group();
          const paint = M(palette.car, { roughness: 0.25, metalness: 0.55 });
          const glass = M(SCENE_COLORS.carGlass, { roughness: 0.05, metalness: 0.65 });
          const tire = M(SCENE_COLORS.rubber, { roughness: 0.9 });
          const rim = M(SCENE_COLORS.rim, { roughness: 0.25, metalness: 0.85 });
          const trim = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const head = M(SCENE_COLORS.headlight, {
            emissive: SCENE_COLORS.headlight,
            emissiveIntensity: 0.25,
          });
          const tail = M(SCENE_COLORS.taillight, {
            emissive: SCENE_COLORS.taillight,
            emissiveIntensity: 0.35,
          });
          // Lower body: bumper, hood, beltline and trunk in one side profile.
          const L = CAR_LENGTH;
          const body = profileSolid(
            [
              [0.02, 0.3],
              [0, 0.55],
              [0.12, 0.7],
              [0.95, 0.83],
              [1.55, 0.95],
              [3.75, 0.98],
              [4.3, 0.92],
              [L, 0.78],
              [L - 0.02, 0.38],
              [L - 0.2, 0.26],
              [0.2, 0.26],
            ],
            CAR_WIDTH - 0.1,
            CAR_FRONT,
            paint,
          );
          // Greenhouse: windshield, side windows and rear window in glass.
          const cabin = profileSolid(
            [
              [1.55, 0.95],
              [2.35, 1.44],
              [3.5, 1.46],
              [4.15, 1.0],
              [3.75, 0.98],
            ],
            CAR_WIDTH - 0.36,
            CAR_FRONT,
            glass,
          );
          const roof = box(CAR_WIDTH - 0.3, 0.05, 1.2, paint);
          roof.position.set(0, 1.535, CAR_FRONT + 2.93);
          g.add(body, cabin, roof);
          // Pillars between the windows.
          for (const side of [-1, 1]) {
            const pillar = box(0.05, 0.42, 0.08, paint);
            pillar.position.set(side * (CAR_WIDTH / 2 - 0.2), 1.2, CAR_FRONT + 2.95);
            g.add(pillar);
          }
          // Lights front and back, a dark grille, the charge port at the front left.
          for (const side of [-1, 1]) {
            const h = box(0.42, 0.08, 0.04, head);
            h.position.set(side * 0.58, 0.68, CAR_FRONT + 0.06);
            h.rotation.x = -0.25;
            const t = box(0.38, 0.08, 0.04, tail);
            t.position.set(side * 0.6, 0.82, CAR_FRONT + L - 0.02);
            g.add(h, t);
          }
          const grille = box(0.8, 0.1, 0.04, trim);
          grille.position.set(0, 0.42, CAR_FRONT + 0.02);
          const port = box(0.03, 0.14, 0.18, trim);
          port.position.set(PORT[0] + 0.02, PORT[1], PORT[2]);
          const portLight = box(
            0.035,
            0.03,
            0.12,
            M(SCENE_COLORS.chargePort, {
              emissive: SCENE_COLORS.chargePort,
              emissiveIntensity: 0.6,
            }),
          );
          portLight.position.set(PORT[0] + 0.01, PORT[1] + 0.09, PORT[2]);
          g.add(grille, port, portLight);
          // Wheels with rims and hubs.
          for (const x of [-(CAR_WIDTH / 2 - 0.12), CAR_WIDTH / 2 - 0.12]) {
            for (const z of [CAR_FRONT + 0.95, CAR_FRONT + L - 0.95]) {
              const wheel = new THREE.Group();
              const t = cylinder(0.34, 0.24, 24, tire);
              const r = cylinder(0.22, 0.25, 16, rim);
              const hub = cylinder(0.07, 0.27, 10, trim);
              wheel.add(t, r, hub);
              wheel.rotation.z = Math.PI / 2;
              wheel.position.set(x, 0.34, z);
              g.add(wheel);
            }
          }
          return g;
        }),
      // From the left holster of the charger to the charge port at the front left of the car.
      cable: (kind) =>
        once(`cable-${kind}`, () => {
          const rubber = M(SCENE_COLORS.rubber, { roughness: 0.9 });
          if (kind === 'wall') {
            // From the wall box holster on the facade, down across the sidewalk, to the car.
            const w = wallBoxOffset();
            return cable(
              [
                [0.24, 1.02, w + 0.2],
                [0.22, 0.3, w + 0.7],
                [-0.2, 0.1, -1.8],
                [-0.8, 0.12, 0.2],
                [-0.9, 0.4, CAR_FRONT + 0.3],
                PORT,
              ],
              rubber,
            );
          }
          return kind === 'dc'
            ? cable(
                [
                  [-0.44, 1.02, 0.12],
                  [-0.55, 0.5, 0.3],
                  [-0.7, 0.12, 0.62],
                  [-0.9, 0.4, CAR_FRONT + 0.4],
                  PORT,
                ],
                rubber,
              )
            : cable(
                [
                  [-0.17, 0.95, 0.04],
                  [-0.32, 0.45, 0.25],
                  [-0.6, 0.12, 0.6],
                  [-0.9, 0.4, CAR_FRONT + 0.4],
                  PORT,
                ],
                rubber,
              );
        }),
      sign: () =>
        once('sign', () => {
          const g = new THREE.Group();
          const concrete = M(palette.concrete, { roughness: 0.95 });
          // A concrete footing the post stands in.
          const footing = cylinder(0.2, 0.12, 20, concrete);
          footing.position.set(0, 0.06, 2.4);
          const collar = cylinder(0.09, 0.06, 16, concrete);
          collar.position.set(0, 0.15, 2.4);
          const post = cylinder(0.035, 1.5, 12, M(SCENE_COLORS.signPost, { metalness: 0.5 }));
          post.position.set(0, 0.75, 2.4);
          const edge = M(SCENE_COLORS.signBorder, { roughness: 0.5 });
          const face = M('#ffffff', { map: signTexture(palette), roughness: 0.5 });
          const plate = box(0.8, 0.42, 0.03, [edge, edge, edge, edge, face, edge]);
          plate.position.set(0, 1.32, 2.43);
          g.add(footing, collar, post, plate);
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
      // A panel mounted on the facade: a cabinet with its door, a handle, a
      // vent, a nameplate, a warning label and a conduit down to the ground.
      // Its back is on the wall (local z 0); the front faces +z.
      wallPanel: () =>
        once('wallPanel', () => {
          const g = new THREE.Group();
          const body = M(palette.switchboard, { roughness: 0.45, metalness: 0.35 });
          const door = M(palette.switchboardDoor, { roughness: 0.4, metalness: 0.35 });
          const dark = M(SCENE_COLORS.dark1, { roughness: 0.6 });
          const cabinet = box(0.76, 1.16, 0.2, body);
          cabinet.position.set(0, 1.45, 0.1);
          const leaf = box(0.7, 1.1, 0.012, door);
          leaf.position.set(0, 1.45, 0.206);
          const grip = box(0.025, 0.16, 0.03, dark);
          grip.position.set(0.28, 1.45, 0.22);
          g.add(cabinet, leaf, grip);
          for (let i = 0; i < 4; i++) {
            const louver = box(0.34, 0.018, 0.012, dark);
            louver.position.set(0, 1.84 + i * 0.04, 0.214);
            g.add(louver);
          }
          const nameplate = box(0.26, 0.08, 0.008, M(palette.signPlate, { roughness: 0.4 }));
          nameplate.position.set(0, 1.66, 0.214);
          const warning = box(0.14, 0.12, 0.008, [
            dark,
            dark,
            dark,
            dark,
            M('#ffffff', { map: warningTexture(), roughness: 0.5 }),
            dark,
          ]);
          warning.position.set(0, 1.12, 0.214);
          const conduit = cylinder(0.035, 0.87, 12, M(SCENE_COLORS.signPost, { metalness: 0.5 }));
          conduit.position.set(-0.22, 0.435, 0.06);
          g.add(nameplate, warning, conduit);
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
  }

  // The Reserved sign face: the translated word on a light plate.
  function signTexture(palette: Palette): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 268;
    const ctx = canvas.getContext('2d');
    if (ctx != null) {
      ctx.fillStyle = SCENE_COLORS.signBorder;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = palette.signPlate;
      ctx.fillRect(18, 18, canvas.width - 36, canvas.height - 36);
      ctx.fillStyle = palette.signText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = theme.reservedLabel.toLocaleUpperCase();
      let size = 110;
      ctx.font = `700 ${String(size)}px system-ui, sans-serif`;
      while (size > 30 && ctx.measureText(text).width > canvas.width - 80) {
        size -= 6;
        ctx.font = `700 ${String(size)}px system-ui, sans-serif`;
      }
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
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

  // The back panel of a charger: a plain plate, with the logo fitted on it.
  function backPanel(kind: 'ac' | 'dc', palette: Palette): THREE.Group {
    const spec = LOGO_PANELS[kind];
    const g = new THREE.Group();
    const plate = box(spec.width, spec.height, 0.012, M(palette.signPlate, { roughness: 0.4 }));
    plate.position.set(0, spec.y, spec.z);
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
        // The plane faces -z, away from the charger front.
        face.rotation.y = Math.PI;
        face.position.set(0, spec.y, spec.z - 0.008);
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

  function buildModel(s: SceneStation, palette: Palette, t: Templates): StationObject {
    const g = new THREE.Group();
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
    if (!wall) {
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
    if (wall) {
      const back = box(0.4, 0.54, 0.02, dark);
      back.position.set(0, 1.18, w + 0.01);
      const body = roundedPrism(0.34, 0.15, 0.48, 0.04, shell);
      body.position.set(0, 0.94, w + 0.095);
      const face = box(0.29, 0.42, 0.01, accent);
      face.position.set(0, 1.18, w + 0.176);
      const screen = box(0.13, 0.07, 0.01, glass);
      screen.position.set(0, 1.31, w + 0.183);
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
      top = 1.55;
      labelZ = w + 0.2;
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
      for (const side of [-1, 1]) {
        const x = side * 0.39;
        const holster = box(0.06, 0.24, 0.14, dark);
        holster.position.set(x + side * 0.035, 1.05, 0.08);
        const h = handle(rubber);
        h.position.set(x + side * 0.08, 1.03, 0.1);
        h.rotation.z = side * -0.15;
        g.add(
          holster,
          h,
          cable(
            [
              [x, 1.32, -0.12],
              [x + side * 0.12, 0.9, -0.05],
              [x + side * 0.22, 0.3, 0.05],
              [x + side * 0.2, 0.14, 0.18],
              [x + side * 0.16, 0.5, 0.2],
              [x + side * 0.09, 0.93, 0.12],
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
    // A wall box has its back on the wall: no back panel.
    if (!wall) g.add(backPanel(s.kind, palette));
    // Payment terminals on the front: on the side of their connector, or centered for the station.
    s.terminals.forEach((terminal, i) => {
      const reader = t.terminal(terminal.hasDisplay, terminal.online);
      // On the front face: a connector reader under its side of the screen, a
      // station-wide one in the middle below them; beside a wall box.
      const sideX = dc ? 0.22 : wall ? 0.34 : 0.13;
      const x = terminal.side === 0 ? (wall ? -0.34 - i * 0.16 : -i * 0.16) : terminal.side * sideX;
      const y = dc ? (terminal.side === 0 ? 0.72 : 0.92) : wall ? 1.12 : 0.78;
      reader.position.set(x, y, dc ? 0.34 : wall ? w + 0.06 : 0.19);
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
    if (s.prop === 'car') {
      const car = t.car();
      g.add(car, t.cable(wall ? 'wall' : s.kind));
      car.updateMatrixWorld(true);
      const roof = new THREE.Box3().setFromObject(car);
      if (!roof.isEmpty()) {
        const c = roof.getCenter(new THREE.Vector3());
        avatarAnchor = new THREE.Vector3(c.x, roof.max.y + AVATAR_ABOVE_ROOF_M, c.z);
      }
    }
    if (s.prop === 'reservedSign') g.add(t.sign());
    else if (s.prop === 'cone') g.add(t.cone());
    g.traverse((o) => {
      o.userData['stationId'] = s.id;
    });
    g.position.copy(lotPoint(bayToLot(s.bay, layout.lot)));
    // A turned row faces the lane before it: the charger, its props, card
    // readers and back panel all turn with the group.
    g.rotation.y = bayTurn(s.bay, layout.lot);
    return { group: g, ring, light, glow, top, labelZ, avatarAnchor, station: s };
  }

  // The middle of a row of spots across the rows (lot z).
  function rowCenterZ(row: number): number {
    return row * layout.lot.pitch + layout.lot.spotD / 2;
  }

  // A solar carport canopy over a row of spots: steel posts at the charger
  // side between every other pair of spots, beams, and a slightly tilted roof
  // of dark blue panels (a cell grid texture), high enough to park under.
  function buildSolarCanopy(row: number, palette: Palette): THREE.Group {
    const g = new THREE.Group();
    const lot = layout.lot;
    const steel = M(SCENE_COLORS.signPost, { roughness: 0.45, metalness: 0.6 });
    const z0 = row * lot.pitch;
    const atBack = bayTurn({ col: 0, row }, lot) !== 0;
    const postZ = atBack ? z0 + lot.spotD - 0.35 : z0 + 0.35;
    const H = 3.1;
    for (let c = 0; c <= lot.cols; c += 2) {
      const post = cylinder(0.09, H, 12, steel);
      post.position.set(Math.min(c, lot.cols) * lot.spotW, H / 2, postZ);
      const arm = box(0.12, 0.14, lot.spotD * 0.9, steel);
      arm.position.set(Math.min(c, lot.cols) * lot.spotW, H, z0 + lot.spotD / 2);
      g.add(post, arm);
    }
    const panelTexture = solarTexture(palette);
    panelTexture.repeat.set(
      Math.max(1, Math.round(lot.width / 1.7)),
      Math.max(1, Math.round(lot.spotD / 1.1)),
    );
    const roof = new THREE.Mesh(
      track(new THREE.BoxGeometry(lot.width + 0.4, 0.08, lot.spotD + 0.3)),
      M('#ffffff', { map: panelTexture, roughness: 0.25, metalness: 0.55 }),
    );
    roof.castShadow = true;
    roof.receiveShadow = true;
    // Tilted toward the lane, 5 degrees.
    roof.rotation.x = atBack ? 0.087 : -0.087;
    roof.position.set(lot.width / 2, H + 0.12, z0 + lot.spotD / 2);
    g.add(roof);
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
    const b = buildingBox(layout.lot, layout.panels.length);
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
    // Wheel stops in the spots along the building.
    const stop = M(palette.concrete, { roughness: 0.95 });
    for (let col = 0; col < layout.lot.cols; col++) {
      const bar = box(Math.min(1.8, layout.lot.spotW - 0.6), 0.12, 0.16, stop);
      bar.position.set(layout.lot.spotW * (col + 0.5), 0.06, 2.3);
      site.add(bar);
    }
  }

  // A soft glowing arc between two lot points: a thin bright core with a
  // moving pulse and a wide faint halo. Links never take clicks or drags.
  function buildLink(
    from: THREE.Vector3,
    to: THREE.Vector3,
    kind: LinkKind,
    id: string,
  ): THREE.Group {
    const g = new THREE.Group();
    const mid = from.clone().lerp(to, 0.5);
    mid.y = Math.max(from.y, to.y) + 0.3 + from.distanceTo(to) * 0.05;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const length = curve.getLength();
    const color = kind === 'station' ? SCENE_COLORS.linkStation : SCENE_COLORS.linkFeeder;
    const flow = flowTexture();
    flow.repeat.set(Math.max(1, length / 3), 1);
    flowTextures.push(flow);
    const core = new THREE.Mesh(
      track(new THREE.TubeGeometry(curve, 48, kind === 'station' ? 0.035 : 0.05, 8, false)),
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
      track(new THREE.TubeGeometry(curve, 48, kind === 'station' ? 0.1 : 0.14, 8, false)),
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
    const entry: LinkMeshes = { core, halo, curve, kind, step: -1 };
    linkMeshes.set(id, entry);
    styleLink(entry, linkFlow.get(id) ?? null);
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
    const core = new THREE.TubeGeometry(entry.curve, 48, base * scale, 8, false);
    const halo = new THREE.TubeGeometry(entry.curve, 48, haloBase * scale, 8, false);
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
    objects.clear();
    transformerObjects.clear();
    batteryObjects.clear();
    energyLabels.clear();
    linkLabels.clear();
    ground.clear();
    site.clear();
    editGrid.clear();
    const { lot } = layout;
    site.rotation.y = lot.facing;
    site.add(editGrid);
    const palette = theme.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
    // The fog and the background are the grass haze: the ground fades into
    // itself toward the horizon and fills the whole stage at any zoom and angle.
    scene.background = new THREE.Color(palette.haze);
    fog.color.set(palette.haze);

    const office = lot.siteType === 'office_retail';
    const outside: Point[] = [
      ...layout.transformers.map((tr) => ({ x: tr.x, z: tr.z })),
      ...layout.batteries.map((b) => ({ x: b.x, z: b.z })),
      ...layout.stations.map((s) => bayToLot(s.bay, lot)),
      ...layout.panels.map((p) => ({ x: p.x, z: p.z })),
      ...(office ? buildingFramePoints(lot, layout.panels.length) : []),
    ];
    siteBox = sceneBox(lot, outside);
    lotBox = sceneBox(
      lot,
      layout.stations.map((s) => bayToLot(s.bay, lot)),
    );
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

    // The paved lot: one plane, its spot tile repeated once per spot.
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
    // The curb around the lot.
    const curb = M(palette.curb, { roughness: 0.9 });
    const c = 0.3;
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

    // The edit grid: one outline per spot, in one geometry.
    const outline: number[] = [];
    for (let r = 0; r < lot.rows; r++) {
      for (let col = 0; col < lot.cols; col++) {
        const x0 = col * lot.spotW + 0.08;
        const z0 = r * lot.pitch + 0.08;
        const x1 = x0 + lot.spotW - 0.16;
        const z1 = z0 + lot.spotD - 0.16;
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
    for (const pv of layout.solar) {
      const g = buildSolarCanopy(pv.row, palette);
      site.add(g);
      const middle = lotPoint({ x: lot.width / 2, z: rowCenterZ(pv.row) }, 4.4);
      energyLabels.set(pv.id, middle);
    }
    // Panels: a switchboard with its doors toward the lanes, or a panel on the facade.
    const panelY = new Map<string, number>();
    for (const p of layout.panels) {
      const g = p.mount === 'pad' ? t.switchboard() : t.wallPanel();
      g.position.set(p.x, 0, p.z);
      site.add(g);
      panelY.set(`${String(p.x)}:${String(p.z)}`, PANEL_LINK_Y[p.mount]);
    }
    // Links: from a panel to a circuit node and on to the station's
    // back (stationBackPoint, which follows the row's turn) or its wall box.
    // On an office or retail site the circuit nodes hang above the wall boxes.
    const nodeY = office ? 2.6 : 1.0;
    const yAt = (p: Point): number => panelY.get(`${String(p.x)}:${String(p.z)}`) ?? nodeY;
    for (const seg of layout.links.segments) {
      const from = lotPoint(seg.from, yAt(seg.from));
      let to: THREE.Vector3;
      if (seg.kind === 'station') {
        const onWall = objects.get(seg.id.slice('station:'.length))?.station.wall === true;
        to = lotPoint(seg.to, onWall ? 1.2 : 0.9);
      } else {
        to = lotPoint(seg.to, yAt(seg.to));
      }
      site.add(buildLink(from, to, seg.kind, seg.id));
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
    const mountOf = new Map(layout.panels.map((p) => [`panel:${p.id}`, p.mount]));
    for (const label of layout.links.labels) {
      if (label.kind === 'circuit') {
        const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
        node.position.copy(lotPoint(label.point, nodeY));
        node.raycast = () => undefined;
        site.add(node);
      }
      const mount = mountOf.get(label.id);
      const y =
        label.kind === 'station'
          ? 1.6
          : label.kind === 'panel' && mount != null
            ? PANEL_LABEL_Y[mount]
            : nodeY + 0.5;
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

  function fit(): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    applyZoomLimit();
    // The front camera, and the overview of an office or retail site (the
    // building stays behind the lot), turn with the facing.
    if (options.view === 'front' || layout.lot.siteType === 'office_retail') {
      const front = frontCamera(
        options.view === 'front' ? lotBox : siteBox,
        layout.lot.facing,
        width / height,
        options.view === 'front' ? FRONT_CAMERA_OFFSET : OVERVIEW_CAMERA_OFFSET,
      );
      controls.target.set(front.target.x, front.target.y, front.target.z);
      camera.position.set(front.position.x, front.position.y, front.position.z);
    } else {
      const { target, distance } = fitFrame(frameBox, width / height);
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
  let drag: { kind: 'station' | 'transformer' | 'battery'; id: string; pointerId: number } | null =
    null;
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
  function pick(
    e: PointerEvent,
  ): { kind: 'station' | 'transformer' | 'battery'; id: string } | null {
    setRay(e);
    const groups = [...objects.values()].map((o) => o.group);
    groups.push(...transformerObjects.values(), ...batteryObjects.values());
    const hit = ray
      .intersectObjects(groups, true)
      .find((h) => h.object.type === 'Mesh' && h.object.userData['ring'] !== true);
    if (hit == null) return null;
    const stationId: unknown = hit.object.userData['stationId'];
    if (typeof stationId === 'string') return { kind: 'station', id: stationId };
    const transformerId: unknown = hit.object.userData['transformerId'];
    if (typeof transformerId === 'string') return { kind: 'transformer', id: transformerId };
    const batteryId: unknown = hit.object.userData['batteryId'];
    if (typeof batteryId === 'string') return { kind: 'battery', id: batteryId };
    return null;
  }
  // The pointer on the ground, in lot coordinates.
  function groundPoint(e: PointerEvent): THREE.Vector3 | null {
    setRay(e);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(floor, p) == null) return null;
    return site.worldToLocal(p);
  }
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
    if (!editing) return;
    const hit = pick(e);
    if (hit == null) return;
    drag = { ...hit, pointerId: e.pointerId };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent): void {
    if (drag == null) {
      if (e.pointerType === 'mouse') {
        canvas.style.cursor = pick(e) != null ? (editing ? 'grab' : 'pointer') : 'default';
      }
      return;
    }
    const p = groundPoint(e);
    if (p == null) return;
    if (drag.kind === 'transformer' || drag.kind === 'battery') {
      const g = (drag.kind === 'battery' ? batteryObjects : transformerObjects).get(drag.id);
      if (g == null) return;
      const snapped = callbacks.snapTransformer({ x: p.x, z: p.z });
      g.position.set(snapped.x, 0, snapped.z);
      return;
    }
    const obj = objects.get(drag.id);
    if (obj == null) return;
    const clamped = clampToLot(p.x, p.z, layout.lot);
    obj.group.position.x = clamped.x;
    obj.group.position.z = clamped.z;
    const over = lotToBay(obj.group.position.x, obj.group.position.z, layout.lot);
    // Turn with the row it is over, so the drop preview faces its lane.
    obj.group.rotation.y = bayTurn(over, layout.lot);
    const blocked = callbacks.isBayTaken(over, drag.id);
    obj.ring.material.color.set(blocked ? theme.destructive : theme.primary);
    obj.ring.material.opacity = 0.9;
  }
  function onPointerUp(e: PointerEvent): void {
    if (drag != null) {
      const { id, kind } = drag;
      drag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
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
      const obj = objects.get(id);
      if (obj != null) {
        const bay = lotToBay(obj.group.position.x, obj.group.position.z, layout.lot);
        // Back to its spot until the new positions arrive.
        obj.group.position.copy(lotPoint(bayToLot(obj.station.bay, layout.lot)));
        obj.group.rotation.y = bayTurn(obj.station.bay, layout.lot);
        applySelection();
        callbacks.onDrop(id, bay);
      }
      return;
    }
    if (downAt != null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const hit = pick(e);
    callbacks.onPick(hit?.kind === 'station' ? hit.id : null);
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
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

  function loop(now: number): void {
    if (disposed || !active) return;
    controls.update();
    keepTargetOnSite();
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
        next.lot.siteType !== layout.lot.siteType;
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
      if (!next && drag != null) {
        drag = null;
        controls.enabled = true;
      }
    },
    setSelected(id) {
      selected = id;
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
    fit() {
      hasFitted = true;
      fit();
    },
    setActive(next) {
      if (next === active || disposed) return;
      active = next;
      cancelAnimationFrame(animationFrame);
      if (next) animationFrame = requestAnimationFrame(loop);
    },
    setLinkFlow(next) {
      linkFlow = next;
      for (const [id, entry] of linkMeshes) styleLink(entry, next.get(id) ?? null);
    },
    focus: focusStation,
    viewDistance: () => camera.position.distanceTo(controls.target),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    avatarPoint,
    labelPoint,
    energyLabelPoint,
    transformerLabelPoint,
    linkLabelPoint,
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      for (const item of built) item.dispose();
      built = [];
      logo?.texture.dispose();
      logo = null;
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
