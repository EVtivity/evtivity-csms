// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The shared state and helpers of the 3D site scene, passed to each scene module.

import type { EvsePlateMount } from './site-layout-model-evse-plate';
import { type DepotLayout, type FreePlacement, type FreeSpotRect } from '@evtivity/lib/site-layout';
import type { VehicleBodyType } from '@evtivity/lib/vehicle-appearance';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type CarPort, type Point3 } from './site-layout-cable';
import { type SurfaceAt } from './site-layout-cable-surface';
import type { CarKit } from './site-layout-car-geometry';
import { type ConnectorKit, type ConnectorMaterials } from './site-layout-connector-geometry';
import { type CableEntry, type ConnectorKind } from './site-layout-connectors';
import type { FreeChargerModel } from './site-layout-free';
import type { VehicleInletKind } from './site-layout-vehicle-inlet';
import {
  SCREEN_MESSAGE,
  type AlignmentGuide,
  type Box,
  type ChargerLogoModel,
  type Point,
  type VirtualSign,
} from './site-layout-grid';
import { type RaisedRect } from './site-layout-ground';
import type { LinkKind } from './site-layout-links';
import { type CableHookSpec } from './site-layout-model-cable-hook';
import type { WallBoxRingReader } from './site-layout-model-wall-box';
import type { ChargerKit, ChargerSlot } from './site-layout-model-charger-parts';
import type { ModelKit } from './site-layout-model-kit';
import { type RowCarport } from './site-layout-solar';

import {
  type Disposable,
  type LinkMeshes,
  type Palette,
  type PickKind,
  type Point3Tuple,
  type SceneCallbacks,
  type SceneCameraView,
  type SceneLayout,
  type SceneStation,
  type SceneTheme,
  type ScreenPoint,
  type StationMaterials,
  type StationObject,
  type Templates,
} from './site-layout-scene-types';

