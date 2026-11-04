// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The text a charger screen shows in the 3D site scene, and which screen is
// under the pointer (the hover zoom).

import * as THREE from 'three';
import { SCREEN_MESSAGE } from './site-layout-grid';
import { screenReaderScreenCenter } from './site-layout-model-reader-screen';
import {
  canvasScreenTextMeasure,
  screenHoverKey,
  screenTextFont,
  screenTextPlan,
  type ScreenKind,
  type ScreenTextPlan,
} from './site-layout-screen-text';

import type { SceneSlice } from './site-layout-scene-context';
import { type SceneStation } from './site-layout-scene-types';

const BACKGROUND = '#0b1726';
const INK = '#e6f2ff';

/** A screen plane of one station, kept for hover picking. */
interface ScreenEntry {
  kind: ScreenKind;
  plane: THREE.Mesh;
  station: SceneStation;
  build: number;
}

// The screen planes of each scene, by station. A build of a station replaces
// its entries: every screen of one build is added in one synchronous run, so
// a counter that moves once per run tells a new build from the same one.
const screensByScene = new WeakMap<object, Map<string, ScreenEntry[]>>();
let buildRun = 0;
let runOpen = false;
function currentBuildRun(): number {
  if (!runOpen) {
    runOpen = true;
    buildRun++;
    queueMicrotask(() => {
      runOpen = false;
    });
  }
  return buildRun;
}

function registerScreen(scn: object, entry: Omit<ScreenEntry, 'build'>): void {
  let byStation = screensByScene.get(scn);
  if (byStation == null) {
    byStation = new Map();
    screensByScene.set(scn, byStation);
  }
  const build = currentBuildRun();
  const id = entry.station.id;
  const kept = (byStation.get(id) ?? []).filter((e) => e.build === build);
  byStation.set(id, [...kept, { ...entry, build }]);
}

/**
 * The hover key (`screenHoverKey`) of the charger screen of `stationId` the
 * ray meets first, or null when the ray meets another part of the station
 * first or no screen of it. Merged stations (large sites) keep their screen
 * planes out of the scene with their last world matrix, and their pick box
 * holds them, so a ray through a screen counts there.
 */
export function pickChargerScreen(
  scn: SceneSlice<'objects'>,
  ray: THREE.Raycaster,
  stationId: string,
): string | null {
  const obj = scn.objects.get(stationId);
  const entries = screensByScene.get(scn)?.get(stationId);
  if (obj == null || entries == null) return null;
  const live = entries.filter((e) => e.station === obj.station);
  if (live.length === 0) return null;
  const planeHit = ray.intersectObjects(
    live.map((e) => e.plane),
    false,
  )[0];
  if (planeHit == null) return null;
  const entry = live.find((e) => e.plane === planeHit.object);
  if (entry == null) return null;
  if (entry.plane.parent != null) {
    const nearest = ray
      .intersectObject(obj.group, true)
      .find((h) => h.object.type === 'Mesh' && h.object.userData['ring'] !== true);
    if (nearest?.object !== entry.plane) return null;
  }
  return screenHoverKey(entry.kind, stationId);
}

type ScreenTextCtx = SceneSlice<
  'objects' | 'options' | 'renderer' | 'screenScrolls' | 'site' | 'track',
  'addScreenMessage'
>;

export function installScreenText(scn: ScreenTextCtx): void {
  // A screen's text drawn on a canvas: wrapped at a readable fitted size when
  // it fits (`screenTextPlan`), else one line on a wide canvas that scrolls
  // across (`speed`, in texture widths per second). Light text on the dark
  // screen, unlit, so the screen reads as lit from far away.
  function screenMessageTexture(
    text: string,
    kind: ScreenKind,
  ): { texture: THREE.CanvasTexture; speed: number | null } {
    const { width, height } = SCREEN_MESSAGE[kind].canvas;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let scroll: { speed: number; repeat: number } | null = null;
    if (ctx == null) {
      canvas.width = width;
      canvas.height = height;
    } else {
      const plan: ScreenTextPlan = screenTextPlan(text, kind, canvasScreenTextMeasure(ctx), {
        reducedMotion: scn.options.reducedMotion,
      });
      if (plan.mode === 'static') {
        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, width, height);
        ctx.font = screenTextFont(plan.fit.fontPx);
        ctx.fillStyle = INK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const top = height / 2 - ((plan.fit.lines.length - 1) * plan.fit.lineHeightPx) / 2;
        plan.fit.lines.forEach((line, i) => {
          ctx.fillText(line, width / 2, top + i * plan.fit.lineHeightPx);
        });
      } else {
        // The canvas of a very long line is drawn smaller; the texture still
        // spans the screen height, so the text keeps its size on the screen.
        canvas.width = Math.max(1, Math.round(plan.canvasWidthPx * plan.scale));
        canvas.height = Math.max(1, Math.round(height * plan.scale));
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = screenTextFont(Math.max(1, Math.round(plan.fontPx * plan.scale)));
        ctx.fillStyle = INK;
        ctx.textBaseline = 'middle';
        ctx.fillText(plan.text, width * 0.05 * plan.scale, canvas.height / 2);
        scroll = { speed: plan.speed, repeat: width / plan.canvasWidthPx };
      }
    }
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = scn.renderer.capabilities.getMaxAnisotropy();
    if (scroll != null) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.x = scroll.repeat;
    }
    return { texture, speed: scroll?.speed ?? null };
  }

  function screenPlane(s: SceneStation, kind: ScreenKind): THREE.Mesh {
    const spec = SCREEN_MESSAGE[kind];
    const { texture, speed } = screenMessageTexture(s.message ?? '', kind);
    const plane = new THREE.Mesh(
      scn.track(new THREE.PlaneGeometry(spec.width, spec.height)),
      scn.track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })),
    );
    plane.userData['screenMessage'] = kind;
    if (speed != null) scn.screenScrolls.push({ texture, speed });
    registerScreen(scn, { kind, plane, station: s });
    return plane;
  }

  // A card reader with a screen shows the same text while it is online. The
  // readers are added to the station after its screen, so the group (and the
  // station group a split system's unit joins) watches for them.
  const watched = new WeakSet<THREE.Object3D>();
  function watchReaders(g: THREE.Object3D, s: SceneStation): void {
    if (watched.has(g)) return;
    watched.add(g);
    g.addEventListener('childadded', ({ child }) => {
      const id: unknown = child.userData['terminalId'];
      if (typeof id !== 'string') return;
      const terminal = s.terminals.find((t) => t.id === id);
      if (terminal?.hasDisplay !== true || terminal.online !== true) return;
      const c = screenReaderScreenCenter();
      const plane = screenPlane(s, 'reader');
      // Just behind the bezel face, in front of the lit glass.
      plane.position.set(c.x, c.y, c.z - 0.001);
      plane.scale.setScalar(1 / child.scale.x);
      child.add(plane);
    });
    g.addEventListener('added', () => {
      const parent = g.parent;
      if (parent != null && parent !== scn.site) watchReaders(parent, s);
    });
  }

  // The message on a lit charger screen: a plane just in front of the glass.
  function addScreenMessage(
    g: THREE.Group,
    s: SceneStation,
    kind: keyof typeof SCREEN_MESSAGE,
    position: [number, number, number],
  ): void {
    if (s.message == null || s.message === '' || !s.lit) return;
    const plane = screenPlane(s, kind);
    plane.position.set(...position);
    g.add(plane);
    watchReaders(g, s);
  }
  scn.addScreenMessage = addScreenMessage;
}
