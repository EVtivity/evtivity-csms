// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The three.js scene of the 3D site layout: an asphalt lot with painted
// parking bays, a concrete pad per station and a DC fast charger or AC
// pedestal model built in code. Only SiteLayout3D imports this module, and
// SiteLayout loads SiteLayout3D with React.lazy, so three.js stays out of
// every other chunk.
//
// Bay (col, row) is grid slot (col, row) of the 2D board (@evtivity/lib/site-layout):
// x = 20 + 200 col, y = 20 + 140 row px. The lot shows at least 5 columns and
// 2 rows, plus one free row below the last station.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LayoutBay } from '@evtivity/lib/site-layout';
import { SCENE_COLORS } from './site-layout-colors';

/** Bay width and depth in meters. */
const BAY_W = 3.2;
const BAY_D = 5.6;

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
}

export interface SceneTheme {
  dark: boolean;
  /** Scene background (a CSS color). */
  background: string;
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
  visible: boolean;
}

export interface SceneCallbacks {
  /** A click or tap on a station (null on the floor). */
  onPick: (stationId: string | null) => void;
  /** A drag in edit mode ended over this bay. */
  onDrop: (stationId: string, bay: LayoutBay) => void;
  /** Whether another station holds the bay. */
  isBayTaken: (bay: LayoutBay, exceptId: string) => boolean;
  /** Runs after every rendered frame (labels and popup follow the models). */
  onFrame: () => void;
}

export interface SiteScene {
  setStations: (stations: readonly SceneStation[], cols: number, rows: number) => void;
  setTheme: (theme: SceneTheme) => void;
  setEditing: (editing: boolean) => void;
  setSelected: (stationId: string | null) => void;
  fit: () => void;
  /** Where above a station its label goes, in px of the container. */
  labelPoint: (stationId: string) => ScreenPoint | null;
  dispose: () => void;
}

type Disposable = { dispose: () => void };

interface StationObject {
  group: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  light: THREE.MeshStandardMaterial;
  top: number;
  station: SceneStation;
}