export interface SceneCtx {
  chargerBody: (
    g: THREE.Group,
    s: SceneStation,
    palette: Palette,
    m: StationMaterials,
  ) => { top: number; labelZ: number; glow: StationObject['glow'] };
  container: HTMLElement;
  options: { reducedMotion: boolean; view?: SceneCameraView };
  callbacks: SceneCallbacks;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls<THREE.PerspectiveCamera>;
  fog: THREE.Fog;
  sun: THREE.DirectionalLight;
  carKits: Map<string, CarKit>;
  carKit: (
    bodyType: VehicleBodyType,
    port?: CarPort,
    inlet?: VehicleInletKind,
    plug?: ConnectorKind | null,
  ) => CarKit;
  built: Disposable[];
  track: <T extends Disposable>(item: T) => T;
  M: (color: string, extra?: THREE.MeshStandardMaterialParameters) => THREE.MeshStandardMaterial;
  shadowed: <T extends THREE.Mesh>(mesh: T) => T;
  box: (
    w: number,
    h: number,
    d: number,
    material: THREE.Material | THREE.Material[],
  ) => THREE.Mesh<THREE.BoxGeometry>;
  cylinder: (
    r: number,
    h: number,
    segments: number,
    material: THREE.Material,
  ) => THREE.Mesh<THREE.CylinderGeometry, THREE.Material>;
  roundedPrism: (
    w: number,
    d: number,
    h: number,
    r: number,
    material: THREE.Material,
  ) => THREE.Mesh<THREE.ExtrudeGeometry, THREE.Material>;
  /**
   * The number plate of EVSE `index` of a station (site-layout-scene-evse-plates.ts)
   * and the material of its status light, which the EVSE's own port lights share.
   */
  addEvsePlate: (
    g: THREE.Object3D,
    s: SceneStation,
    index: number,
    mount: EvsePlateMount,
  ) => { plate: THREE.Group; light: THREE.MeshStandardMaterial };
  /**
   * A port's own status light (a pedestal lens, a wall box ring) in the
   * material of its EVSE's plate light (`addEvsePlate`), so it shows that
   * EVSE's state and pulses and blinks with it; kept out of the station merge.
   */
  addEvsePortLight: (
    g: THREE.Object3D,
    light: THREE.MeshStandardMaterial,
    geometry: THREE.BufferGeometry,
    at: readonly [number, number, number],
    tiltX?: number,
  ) => THREE.Mesh;
  /** A wall box port's ring reader: the tap pictogram in its status ring and the tap line under it. */
  addRingReader: (g: THREE.Object3D, reader: WallBoxRingReader, dz?: number) => THREE.Group;
  /** An RFID reader pad with its tap label (site-layout-scene-rfid.ts). */
  addRfidPad: (
    g: THREE.Object3D,
    at: readonly [number, number, number],
    o?: { windowM?: number; tiltX?: number; turnY?: number },
  ) => THREE.Group;
  cableHook: (
    spec: CableHookSpec,
    at: readonly [number, number, number],
    turnY: number,
  ) => THREE.Group;
  cable: (
    points: Array<[number, number, number]>,
    material: THREE.Material,
    radius?: number,
  ) => THREE.Mesh<THREE.TubeGeometry, THREE.Material>;
  chargingCable: (
    points: Array<[number, number, number]>,
    material: THREE.Material,
    radius?: number,
    flowing?: boolean,
  ) => THREE.Group;
  /** The charge flow alone (light tube and halo) along a path that carries energy but no cable. */
  chargeFlowPath: (points: Array<[number, number, number]>, radius?: number) => THREE.Group;
  /** A soft green glow where a pantograph head meets its contact rails, `radiusM` across. */
  chargeContactGlow: (at: readonly [number, number, number], radiusM: number) => THREE.Mesh;
  connectorKits: Map<string, ConnectorKit>;
  modelKits: Map<string, ModelKit<string>>;
  modelKit: <S extends string>(key: string, make: () => ModelKit<S>) => ModelKit<S>;
  chargerKit: (key: string, make: () => ChargerKit) => ChargerKit;
  connectorMaterialSet: { handle: ConnectorMaterials; holster: ConnectorMaterials } | null;
  handleTemplates: Map<string, THREE.Group>;
  connectorHandle: (kind: ConnectorKind) => THREE.Group;
  sideHolsterCable: (
    gland: { at: Point3Tuple; axis: Point3Tuple },
    side: number,
    entry: CableEntry,
    kind: ConnectorKind,
  ) => THREE.Mesh;
  holsteredConnector: (
    parent: THREE.Object3D,
    kind: ConnectorKind,
    mount: Point3,
    facing: { x: number; z: number },
    plugged: boolean,
    noseUp?: number,
  ) => CableEntry;
  theme: SceneTheme;
  layout: SceneLayout;
  frameBox: Box;
  siteBox: Box;
  lotBox: Box;
  pan: Box;
  editing: boolean;
  selected: string | null;
  selectedSolar: string | null;
  lastFitDense: boolean;
  logo: { texture: THREE.CanvasTexture; width: number; height: number } | null;
  objects: Map<string, StationObject>;
  transformerObjects: Map<string, THREE.Group>;
  batteryObjects: Map<string, THREE.Group>;
  solarObjects: Map<string, THREE.Group>;
  screenScrolls: { texture: THREE.Texture; speed: number }[];
  guideGroup: THREE.Group;
  energyLabels: Map<string, THREE.Vector3>;
  virtualSprites: Map<string, THREE.Sprite>;
  linkLabels: Map<string, THREE.Vector3>;
  flowTextures: THREE.Texture[];
  chargeFlowTextures: THREE.Texture[];
  linkMeshes: Map<string, LinkMeshes>;
  linkFlow: ReadonlyMap<string, number>;
  site: THREE.Group;
  ground: THREE.Group;
  editGrid: THREE.Group;
  lotPoint: (p: Point, y?: number) => THREE.Vector3;
  poseOf: (s: SceneStation) => { point: Point; turn: number };
  addScreenMessage: (
    g: THREE.Group,
    s: SceneStation,
    kind: keyof typeof SCREEN_MESSAGE,
    position: [number, number, number],
  ) => void;
  addFreeSpots: (g: THREE.Group, s: SceneStation, palette: Palette) => void;
  arrowGeometry: () => THREE.BufferGeometry;
  freeHandle: (stationId: string, handleZ: number, spotsBack: number) => THREE.Group;
  guideDash: THREE.BoxGeometry;
  guideMaterial: THREE.MeshBasicMaterial;
  showGuides: (guides: readonly AlignmentGuide[]) => void;
  spotTexture: (asphalt: string, paint: string, withLane?: boolean) => THREE.CanvasTexture;
  buildParkingRows: (palette: Palette) => void;
  addAccessibleSpace: (palette: Palette) => void;
  grassTexture: (palette: Palette) => THREE.CanvasTexture;
  flowTexture: () => THREE.CanvasTexture;
  haloTexture: THREE.CanvasTexture | null;
  glowTexture: () => THREE.CanvasTexture;
  templates: (palette: Palette) => Templates;
  evSignTexture: (kind: 'chargingOnly' | 'towAway') => THREE.CanvasTexture;
  virtualSignSprite: (kind: VirtualSign, stationId: string) => THREE.Sprite;
  warningTexture: () => THREE.CanvasTexture;
  logoPanel: (
    model: ChargerLogoModel,
    palette: Palette,
    at?: { x: number; z: number },
  ) => THREE.Group;
  addGlow: (
    g: THREE.Group,
    s: SceneStation,
    strips: Array<{ geometry: THREE.BufferGeometry; position: [number, number, number] }>,
    halo: { size: number; position: [number, number, number] },
  ) => StationObject['glow'];
  socketRing: (radius: number) => THREE.TorusGeometry;
  cabinetGlow: (
    g: THREE.Group,
    s: SceneStation,
    c: [number, number, number],
  ) => StationObject['glow'];
  buildLargeCharger: (
    g: THREE.Group,
    s: SceneStation,
    model: Exclude<FreeChargerModel, 'standard'>,
    palette: Palette,
    m: StationMaterials,
  ) => { top: number; glow: StationObject['glow'] };
  placeLargeSpotProp: (
    g: THREE.Group,
    s: SceneStation,
    t: Templates,
    rect: FreeSpotRect,
    model: FreeChargerModel,
    palette: Palette,
  ) => THREE.Vector3 | null;
  signPosts: Point[];
  chargerShared: Pick<
    Record<
      'light' | 'shell' | 'trim' | 'accent' | 'glass' | 'metal' | 'rubber' | 'stop' | 'warn',
      THREE.Material
    >,
    'metal' | 'rubber' | 'stop' | 'warn'
  > | null;
  chargerMaterials: (
    shell: THREE.Material,
    trim: THREE.Material,
    accent: THREE.Material,
    glass: THREE.Material,
    light: THREE.Material,
  ) => Record<ChargerSlot, THREE.Material>;
  bollardMaterials: Record<'paint' | 'band' | 'concrete' | 'sleeve', THREE.Material> | null;
  pipeBollard: (x: number, z: number, heightM?: number, baseY?: number) => THREE.Group;
  modelOf: <S extends string>(
    kit: ModelKit<S>,
    model: string,
    materials: Readonly<Record<S, THREE.Material>>,
  ) => THREE.Group;
  marker: (feature: string, at: [number, number, number]) => THREE.Object3D;
  cableGround: SurfaceAt | null;
  siteRaisedRects: RaisedRect[];
  buildModel: (s: SceneStation, palette: Palette, t: Templates) => StationObject;
  buildFreeSolarCanopy: (
    free: FreePlacement & { lengthM: number; depthM: number },
    palette: Palette,
  ) => THREE.Group;
  rowCenterZ: (row: number) => number;
  solarRowCarport: (row: number) => RowCarport;
  buildSolarCanopy: (carport: RowCarport, palette: Palette) => THREE.Group;
  solarTextureCache: THREE.CanvasTexture | null;
  buildBuilding: (palette: Palette) => void;
  buildDepotYard: (palette: Palette, depot: DepotLayout) => void;
  buildStreet: (palette: Palette, along: Box) => void;
  buildLink: (
    points: readonly THREE.Vector3[],
    kind: LinkKind,
    id: string,
    flowId: string,
  ) => THREE.Group;
  styleLink: (entry: LinkMeshes, flow: number | null) => void;
  rebuild: () => void;
  applySelection: () => void;
  mergeStations: () => void;
  fit: (toggle?: boolean) => void;
  applyZoomLimit: () => void;
  updateFog: () => void;
  resize: () => void;
  labelPoint: (stationId: string) => ScreenPoint | null;
  avatarPoint: (stationId: string) => ScreenPoint | null;
  virtualSignPoint: (stationId: string) => ScreenPoint | null;
  evsePlatePoint: (stationId: string, index: number) => ScreenPoint | null;
  focusStation: (stationId: string) => void;
  /** Makes a point the orbit center, easing in to frame `heightM` when given (`site-layout-camera-nav.ts`). */
  focusAt: (point: THREE.Vector3, heightM: number | null) => void;
  /** One frame of a camera move in progress; true while it runs. */
  stepCameraEase: (nowMs: number) => boolean;
  /** Ends a camera move in progress (wheel, drag or key input took over). */
  cancelCameraEase: () => void;
  /** The 3D point under a pointer position: the model there, else the ground. */
  pointUnder: (e: { clientX: number; clientY: number }) => THREE.Vector3 | null;
  transformerLabelPoint: (id: string) => ScreenPoint | null;
  energyLabelPoint: (id: string) => ScreenPoint | null;
  linkLabelPoint: (id: string) => ScreenPoint | null;
  drag: {
    kind: PickKind;
    id: string;
    pointerId: number;
    grab: Point;
    start: { x: number; y: number };
    moved: boolean;
  } | null;
  canvas: HTMLCanvasElement;
  onDoubleClick: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
}

/**
 * The part of the scene context one scene module receives: `R` the members it
 * only reads (read-only here), `W` the members it installs or writes. A module
 * sees no other member, so it cannot come to depend on one unnoticed
 * (`site-layout-scene-slices.test.ts` checks each list matches the module).
 */
export type SceneSlice<
  R extends Exclude<keyof SceneCtx, W>,
  W extends keyof SceneCtx = never,
> = Readonly<Pick<SceneCtx, R>> & Pick<SceneCtx, W>;
