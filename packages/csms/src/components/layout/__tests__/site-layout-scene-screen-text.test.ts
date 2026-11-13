// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charger screen text of the 3D site scene: the plane and its canvas
// texture (wrapped or scrolling), the card reader screens, and which screen a
// ray meets first (the hover zoom). A recording 2D context stands in for the
// canvas the test DOM lacks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SCREEN_MESSAGE } from '../site-layout-grid';
import { installScreenText, pickChargerScreen } from '../site-layout-scene-screen-text';
import { screenHoverKey } from '../site-layout-screen-text';
import type { SceneStation } from '../site-layout-scene-types';

type Ctx = Parameters<typeof installScreenText>[0];

interface FakeCtx {
  font: string;
  fillStyle: string;
  textAlign: string;
  textBaseline: string;
  texts: { text: string; x: number; y: number; font: string }[];
  rects: number[][];
  measureText: (text: string) => { width: number };
  fillRect: (...a: number[]) => void;
  fillText: (text: string, x: number, y: number) => void;
}

function fakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    texts: [],
    rects: [],
    // Every character is half the font size wide.
    measureText(text: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
      return { width: Array.from(text).length * px * 0.5 };
    },
    fillRect(...a: number[]) {
      this.rects.push(a);
    },
    fillText(text: string, x: number, y: number) {
      this.texts.push({ text, x, y, font: this.font });
    },
  };
  return ctx;
}

let contexts: FakeCtx[] = [];
let withContext = true;

