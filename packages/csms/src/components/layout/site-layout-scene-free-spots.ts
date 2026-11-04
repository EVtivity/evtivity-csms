// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Custom site spots, their rotation handle and the alignment guides of the 3D site scene.

import {
  FREE_LAYOUT,
  freeSpotRects,
  freeSpotTypeOf,
  freeSpotsExtent,
} from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { type AlignmentGuide } from './site-layout-grid';

import type { SceneSlice } from './site-layout-scene-context';
import { type Palette, type SceneStation } from './site-layout-scene-types';

type FreeSpotsCtx = SceneSlice<
  'M' | 'box' | 'guideGroup' | 'layout' | 'pipeBollard' | 'theme' | 'track',
  'addFreeSpots' | 'arrowGeometry' | 'freeHandle' | 'guideDash' | 'guideMaterial' | 'showGuides'
>;

export function installFreeSpots(scn: FreeSpotsCtx): void {
  // The spots of a station on a custom site, in its own frame (`freeSpotRects`):
  // a paved apron under the charger and its spots with a curb around it, and
  // the markings. Car spots and bus bays: a painted line on each side of each
  // spot. Truck pull-through lanes: no curb across the lane ends (trucks drive
  // through), a solid line along each lane edge, an entry and an exit arrow,
  // and a raised island under each dispenser with a bollard at each end.
  function addFreeSpots(g: THREE.Group, s: SceneStation, palette: Palette): void {
    // A depot paints every bay and lane on its yard, taken or not (buildDepotYard).
    if (scn.layout.lot.depot != null) return;
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
      scn.track(new THREE.BoxGeometry(w, 0.03, back - front)),
      scn.M(palette.asphalt, { roughness: 0.95, metalness: 0 }),
    );
    paving.position.set(cx, 0.015, (front + back) / 2);
    paving.receiveShadow = true;
    g.add(paving);
    const edge = scn.M(palette.curb, { roughness: 0.9 });
    const curbs: Array<readonly [number, number, number, number]> = [
      [cx, front, w + 0.1, 0.1],
      [cx, back, w + 0.1, 0.1],
    ];
    if (!truck) {
      curbs.push([left, (front + back) / 2, 0.1, back - front]);
      curbs.push([right, (front + back) / 2, 0.1, back - front]);
    }
    for (const [x, z, bw, bd] of curbs) {
      const strip = scn.box(bw, 0.07, bd, edge);
      strip.position.set(x, 0.035, z);
      g.add(strip);
    }
    const paint = scn.M(palette.paint, { roughness: 0.6 });
    if (!truck) {
      const lineLength = e.back - e.front - 0.3;
      const xs = new Set<number>();
      for (const r of rects) {
        xs.add(Math.round(r.minX * 100) / 100);
        xs.add(Math.round(r.maxX * 100) / 100);
      }
      for (const x of xs) {
        const line = new THREE.Mesh(
          scn.track(new THREE.BoxGeometry(0.1, 0.006, lineLength)),
          paint,
        );
        line.position.set(x, 0.034, e.front + 0.15 + lineLength / 2);
        g.add(line);
      }
      return;
    }
    const concrete = scn.M(palette.concrete, { roughness: 0.95 });
    const arrow = arrowGeometry();
    for (const r of rects) {
      for (const z of [r.minZ + 0.1, r.maxZ - 0.1]) {
        const line = new THREE.Mesh(
          scn.track(new THREE.BoxGeometry(r.maxX - r.minX - 0.4, 0.006, 0.12)),
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
      const island = scn.box(islandLength, 0.15, FREE_LAYOUT.truckIslandM - 0.3, concrete);
      island.position.set(r.chargerX - 1, 0.075, r.chargerZ);
      g.add(island);
      for (const bx of [
        r.chargerX - 1 - islandLength / 2 + 0.3,
        r.chargerX - 1 + islandLength / 2 - 0.3,
      ]) {
        g.add(scn.pipeBollard(bx, r.chargerZ, undefined, 0.15));
      }
    }
  }
  scn.addFreeSpots = addFreeSpots;

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
    laneArrow = scn.track(new THREE.ShapeGeometry(a));
    return laneArrow;
  }
  scn.arrowGeometry = arrowGeometry;

  // The rotation handle of a station on a custom site: a ring on the ground
  // in front of its spots with a stem from the spots' back edge, in the edit
  // color, shown on the selected station in Edit Layout.
  function freeHandle(stationId: string, handleZ: number, spotsBack: number): THREE.Group {
    const g = new THREE.Group();
    const material = scn.track(
      new THREE.MeshBasicMaterial({ color: scn.theme.primary, transparent: true, opacity: 0.95 }),
    );
    const ring = new THREE.Mesh(scn.track(new THREE.TorusGeometry(0.42, 0.07, 10, 36)), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.12, handleZ);
    const knob = new THREE.Mesh(scn.track(new THREE.SphereGeometry(0.2, 16, 12)), material);
    knob.position.set(0, 0.2, handleZ);
    const stemLength = handleZ - 0.42 - spotsBack;
    const stem = new THREE.Mesh(scn.track(new THREE.BoxGeometry(0.06, 0.03, stemLength)), material);
    stem.position.set(0, 0.08, handleZ - 0.42 - stemLength / 2);
    // A larger invisible disc makes the handle easy to grab on a touch screen.
    const grab = new THREE.Mesh(
      scn.track(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 20)),
      scn.track(new THREE.MeshBasicMaterial({ visible: false })),
    );
    grab.position.set(0, 0.15, handleZ);
    g.add(ring, knob, stem, grab);
    g.traverse((o) => {
      o.userData['rotateHandle'] = stationId;
    });
    g.visible = false;
    return g;
  }
  scn.freeHandle = freeHandle;

  // Alignment guides: a dashed strip on the ground (dashes 0.6 m, gaps 0.4 m,
  // 15 cm wide, in the edit color) to each station the moved one lines up
  // with. The dashes share one geometry and material, kept for the scene's life.
  const guideDash = new THREE.BoxGeometry(1, 0.02, 1);
  scn.guideDash = guideDash;
  const guideMaterial = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  scn.guideMaterial = guideMaterial;
  function showGuides(guides: readonly AlignmentGuide[]): void {
    scn.guideGroup.clear();
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
        scn.guideGroup.add(dash);
      }
    }
  }
  scn.showGuides = showGuides;
}
