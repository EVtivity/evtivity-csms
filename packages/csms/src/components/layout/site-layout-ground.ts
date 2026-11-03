// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The raised ground surfaces of a site (owner rule 2026-11-02: a cable shows
// above the concrete it hangs over, never sunk into it): the lot curbs and
// islands, the office sidewalk, the street curbs and sidewalks, the depot
// islands, head strip and median, a custom station's apron and truck island,
// and the charger pads. One list of raised rectangles per site in lot meters,
// moved into a station's own frame, read by `SurfaceAt`. The heights are the
// boxes the scene builds (site-layout-scene.ts uses the same functions or
// the same numbers). Pure: no three.js.

import {
  FREE_LAYOUT,
  freeSpotRects,
  freeSpotsExtent,
  type FreeSpotType,
} from '@evtivity/lib/site-layout';
import { CURB_M, FACADE_Z, SIDEWALK_M, parkingRowGaps, type Lot } from './site-layout-grid';
import { SURFACE_M, type GroundRect, type SurfaceAt } from './site-layout-cable-surface';

/** A raised rectangle: its plan and the height of its top. */
export interface RaisedRect extends GroundRect {
  top: number;
}

/** A parking lot island: a 0.15 m concrete top in 0.16 m curbs (`ISLAND_H`, buildParkingRows). */
export const ISLAND_TOP_M = 0.16;
/** A depot dispenser island and the median: 0.15 m slabs (buildDepotYard). */
export const DEPOT_SLAB_TOP_M = 0.15;
/** A custom station's apron: 0.03 m paving in 0.07 m edge strips 0.1 m wide (addFreeSpots). */
export const APRON = { pavingTopM: 0.03, edgeTopM: 0.07, edgeWidthM: 0.1 } as const;
/** A charger's concrete pad: 0.08 m high, 1.6 by 1.2 m under a DC dispenser, 1.0 by 0.9 m under an AC pedestal. */
export const CHARGER_PAD = { topM: 0.08, dc: { w: 1.6, d: 1.2 }, ac: { w: 1.0, d: 0.9 } } as const;

const FAR = 1000;

function rect(minX: number, maxX: number, minZ: number, maxZ: number, top: number): RaisedRect {
  return { minX, maxX, minZ, maxZ, top };
}

