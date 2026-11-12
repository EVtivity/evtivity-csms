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

import { DEFAULT_THEME_COLOR } from '@evtivity/lib/charger-plate-colors';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { chargeFlowOffset } from './site-layout-cable';
import {
  CAMERA_FOV,
  MAX_POLAR_ANGLE,
  MIN_DISTANCE,
  bayToWorld as bayToLot,
  bayTurn,
  chargingGlowLevel,
  clampCameraHeight,
  clampTarget,
  faultLightLevel,
  panBox,
  type Point,
} from './site-layout-grid';
import { zoomTowardPoint } from './site-layout-camera-nav';
import { nudgeOrbit } from './site-layout-keyboard-nav';
import { ENGLISH_SIGN_TEXTS } from './site-layout-signs';

import { installCables } from './site-layout-scene-cables';
import { installCamera } from './site-layout-scene-camera';
import { installConnectors } from './site-layout-scene-connectors';
import type { SceneCtx } from './site-layout-scene-context';
import { installDressing, loadLogoCanvas } from './site-layout-scene-dressing';
import { installFreeSpots } from './site-layout-scene-free-spots';
import { installGround } from './site-layout-scene-ground';
import { installInteraction } from './site-layout-scene-interaction';
import { installKit } from './site-layout-scene-kit';
import { installLargeChargers } from './site-layout-scene-large-chargers';
import { installChargerModel } from './site-layout-scene-charger-model';
import { installLinks } from './site-layout-scene-links';
import { installMerge, mergesStations } from './site-layout-scene-merge';
import { installRebuild } from './site-layout-scene-rebuild';
import { evsePlateLights, installEvsePlates } from './site-layout-scene-evse-plates';
import { installUnitPlates } from './site-layout-scene-unit-plates';
import { installRfidPads } from './site-layout-scene-rfid';
import { installScreenText } from './site-layout-scene-screen-text';
import { installSigns } from './site-layout-scene-signs';
import { installSolar } from './site-layout-scene-solar';
import { installStationModel } from './site-layout-scene-station-model';
import { installTemplates } from './site-layout-scene-templates';
import {
  type LinkMeshes,
  type SceneCallbacks,
  type SceneCameraView,
  type SceneStation,
  type SiteScene,
  type StationObject,
} from './site-layout-scene-types';