beforeEach(() => {
  contexts = [];
  withContext = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (!withContext) return null;
    const c = fakeCtx();
    contexts.push(c);
    return c as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sceneStation(over: Record<string, unknown> = {}): SceneStation {
  return {
    id: 'sta_a',
    message: 'Welcome',
    lit: true,
    terminals: [],
    ...over,
  } as unknown as SceneStation;
}

function ctx(reducedMotion = false) {
  const tracked: unknown[] = [];
  const scn = {
    objects: new Map(),
    options: { reducedMotion },
    renderer: { capabilities: { getMaxAnisotropy: () => 8 } },
    screenScrolls: [] as { texture: THREE.Texture; speed: number }[],
    site: new THREE.Group(),
    track: <T>(item: T): T => {
      tracked.push(item);
      return item;
    },
  } as unknown as Ctx;
  installScreenText(scn);
  return { scn, tracked };
}

function screenOf(g: THREE.Object3D): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const plane = g.children.find((c) => c.userData['screenMessage'] != null);
  if (plane == null) throw new Error('no screen plane');
  return plane as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}

/** Lets a new build run start (the run counter moves after a microtask). */
const nextRun = (): Promise<void> => Promise.resolve();

describe('addScreenMessage', () => {
  it('draws a short message centered on a screen-sized canvas at the position given', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    scn.addScreenMessage(g, sceneStation({ message: 'Hello' }), 'dc', [0, 1.2, 0.3]);
    const plane = screenOf(g);
    expect(plane.userData['screenMessage']).toBe('dc');
    expect(plane.position.toArray()).toEqual([0, 1.2, 0.3]);
    const geo = plane.geometry.parameters;
    expect(geo.width).toBe(SCREEN_MESSAGE.dc.width);
    expect(geo.height).toBe(SCREEN_MESSAGE.dc.height);
    const texture = plane.material.map as THREE.CanvasTexture;
    const canvas = texture.image;
    expect(canvas.width).toBe(SCREEN_MESSAGE.dc.canvas.width);
    expect(canvas.height).toBe(SCREEN_MESSAGE.dc.canvas.height);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.anisotropy).toBe(8);
    expect(texture.wrapS).not.toBe(THREE.RepeatWrapping);
    expect(plane.material.toneMapped).toBe(false);
    const drawn = contexts[0];
    expect(drawn?.texts.map((t) => t.text)).toEqual(['Hello']);
    expect(drawn?.texts[0]?.x).toBe(SCREEN_MESSAGE.dc.canvas.width / 2);
    expect(drawn?.texts[0]?.y).toBe(SCREEN_MESSAGE.dc.canvas.height / 2);
    expect(drawn?.rects[0]).toEqual([0, 0, 512, 390]);
    expect(scn.screenScrolls).toHaveLength(0);
  });

  it('stacks wrapped lines around the middle of the screen', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    scn.addScreenMessage(g, sceneStation({ message: 'Line one\nLine two' }), 'dc', [0, 0, 0]);
    const texts = contexts[0]?.texts ?? [];
    expect(texts.map((t) => t.text)).toEqual(['Line one', 'Line two']);
    const [a, b] = texts;
    expect(((a?.y ?? 0) + (b?.y ?? 0)) / 2).toBeCloseTo(SCREEN_MESSAGE.dc.canvas.height / 2);
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBeGreaterThan(0);
  });

  it('scrolls a message too long for the screen on one repeating line', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    const message =
      'Charging rates change at midnight; please move your vehicle when done. '.repeat(3);
    scn.addScreenMessage(g, sceneStation({ message }), 'wallbox', [0, 0, 0]);
    expect(scn.screenScrolls).toHaveLength(1);
    const scroll = scn.screenScrolls[0];
    expect(scroll?.speed).toBeGreaterThan(0);
    const texture = screenOf(g).material.map as THREE.CanvasTexture;
    expect(texture).toBe(scroll?.texture);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.repeat.x).toBeGreaterThan(0);
    expect(texture.repeat.x).toBeLessThan(1);
    const canvas = texture.image;
    expect(canvas.width).toBeGreaterThan(SCREEN_MESSAGE.wallbox.canvas.width);
    // One line, left-aligned 5 percent in.
    expect(contexts[0]?.texts).toHaveLength(1);
    expect(contexts[0]?.texts[0]?.y).toBe(canvas.height / 2);
  });

  it('keeps a long message still with reduced motion', () => {
    const { scn } = ctx(true);
    const g = new THREE.Group();
    scn.addScreenMessage(g, sceneStation({ message: 'x '.repeat(200) }), 'wallbox', [0, 0, 0]);
    expect(scn.screenScrolls).toHaveLength(0);
    const canvas = (screenOf(g).material.map as THREE.CanvasTexture).image;
    expect(canvas.width).toBe(SCREEN_MESSAGE.wallbox.canvas.width);
  });

  it('keeps a blank screen-sized canvas without a 2D context', () => {
    withContext = false;
    const { scn } = ctx();
    const g = new THREE.Group();
    scn.addScreenMessage(g, sceneStation(), 'ac', [0, 0, 0]);
    const canvas = (screenOf(g).material.map as THREE.CanvasTexture).image;
    expect(canvas.width).toBe(SCREEN_MESSAGE.ac.canvas.width);
    expect(canvas.height).toBe(SCREEN_MESSAGE.ac.canvas.height);
  });

  it('adds nothing for a dark screen or an empty message', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    scn.addScreenMessage(g, sceneStation({ lit: false }), 'dc', [0, 0, 0]);
    scn.addScreenMessage(g, sceneStation({ message: '' }), 'dc', [0, 0, 0]);
    scn.addScreenMessage(g, sceneStation({ message: null }), 'dc', [0, 0, 0]);
    expect(g.children).toHaveLength(0);
  });
});

describe('card reader screens', () => {
  function reader(terminalId: unknown, scale = 1.5): THREE.Group {
    const r = new THREE.Group();
    r.userData['terminalId'] = terminalId;
    r.scale.setScalar(scale);
    return r;
  }

  it('shows the message on an online reader with a display, scaled back to meters', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    const s = sceneStation({
      terminals: [{ id: 'trm_1', hasDisplay: true, online: true }],
    });
    scn.addScreenMessage(g, s, 'dc', [0, 0, 0]);
    const r = reader('trm_1');
    g.add(r);
    const plane = screenOf(r);
    expect(plane.userData['screenMessage']).toBe('reader');
    expect(plane.scale.x).toBeCloseTo(1 / 1.5);
  });

  it('adds no screen to an offline reader, a reader without a display or another child', () => {
    const { scn } = ctx();
    const g = new THREE.Group();
    const s = sceneStation({
      terminals: [
        { id: 'trm_off', hasDisplay: true, online: false },
        { id: 'trm_blind', hasDisplay: false, online: true },
      ],
    });
    scn.addScreenMessage(g, s, 'dc', [0, 0, 0]);
    const off = reader('trm_off');
    const blind = reader('trm_blind');
    const unknown = reader('trm_none');
    const other = reader(42);
    g.add(off, blind, unknown, other);
    for (const r of [off, blind, unknown, other]) expect(r.children).toHaveLength(0);
  });

  it('watches the station group a unit joins, but not the site itself', () => {
    const { scn } = ctx();
    const unit = new THREE.Group();
    const s = sceneStation({
      terminals: [{ id: 'trm_1', hasDisplay: true, online: true }],
    });
    scn.addScreenMessage(unit, s, 'ac', [0, 0, 0]);
    const stationGroup = new THREE.Group();
    stationGroup.add(unit);
    const r = reader('trm_1');
    stationGroup.add(r);
    expect(r.children).toHaveLength(1);
    // A unit added straight to the site does not watch the site.
    const unit2 = new THREE.Group();
    scn.addScreenMessage(unit2, s, 'ac', [0, 0, 0]);
    scn.site.add(unit2);
    const r2 = reader('trm_1');
    scn.site.add(r2);
    expect(r2.children).toHaveLength(0);
  });
});