/** The raised surfaces of a site's ground, in lot meters. */
export function lotRaisedRects(lot: Lot): RaisedRect[] {
  const out: RaisedRect[] = [];
  const c = CURB_M;
  const curbAround = (): void => {
    out.push(
      rect(-c, lot.width + c, -c, 0, SURFACE_M.curb),
      rect(-c, lot.width + c, lot.depth, lot.depth + c, SURFACE_M.curb),
      rect(-c, 0, 0, lot.depth, SURFACE_M.curb),
      rect(lot.width, lot.width + c, 0, lot.depth, SURFACE_M.curb),
    );
  };
  switch (lot.siteType) {
    case 'parking_lot':
      curbAround();
      for (const gap of parkingRowGaps(lot)) {
        if (gap.kind === 'island') out.push(rect(0, lot.width, gap.minZ, gap.maxZ, ISLAND_TOP_M));
      }
      break;
    case 'office_retail':
      curbAround();
      // The sidewalk from the facade to the front curb (buildBuilding).
      out.push(rect(-FAR, FAR, FACADE_Z, -c, SURFACE_M.sidewalk));
      break;
    case 'curbside':
      // A curb and a sidewalk along each side of the street (buildStreet).
      out.push(
        rect(-FAR, FAR, -c, 0, SURFACE_M.curb),
        rect(-FAR, FAR, -c - SIDEWALK_M, -c, SURFACE_M.sidewalk),
        rect(-FAR, FAR, lot.depth, lot.depth + c, SURFACE_M.curb),
        rect(-FAR, FAR, lot.depth + c, lot.depth + c + SIDEWALK_M, SURFACE_M.sidewalk),
      );
      break;
    case 'depot': {
      const d = lot.depot;
      if (d == null) break;
      for (const i of d.islands) {
        out.push(rect(i.minX + 1, i.maxX - 1, i.minZ + 0.15, i.maxZ - 0.15, DEPOT_SLAB_TOP_M));
      }
      if (d.busHead != null) {
        const h = d.busHead;
        out.push(rect(h.minX, h.maxX, h.minZ, h.maxZ, 0.04));
        out.push(rect(h.minX, h.maxX, h.maxZ - 0.2, h.maxZ, SURFACE_M.curb));
      }
      if (d.median != null) {
        const m = d.median;
        out.push(rect(m.minX, m.maxX, m.minZ, m.maxZ, DEPOT_SLAB_TOP_M));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * The apron of a custom site station and its spots, in its own frame
 * (addFreeSpots): the paving, the edge strips (front and back, and the sides
 * of car spots), and a truck dispenser's 7 m island.
 */
export function freeStationRaisedRects(spots: number, spotType: FreeSpotType): RaisedRect[] {
  const e = freeSpotsExtent(spots, spotType);
  const truck = spotType === 'truck_pull_through';
  const behind = truck ? 0 : 0.9;
  const left = e.minX - FREE_LAYOUT.apronM;
  const right = e.maxX + FREE_LAYOUT.apronM;
  const front = Math.min(e.front, -behind) - FREE_LAYOUT.apronM;
  const back = e.back + FREE_LAYOUT.apronM;
  const hw = APRON.edgeWidthM / 2;
  const out = [
    rect(left, right, front, back, APRON.pavingTopM),
    rect(left - hw, right + hw, front - hw, front + hw, APRON.edgeTopM),
    rect(left - hw, right + hw, back - hw, back + hw, APRON.edgeTopM),
  ];
  if (!truck) {
    out.push(rect(left - hw, left + hw, front, back, APRON.edgeTopM));
    out.push(rect(right - hw, right + hw, front, back, APRON.edgeTopM));
  } else {
    for (const r of freeSpotRects(spots, spotType)) {
      const cx = r.chargerX - 1;
      const hd = (FREE_LAYOUT.truckIslandM - 0.3) / 2;
      out.push(rect(cx - 3.5, cx + 3.5, r.chargerZ - hd, r.chargerZ + hd, DEPOT_SLAB_TOP_M));
    }
  }
  return out;
}

/** The concrete pad under a standard charger, in its own frame (none under a wall box). */
export function chargerPadRects(kind: 'dc' | 'ac' | 'wall'): RaisedRect[] {
  if (kind === 'wall') return [];
  const p = kind === 'dc' ? CHARGER_PAD.dc : CHARGER_PAD.ac;
  return [rect(-p.w / 2, p.w / 2, -p.d / 2, p.d / 2, CHARGER_PAD.topM)];
}

/** A station's pose on its site: its point in lot meters and its turn about y (three.js). */
export interface StationPose {
  x: number;
  z: number;
  turn: number;
}

/** A point of a station's own frame in lot meters (the station group's position and turn). */
export function stationToLot(pose: StationPose, x: number, z: number): readonly [number, number] {
  const c = Math.cos(pose.turn);
  const s = Math.sin(pose.turn);
  return [pose.x + x * c + z * s, pose.z - x * s + z * c];
}

/**
 * The ground under a station, in its own frame: the paved lot plane (or grass
 * off it, 0), the site's raised surfaces and the station's own (its pad, its
 * apron). Cables rest on it (`restHeight`).
 */
export function stationGround(
  lot: Lot,
  pose: StationPose,
  local: readonly RaisedRect[],
  siteRects: readonly RaisedRect[] = lotRaisedRects(lot),
): SurfaceAt {
  return (x, z) => {
    let top: number = SURFACE_M.paving;
    for (const r of local) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) top = Math.max(top, r.top);
    }
    const [lx, lz] = stationToLot(pose, x, z);
    for (const r of siteRects) {
      if (lx >= r.minX && lx <= r.maxX && lz >= r.minZ && lz <= r.maxZ) top = Math.max(top, r.top);
    }
    return top;
  };
}