export function createSiteScene(
  container: HTMLElement,
  options: { reducedMotion: boolean; view?: SceneCameraView },
  callbacks: SceneCallbacks,
): SiteScene {
  const scn = {} as SceneCtx;
  scn.container = container;
  scn.options = options;
  scn.callbacks = callbacks;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  scn.renderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.setAttribute('data-testid', 'site-layout-3d-canvas');
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scn.scene = scene;
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 2000);
  scn.camera = camera;
  const controls = new OrbitControls(camera, renderer.domElement);
  scn.controls = controls;
  controls.enableDamping = !options.reducedMotion;
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.minDistance = MIN_DISTANCE;
  // A touchscreen pinch (the orbit controls' own zoom) zooms toward the fingers, like a map.
  controls.zoomToCursor = true;
  // Panning moves along the ground, like a map, so the view never lifts off the site.
  controls.screenSpacePanning = false;
  controls.maxDistance = 400;
  const fog = new THREE.Fog(0xffffff, 100, 400);
  scn.fog = fog;
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
  scn.sun = sun;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  // A softer shadow edge (PCF filter radius).
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  scn.theme = {
    dark: false,
    signs: ENGLISH_SIGN_TEXTS,
    virtualColors: { reserved: '#f59e0b', maintenance: '#f59e0b' },
    primary: '#2563eb',
    destructive: '#ef4444',
    plateColors: { ac: DEFAULT_THEME_COLOR, dc: DEFAULT_THEME_COLOR },
  };
  scn.layout = {
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
  scn.frameBox = { minX: 0, maxX: 26, minZ: 0, maxZ: 18 };
  // The same box before the facing turns it (the front camera frames it).
  scn.siteBox = scn.frameBox;
  // The lot and its stations only (lot coordinates): the front camera frames
  // the chargers, not the transformers and panels on the grass beside them.
  scn.lotBox = scn.frameBox;
  scn.pan = panBox(scn.frameBox);
  scn.editing = false;
  scn.selected = null;
  scn.selectedSolar = null;
  // Fit to View on a narrow stage alternates the densest part and the whole site.
  scn.lastFitDense = false;
  scn.logo = null;
  let logoUrl: string | null = null;
  const objects = new Map<string, StationObject>();
  scn.objects = objects;
  const transformerObjects = new Map<string, THREE.Group>();
  scn.transformerObjects = transformerObjects;
  const batteryObjects = new Map<string, THREE.Group>();
  scn.batteryObjects = batteryObjects;
  const solarObjects = new Map<string, THREE.Group>();
  scn.solarObjects = solarObjects;
  // Scrolling display messages on charger screens (texture and its speed per second).
  const screenScrolls: Array<{ texture: THREE.Texture; speed: number }> = [];
  scn.screenScrolls = screenScrolls;
  // Alignment guides while a station of a custom site is dragged.
  const guideGroup = new THREE.Group();
  scn.guideGroup = guideGroup;
  // Label points of the batteries and solar canopies (lot coordinates).
  const energyLabels = new Map<string, THREE.Vector3>();
  scn.energyLabels = energyLabels;
  // The virtual status signs by station (hover shows their time window).
  const virtualSprites = new Map<string, THREE.Sprite>();
  scn.virtualSprites = virtualSprites;
  const linkLabels = new Map<string, THREE.Vector3>();
  scn.linkLabels = linkLabels;
  const flowTextures: THREE.Texture[] = [];
  scn.flowTextures = flowTextures;
  // The charge flow on the cables of charging vehicles (`CHARGE_FLOW`).
  const chargeFlowTextures: THREE.Texture[] = [];
  scn.chargeFlowTextures = chargeFlowTextures;
  // The link meshes by segment id, so the live flow restyles them without a rebuild.
  const linkMeshes = new Map<string, LinkMeshes>();
  scn.linkMeshes = linkMeshes;
  scn.linkFlow = new Map();
  const site = new THREE.Group();
  scn.site = site;
  const ground = new THREE.Group();
  scn.ground = ground;
  const editGrid = new THREE.Group();
  scn.editGrid = editGrid;
  scene.add(ground, site);

  const lotPoint = (p: Point, y = 0) => new THREE.Vector3(p.x, y, p.z);
  scn.lotPoint = lotPoint;

  // Where a station stands and its turn about the vertical axis: its free
  // position on a custom site, else its spot (a turned row faces back).
  function poseOf(s: SceneStation): { point: Point; turn: number } {
    if (s.free != null) {
      return { point: { x: s.free.x, z: s.free.z }, turn: (-s.free.rotationDeg * Math.PI) / 180 };
    }
    const point = bayToLot(s.bay, scn.layout.lot);
    const turn = bayTurn(s.bay, scn.layout.lot);
    // Back along its own -z (a turned row: +z in lot meters).
    return {
      point: { x: point.x + (s.shiftX ?? 0), z: point.z - (s.backShift ?? 0) * Math.cos(turn) },
      turn,
    };
  }
  scn.poseOf = poseOf;
  installKit(scn);
  installCables(scn);
  installConnectors(scn);
  installRfidPads(scn);
  installEvsePlates(scn);
  installUnitPlates(scn);
  installScreenText(scn);
  installFreeSpots(scn);
  installGround(scn);
  installTemplates(scn);
  installSigns(scn);
  installDressing(scn);
  installLargeChargers(scn);
  installChargerModel(scn);
  installStationModel(scn);
  installSolar(scn);
  installLinks(scn);
  installRebuild(scn);
  installMerge(scn);
  installCamera(scn);
  installInteraction(scn);
  scn.canvas.addEventListener('pointerdown', scn.onPointerDown);
  scn.canvas.addEventListener('pointermove', scn.onPointerMove);
  scn.canvas.addEventListener('pointerleave', scn.onPointerLeave);
  scn.canvas.addEventListener('pointerup', scn.onPointerUp);
  scn.canvas.addEventListener('dblclick', scn.onDoubleClick);
  // A drag of the view takes over from a camera move in progress.
  const endEase = (): void => {
    scn.cancelCameraEase();
  };
  scn.canvas.addEventListener('pointerdown', endEase);

  const observer = new ResizeObserver(() => {
    scn.resize();
  });
  observer.observe(container);
  scn.resize();

  const t0 = performance.now();
  let animationFrame = 0;
  let disposed = false;
  let active = true;
  const panned = new THREE.Vector3();
  // Panning stops at the grass around the site.
  function keepTargetOnSite(): void {
    const target = controls.target;
    const c = clampTarget(target.x, target.z, scn.pan);
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
    scn.stepCameraEase(now);
    controls.update();
    keepTargetOnSite();
    keepCameraAboveGround();
    scn.updateFog();
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
      // Energy flowing along each charging cable toward its vehicle.
      const flowOffset = chargeFlowOffset(time);
      for (const tex of chargeFlowTextures) tex.offset.x = flowOffset;
      // Long display messages scroll across the charger screens.
      for (const scroll of screenScrolls) scroll.texture.offset.x = time * scroll.speed;
      // A faulted station's status light blinks in its red state color.
      const fault = faultLightLevel(time);
      for (const obj of objects.values()) {
        if (obj.station.blinking) obj.light.emissiveIntensity = fault;
      }
      // Each EVSE's own light on its plate: pulsing while it charges, blinking while faulted.
      for (const plate of evsePlateLights(scn, scn.built)) {
        const lamp = plate.station.evseLamps?.[plate.index];
        if (lamp == null || !plate.station.lit) continue;
        if (lamp.blinking) plate.light.emissiveIntensity = fault;
        else if (lamp.pulsing) plate.light.emissiveIntensity = 0.55 + 0.4 * Math.sin(time * 3);
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
        next.lot.width !== scn.layout.lot.width ||
        next.lot.depth !== scn.layout.lot.depth ||
        next.lot.facing !== scn.layout.lot.facing ||
        next.lot.siteType !== scn.layout.lot.siteType ||
        next.lot.rowLengths.join(',') !== scn.layout.lot.rowLengths.join(',');
      const first = !hasFitted && next.stations.length > 0;
      scn.layout = next;
      scn.rebuild();
      scn.applyZoomLimit();
      if (first || (hasFitted && lotChanged)) {
        hasFitted = true;
        scn.fit();
      }
    },
    setTheme(next) {
      scn.theme = next;
      scn.rebuild();
    },
    setEditing(next) {
      const remerge = next !== scn.editing && mergesStations(scn.layout.stations.length);
      scn.editing = next;
      // A merged site splits its stations again to drag them (and merges them after).
      if (remerge) scn.rebuild();
      editGrid.visible = next;
      // The rotation handle shows only in Edit Layout.
      scn.applySelection();
      if (!next && scn.drag != null) {
        scn.drag = null;
        controls.enabled = true;
      }
    },
    setSelected(id) {
      scn.selected = id;
      scn.applySelection();
    },
    setSelectedSolar(id) {
      scn.selectedSolar = id;
      scn.applySelection();
    },
    setLogo(url) {
      if (url === logoUrl) return;
      logoUrl = url;
      if (url == null) {
        scn.logo?.texture.dispose();
        scn.logo = null;
        scn.rebuild();
        return;
      }
      void loadLogoCanvas(url).then((canvasImage) => {
        if (disposed || logoUrl !== url) return;
        scn.logo?.texture.dispose();
        if (canvasImage == null) {
          scn.logo = null;
        } else {
          const texture = new THREE.CanvasTexture(canvasImage);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          scn.logo = { texture, width: canvasImage.width, height: canvasImage.height };
        }
        scn.rebuild();
      });
    },
    fit(toggle) {
      hasFitted = true;
      scn.fit(toggle === true);
    },
    nudgeCamera(n) {
      if (disposed) return;
      scn.cancelCameraEase();
      const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      const next = nudgeOrbit(
        {
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
          azimuth: sph.theta,
          polar: sph.phi,
          distance: sph.radius,
        },
        n,
        {
          pan: scn.pan,
          maxDistance: controls.maxDistance,
          minDistance: MIN_DISTANCE,
          minPolar: controls.minPolarAngle,
          maxPolar: MAX_POLAR_ANGLE,
        },
      );
      controls.target.set(next.target.x, next.target.y, next.target.z);
      sph.set(next.distance, next.polar, next.azimuth);
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      keepTargetOnSite();
      keepCameraAboveGround();
      controls.update();
    },
    zoomAt(zoom, at) {
      if (disposed || zoom === 0) return;
      scn.cancelCameraEase();
      const point = scn.pointUnder(at);
      const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      const state = {
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        azimuth: sph.theta,
        polar: sph.phi,
        distance: sph.radius,
      };
      const limits = { pan: scn.pan, maxDistance: controls.maxDistance, minDistance: MIN_DISTANCE };
      // Above the horizon there is no point under the pointer: zoom at the center.
      const next = zoomTowardPoint(state, point ?? state.target, zoom, limits);
      controls.target.set(next.target.x, next.target.y, next.target.z);
      sph.set(next.distance, next.polar, next.azimuth);
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      keepTargetOnSite();
      keepCameraAboveGround();
      controls.update();
    },
    setActive(next) {
      if (next === active || disposed) return;
      active = next;
      cancelAnimationFrame(animationFrame);
      if (next) animationFrame = requestAnimationFrame(loop);
    },
    setLinkFlow(next) {
      scn.linkFlow = next;
      for (const entry of linkMeshes.values()) scn.styleLink(entry, next.get(entry.flowId) ?? null);
    },
    focus: scn.focusStation,
    viewDistance: () => camera.position.distanceTo(controls.target),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    avatarPoint: scn.avatarPoint,
    labelPoint: scn.labelPoint,
    energyLabelPoint: scn.energyLabelPoint,
    transformerLabelPoint: scn.transformerLabelPoint,
    linkLabelPoint: scn.linkLabelPoint,
    virtualSignPoint: scn.virtualSignPoint,
    evsePlatePoint: scn.evsePlatePoint,
    unitPlatePoint: scn.unitPlatePoint,
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      scn.canvas.removeEventListener('pointerdown', scn.onPointerDown);
      scn.canvas.removeEventListener('pointermove', scn.onPointerMove);
      scn.canvas.removeEventListener('pointerleave', scn.onPointerLeave);
      scn.canvas.removeEventListener('pointerup', scn.onPointerUp);
      scn.canvas.removeEventListener('dblclick', scn.onDoubleClick);
      scn.canvas.removeEventListener('pointerdown', endEase);
      controls.dispose();
      scn.showGuides([]);
      scn.guideDash.dispose();
      scn.guideMaterial.dispose();
      for (const item of scn.built) item.dispose();
      scn.built = [];
      for (const kit of scn.carKits.values()) for (const g of kit.geometries) g.dispose();
      scn.carKits.clear();
      for (const kit of scn.connectorKits.values()) for (const g of kit.geometries) g.dispose();
      scn.connectorKits.clear();
      for (const kit of scn.modelKits.values()) for (const g of kit.geometries) g.dispose();
      scn.modelKits.clear();
      environment.dispose();
      scn.logo?.texture.dispose();
      scn.logo = null;
      renderer.dispose();
      renderer.forceContextLoss();
      scn.canvas.remove();
    },
  };
}