describe('pickChargerScreen', () => {
  /** A top-down ray straight down at (x, z). */
  function rayAt(x: number, z: number): THREE.Raycaster {
    return new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
  }

  function built() {
    const { scn } = ctx();
    const s = sceneStation();
    const group = new THREE.Group();
    // The screen faces up at 1 m (a plane faces +z; turned to face the ray).
    scn.addScreenMessage(group, s, 'dc', [0, 1, 0]);
    const plane = screenOf(group);
    plane.rotation.x = -Math.PI / 2;
    group.updateMatrixWorld(true);
    (scn.objects as Map<string, unknown>).set(s.id, { group, station: s });
    return { scn, s, group, plane };
  }

  it('names the screen the ray meets first', () => {
    const { scn } = built();
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBe(screenHoverKey('dc', 'sta_a'));
  });

  it('names nothing when the ray misses the screen', () => {
    const { scn } = built();
    expect(pickChargerScreen(scn, rayAt(5, 5), 'sta_a')).toBeNull();
  });

  it('names nothing when another part of the station is in front of the screen', () => {
    const { scn, group } = built();
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshBasicMaterial());
    hood.position.y = 2;
    group.add(hood);
    group.updateMatrixWorld(true);
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBeNull();
  });

  it('ignores the selection ring in front of the screen', () => {
    const { scn, group } = built();
    const ring = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshBasicMaterial());
    ring.userData['ring'] = true;
    ring.position.y = 2;
    group.add(ring);
    group.updateMatrixWorld(true);
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBe(screenHoverKey('dc', 'sta_a'));
  });

  it('names the screen of a merged station whose plane left the scene', () => {
    const { scn, group, plane } = built();
    group.remove(plane);
    // The plane keeps its last world matrix.
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBe(screenHoverKey('dc', 'sta_a'));
  });

  it('names nothing for an unknown station or a station rebuilt since', () => {
    const { scn } = built();
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_missing')).toBeNull();
    const obj = (scn.objects as Map<string, { station: SceneStation }>).get('sta_a');
    if (obj != null) obj.station = sceneStation();
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBeNull();
  });

  it('keeps the screens of one build together and replaces them on the next build', async () => {
    const { scn } = ctx();
    const s = sceneStation();
    const group = new THREE.Group();
    await nextRun();
    scn.addScreenMessage(group, s, 'dc', [0, 1, 0]);
    scn.addScreenMessage(group, s, 'ac', [3, 1, 0]);
    for (const p of group.children) p.rotation.x = -Math.PI / 2;
    group.updateMatrixWorld(true);
    (scn.objects as Map<string, unknown>).set(s.id, { group, station: s });
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBe(screenHoverKey('dc', 'sta_a'));
    expect(pickChargerScreen(scn, rayAt(3, 0), 'sta_a')).toBe(screenHoverKey('ac', 'sta_a'));
    // A later build of the station keeps only its own screens.
    await nextRun();
    const group2 = new THREE.Group();
    scn.addScreenMessage(group2, s, 'wallbox', [6, 1, 0]);
    for (const p of group2.children) p.rotation.x = -Math.PI / 2;
    group2.updateMatrixWorld(true);
    (scn.objects as Map<string, unknown>).set(s.id, { group: group2, station: s });
    expect(pickChargerScreen(scn, rayAt(0, 0), 'sta_a')).toBeNull();
    expect(pickChargerScreen(scn, rayAt(6, 0), 'sta_a')).toBe(screenHoverKey('wallbox', 'sta_a'));
  });
});
