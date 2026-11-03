// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Solar canopies of the 3D site scene.

import { freeFootprint, type FreePlacement } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import { SCENE_COLORS } from './site-layout-colors';
import { rowFrontZ } from './site-layout-grid';
import {
  SOLAR_CARPORT,
  carportFrame,
  clearColumnXs,
  freeColumnXs,
  rowCarport,
  type CanopyObstacle,
  type CarportFrame,
  type RowCarport,
} from './site-layout-solar';

import type { SceneCtx } from './site-layout-scene-context';
import { type Palette } from './site-layout-scene-types';

export function installSolar(scn: SceneCtx): void {
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
    const steel = scn.M(SCENE_COLORS.galvanizedSteel, { roughness: 0.55, metalness: 0.6 });
    const concrete = scn.M(palette.concrete, { roughness: 0.9 });
    const columnBottom = frame.pierTopY + c.basePlateThickM;
    const columnH = frame.columnTopY - columnBottom;
    const flangeT = 0.02;
    const webT = 0.012;
    for (const x of frame.columnXs) {
      const u = frame.columnU;
      const pier = scn.cylinder(c.pierDiameterM / 2, frame.pierTopY, 24, concrete);
      pier.position.set(x, frame.pierTopY / 2, u);
      const plate = scn.box(c.basePlateM, c.basePlateThickM, c.basePlateM, steel);
      plate.position.set(x, frame.pierTopY + c.basePlateThickM / 2, u);
      g.add(pier, plate);
      // W-shape column: the web across the stalls (the strong axis carries
      // the cantilever), the flanges at its back and front.
      for (const side of [-1, 1]) {
        const flange = scn.box(c.columnFlangeM, columnH, flangeT, steel);
        flange.position.set(
          x,
          columnBottom + columnH / 2,
          u + side * (c.columnDepthM / 2 - flangeT / 2),
        );
        g.add(flange);
      }
      const web = scn.box(webT, columnH, c.columnDepthM - 2 * flangeT, steel);
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
      const geometry = scn.track(
        new THREE.ExtrudeGeometry(shape, { depth: c.girderWidthM, bevelEnabled: false }),
      );
      // Shape x becomes u (z), the extrusion runs along x, centered on the column.
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(x + c.girderWidthM / 2, 0, 0);
      g.add(scn.shadowed(new THREE.Mesh(geometry, steel)));
    }
    const length = frame.maxX - frame.minX;
    for (const p of frame.purlins) {
      const purlin = scn.box(length, p.topY - p.bottomY, c.purlinWidthM, steel);
      purlin.position.set((frame.minX + frame.maxX) / 2, (p.topY + p.bottomY) / 2, p.u);
      g.add(purlin);
    }
    const panelTexture = solarTexture(palette).clone();
    scn.track(panelTexture);
    panelTexture.needsUpdate = true;
    // Texture only: portrait modules about a meter wide along the row.
    panelTexture.repeat.set(Math.max(1, Math.round(length)), frame.moduleRows);
    const slant = frame.depthM / Math.cos(frame.tiltRad);
    const roof = new THREE.Mesh(
      scn.track(new THREE.BoxGeometry(length, c.moduleThicknessM, slant)),
      scn.M('#ffffff', { map: panelTexture, roughness: 0.25, metalness: 0.55 }),
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
    return scn.layout.stations.flatMap((s) => {
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
  scn.buildFreeSolarCanopy = buildFreeSolarCanopy;

  // The middle of a row of spots across the rows (lot z).
  function rowCenterZ(row: number): number {
    return rowFrontZ(row, scn.layout.lot) + scn.layout.lot.spotD / 2;
  }
  scn.rowCenterZ = rowCenterZ;

  // The stall lines of `rows` no canopy column may stand on: the line of a
  // dual-port pedestal between its two spots, and the lines across the
  // accessible charging space and its access aisle.
  function blockedColumnLines(rows: readonly number[]): Set<number> {
    const lot = scn.layout.lot;
    const lines = new Set<number>();
    for (const s of scn.layout.stations) {
      if (s.free != null || !rows.includes(s.bay.row) || (s.stalls?.length ?? 0) < 2) continue;
      const line = scn.poseOf(s).point.x / lot.spotW;
      if (Math.abs(line - Math.round(line)) < 0.01) lines.add(Math.round(line));
    }
    const a = scn.layout.accessible;
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
    const first = rowCarport(row, scn.layout.lot);
    return rowCarport(row, scn.layout.lot, blockedColumnLines(first.rows));
  }
  scn.solarRowCarport = solarRowCarport;

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
  scn.buildSolarCanopy = buildSolarCanopy;

  scn.solarTextureCache = null;
  function solarTexture(palette: Palette): THREE.CanvasTexture {
    if (scn.solarTextureCache != null) return scn.solarTextureCache;
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
    const texture = scn.track(new THREE.CanvasTexture(canvas));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    scn.solarTextureCache = texture;
    return texture;
  }
}