export function createSiteScene(
  container: HTMLElement,
  options: { reducedMotion: boolean },
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
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !options.reducedMotion;
  controls.maxPolarAngle = Math.PI * 0.45;
  controls.minDistance = 6;
  controls.maxDistance = 120;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(-12, 22, 16);
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
  const box = (w: number, h: number, d: number, material: THREE.Material) =>
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
    background: '#f8fafc',
    primary: '#2563eb',
    destructive: '#ef4444',
  };
  let stations: readonly SceneStation[] = [];
  let cols = 5;
  let rows = 2;
  let editing = false;
  let selected: string | null = null;
  const objects = new Map<string, StationObject>();
  const ground = new THREE.Group();
  const editGrid = new THREE.Group();
  scene.add(ground, editGrid);

  const lotW = () => cols * BAY_W;
  const lotD = () => rows * BAY_D;
  const bayToWorld = (bay: LayoutBay) =>
    new THREE.Vector3(
      -lotW() / 2 + BAY_W * (bay.col + 0.5),
      0,
      -lotD() / 2 + BAY_D * bay.row + 0.9,
    );
  const worldToBay = (v: THREE.Vector3): LayoutBay => ({
    col: Math.min(cols - 1, Math.max(0, Math.floor((v.x + lotW() / 2) / BAY_W))),
    row: Math.min(rows - 1, Math.max(0, Math.floor((v.z - 0.9 + BAY_D / 2 + lotD() / 2) / BAY_D))),
  });

  function buildModel(
    s: SceneStation,
    palette: (typeof SCENE_COLORS)['light'] | (typeof SCENE_COLORS)['dark'],
  ): StationObject {
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
    const pad = box(dc ? 1.6 : 1.0, 0.08, dc ? 1.2 : 0.9, M(palette.concrete, { roughness: 0.95 }));
    pad.position.y = 0.04;
    g.add(pad);
    let top: number;
    if (dc) {
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
    ring.position.y = 0.09;
    ring.userData['ring'] = true;
    g.add(ring);
    g.traverse((o) => {
      o.userData['stationId'] = s.id;
    });
    g.position.copy(bayToWorld(s.bay));
    return { group: g, ring, light, top, station: s };
  }

  function rebuild(): void {
    for (const item of built) item.dispose();
    built = [];
    for (const obj of objects.values()) scene.remove(obj.group);
    objects.clear();
    ground.clear();
    editGrid.clear();
    const palette = theme.dark ? SCENE_COLORS.dark : SCENE_COLORS.light;
    scene.background = new THREE.Color(theme.background);
    const w = lotW();
    const d = lotD();
    const asphalt = new THREE.Mesh(
      track(new THREE.BoxGeometry(w + 3, 0.1, d + 3)),
      M(palette.asphalt, { roughness: 0.95 }),
    );
    asphalt.position.y = -0.05;
    asphalt.receiveShadow = true;
    ground.add(asphalt);
    // Painted bay lines between every bay.
    const paint = M(palette.paint, { roughness: 0.8 });
    const lineGeometry = track(new THREE.BoxGeometry(0.1, 0.01, BAY_D - 1.4));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const line = new THREE.Mesh(lineGeometry, paint);
        line.position.set(-w / 2 + c * BAY_W, 0.006, -d / 2 + r * BAY_D + 0.7 + (BAY_D - 1.4) / 2);
        line.receiveShadow = true;
        ground.add(line);
      }
    }
    const gridMaterial = track(
      new THREE.LineBasicMaterial({ color: theme.primary, transparent: true, opacity: 0.55 }),
    );
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = -w / 2 + c * BAY_W + 0.08;
        const z0 = -d / 2 + r * BAY_D + 0.08;
        const x1 = x0 + BAY_W - 0.16;
        const z1 = z0 + BAY_D - 0.16;
        const geometry = track(
          new THREE.BufferGeometry().setFromPoints(
            [
              [x0, z0],
              [x1, z0],
              [x1, z1],
              [x0, z1],
              [x0, z0],
            ].map(([x, z]) => new THREE.Vector3(x, 0.02, z)),
          ),
        );
        editGrid.add(new THREE.Line(geometry, gridMaterial));
      }
    }
    editGrid.visible = editing;
    const extent = Math.max(w, d) / 2 + 4;
    Object.assign(sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      near: 1,
      far: 120,
    });
    sun.shadow.camera.updateProjectionMatrix();
    for (const s of stations) {
      const obj = buildModel(s, palette);
      scene.add(obj.group);
      objects.set(s.id, obj);
    }
    applySelection();
  }

  function applySelection(): void {
    for (const [id, obj] of objects) {
      obj.ring.material.color.set(theme.primary);
      obj.ring.material.opacity = id === selected ? 0.9 : 0;
    }
  }

  function fit(): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const aspect = width / height;
    // The approved preview's framing; the zoom limit and far plane follow it, so a
    // long lot of a dense site fits too.
    const dist = Math.max((lotW() + 3) / aspect, lotD() + 3) * 1.25 + 5;
    controls.maxDistance = Math.max(70, dist * 2);
    camera.far = dist * 4 + 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0.5, 0.6);
    camera.position.set(dist * 0.22, dist * 0.62, dist * 0.86);
    controls.update();
  }

  function resize(): void {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function labelPoint(stationId: string): ScreenPoint | null {
    const obj = objects.get(stationId);
    if (obj == null) return null;
    const v = obj.group.position.clone();
    v.y = obj.top + 0.45;
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * container.clientHeight,
      depth: v.z,
      visible: v.z < 1,
    };
  }

  // Picking and dragging.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag: { id: string; pointerId: number } | null = null;
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
  function pickStation(e: PointerEvent): string | null {
    setRay(e);
    const groups = [...objects.values()].map((o) => o.group);
    const hit = ray
      .intersectObjects(groups, true)
      .find((h) => h.object.type === 'Mesh' && h.object.userData['ring'] !== true);
    const id: unknown = hit?.object.userData['stationId'];
    return typeof id === 'string' ? id : null;
  }
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
    if (!editing) return;
    const id = pickStation(e);
    if (id == null) return;
    drag = { id, pointerId: e.pointerId };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent): void {
    if (drag == null) {
      if (e.pointerType === 'mouse') {
        canvas.style.cursor = pickStation(e) != null ? (editing ? 'grab' : 'pointer') : 'default';
      }
      return;
    }
    setRay(e);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(floor, p) == null) return;
    const obj = objects.get(drag.id);
    if (obj == null) return;
    obj.group.position.x = Math.max(-lotW() / 2 + BAY_W / 2, Math.min(lotW() / 2 - BAY_W / 2, p.x));
    obj.group.position.z = Math.max(-lotD() / 2 + 0.9, Math.min(lotD() / 2 - BAY_D + 0.9, p.z));
    const blocked = callbacks.isBayTaken(worldToBay(obj.group.position), drag.id);
    obj.ring.material.color.set(blocked ? theme.destructive : theme.primary);
    obj.ring.material.opacity = 0.9;
  }
  function onPointerUp(e: PointerEvent): void {
    if (drag != null) {
      const { id } = drag;
      const obj = objects.get(id);
      drag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (obj != null) {
        const bay = worldToBay(obj.group.position);
        // Back to its bay until the new positions arrive.
        obj.group.position.copy(bayToWorld(obj.station.bay));
        applySelection();
        callbacks.onDrop(id, bay);
      }
      return;
    }
    if (downAt != null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    callbacks.onPick(pickStation(e));
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
  let frame = 0;
  let disposed = false;
  function loop(now: number): void {
    if (disposed) return;
    controls.update();
    if (!options.reducedMotion) {
      const t = (now - t0) / 1000;
      for (const obj of objects.values()) {
        if (obj.station.pulsing) obj.light.emissiveIntensity = 0.55 + 0.4 * Math.sin(t * 3);
      }
    }
    renderer.render(scene, camera);
    callbacks.onFrame();
    frame = requestAnimationFrame(loop);
  }
  frame = requestAnimationFrame(loop);

  return {
    setStations(next, nextCols, nextRows) {
      const sizeChanged = nextCols !== cols || nextRows !== rows;
      stations = next;
      cols = nextCols;
      rows = nextRows;
      rebuild();
      if (sizeChanged) fit();
    },
    setTheme(next) {
      theme = next;
      rebuild();
    },
    setEditing(next) {
      editing = next;
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
    fit,
    labelPoint,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      for (const item of built) item.dispose();
      built = [];
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
