// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The raised ground surfaces of a site and a station (curbs, islands,
// sidewalks, slabs, aprons, pads) and the ground height a cable rests on.

import { describe, expect, it } from 'vitest';
import { FREE_LAYOUT, freeSpotRects, freeSpotsExtent } from '@evtivity/lib/site-layout';
import { SURFACE_M } from '../site-layout-cable-surface';
import { CURB_M, FACADE_Z, SIDEWALK_M, parkingRowGaps, type Lot } from '../site-layout-grid';
import {
  APRON,
  CHARGER_PAD,
  DEPOT_SLAB_TOP_M,
  ISLAND_TOP_M,
  chargerPadRects,
  freeStationRaisedRects,
  lotRaisedRects,
  stationGround,
  stationToLot,
} from '../site-layout-ground';

function lotOf(over: Partial<Lot> = {}): Lot {
  return {
    siteType: 'parking_lot',
    rowLengths: [4, 4],
    cols: 4,
    rows: 2,
    spotW: 2.6,
    spotD: 5.5,
    lane: 7,
    pitch: 12.5,
    width: 10.4,
    depth: 18,
    facing: 0,
    mounting: 'wall',
    depot: null,
    ...over,
  };
}

describe('lotRaisedRects', () => {
  it('curbs a parking lot all round and raises its islands', () => {
    const lot = lotOf();
    const rects = lotRaisedRects(lot);
    const curbs = rects.filter((r) => r.top === SURFACE_M.curb);
    expect(curbs).toHaveLength(4);
    expect(curbs[0]).toEqual({
      minX: -CURB_M,
      maxX: lot.width + CURB_M,
      minZ: -CURB_M,
      maxZ: 0,
      top: SURFACE_M.curb,
    });
    expect(curbs[3]).toEqual({
      minX: lot.width,
      maxX: lot.width + CURB_M,
      minZ: 0,
      maxZ: lot.depth,
      top: SURFACE_M.curb,
    });
    const islands = parkingRowGaps(lot).filter((g) => g.kind === 'island');
    expect(rects.filter((r) => r.top === ISLAND_TOP_M)).toEqual(
      islands.map((g) => ({
        minX: 0,
        maxX: lot.width,
        minZ: g.minZ,
        maxZ: g.maxZ,
        top: ISLAND_TOP_M,
      })),
    );
  });

  it('adds the sidewalk from the facade to the front curb of an office or retail row', () => {
    const rects = lotRaisedRects(lotOf({ siteType: 'office_retail', rows: 1, rowLengths: [4] }));
    expect(rects).toHaveLength(5);
    const walk = rects[4];
    expect(walk?.top).toBe(SURFACE_M.sidewalk);
    expect(walk?.minZ).toBe(FACADE_Z);
    expect(walk?.maxZ).toBe(-CURB_M);
  });

  it('curbs both sides of a street with a sidewalk behind each curb', () => {
    const lot = lotOf({ siteType: 'curbside', depth: 9 });
    const rects = lotRaisedRects(lot);
    expect(rects.map((r) => [r.minZ, r.maxZ, r.top])).toEqual([
      [-CURB_M, 0, SURFACE_M.curb],
      [-CURB_M - SIDEWALK_M, -CURB_M, SURFACE_M.sidewalk],
      [9, 9 + CURB_M, SURFACE_M.curb],
      [9 + CURB_M, 9 + CURB_M + SIDEWALK_M, SURFACE_M.sidewalk],
    ]);
  });

  it('raises the depot islands inset from their edges, the bus head strip and its curb, and the median', () => {
    const depot = {
      islands: [{ minX: 0, maxX: 10, minZ: 0, maxZ: 2 }],
      busHead: { minX: 0, maxX: 20, minZ: 5, maxZ: 6 },
      median: { minX: -5, maxX: 25, minZ: 10, maxZ: 11 },
    };
    const rects = lotRaisedRects(lotOf({ siteType: 'depot', depot } as unknown as Partial<Lot>));
    expect(rects).toEqual([
      { minX: 1, maxX: 9, minZ: 0.15, maxZ: 1.85, top: DEPOT_SLAB_TOP_M },
      { minX: 0, maxX: 20, minZ: 5, maxZ: 6, top: 0.04 },
      { minX: 0, maxX: 20, minZ: 5.8, maxZ: 6, top: SURFACE_M.curb },
      { minX: -5, maxX: 25, minZ: 10, maxZ: 11, top: DEPOT_SLAB_TOP_M },
    ]);
  });

  it('raises nothing on a depot without a yard, a depot without head or median, or a custom site', () => {
    expect(lotRaisedRects(lotOf({ siteType: 'depot', depot: null }))).toEqual([]);
    const depot = { islands: [], busHead: null, median: null };
    expect(lotRaisedRects(lotOf({ siteType: 'depot', depot } as unknown as Partial<Lot>))).toEqual(
      [],
    );
    expect(lotRaisedRects(lotOf({ siteType: 'custom' }))).toEqual([]);
  });
});

describe('freeStationRaisedRects', () => {
  it('paves a car station apron from 0.9 m behind the charger, edged on four sides', () => {
    const e = freeSpotsExtent(2, 'car');
    const rects = freeStationRaisedRects(2, 'car');
    expect(rects).toHaveLength(5);
    const [paving, front, back, left, right] = rects;
    const l = e.minX - FREE_LAYOUT.apronM;
    const r = e.maxX + FREE_LAYOUT.apronM;
    const f = Math.min(e.front, -0.9) - FREE_LAYOUT.apronM;
    const b = e.back + FREE_LAYOUT.apronM;
    expect(paving).toEqual({ minX: l, maxX: r, minZ: f, maxZ: b, top: APRON.pavingTopM });
    const hw = APRON.edgeWidthM / 2;
    expect(front).toEqual({
      minX: l - hw,
      maxX: r + hw,
      minZ: f - hw,
      maxZ: f + hw,
      top: APRON.edgeTopM,
    });
    expect(back?.minZ).toBeCloseTo(b - hw);
    expect(left).toEqual({ minX: l - hw, maxX: l + hw, minZ: f, maxZ: b, top: APRON.edgeTopM });
    expect(right?.maxX).toBeCloseTo(r + hw);
  });

  it('gives a truck pull-through station a 7 m island per spot instead of side edges', () => {
    const rects = freeStationRaisedRects(2, 'truck_pull_through');
    const spots = freeSpotRects(2, 'truck_pull_through');
    expect(rects).toHaveLength(3 + spots.length);
    const islands = rects.slice(3);
    islands.forEach((isl, i) => {
      const s = spots[i];
      if (s == null) throw new Error('spot');
      expect(isl.maxX - isl.minX).toBeCloseTo(7);
      expect((isl.minX + isl.maxX) / 2).toBeCloseTo(s.chargerX - 1);
      expect((isl.minZ + isl.maxZ) / 2).toBeCloseTo(s.chargerZ);
      expect(isl.maxZ - isl.minZ).toBeCloseTo(FREE_LAYOUT.truckIslandM - 0.3);
      expect(isl.top).toBe(DEPOT_SLAB_TOP_M);
    });
  });
});

describe('chargerPadRects', () => {
  it('puts a pad under a DC dispenser and an AC pedestal, none under a wall box', () => {
    expect(chargerPadRects('dc')).toEqual([
      { minX: -0.8, maxX: 0.8, minZ: -0.6, maxZ: 0.6, top: CHARGER_PAD.topM },
    ]);
    expect(chargerPadRects('ac')).toEqual([
      { minX: -0.5, maxX: 0.5, minZ: -0.45, maxZ: 0.45, top: CHARGER_PAD.topM },
    ]);
    expect(chargerPadRects('wall')).toEqual([]);
  });
});

describe('stationToLot and stationGround', () => {
  it('moves a station point by its pose, turned about y', () => {
    const [x, z] = stationToLot({ x: 10, z: 5, turn: Math.PI / 2 }, 1, 0);
    expect(x).toBeCloseTo(10);
    expect(z).toBeCloseTo(4);
    const [x2, z2] = stationToLot({ x: 10, z: 5, turn: Math.PI / 2 }, 0, 2);
    expect(x2).toBeCloseTo(12);
    expect(z2).toBeCloseTo(5);
  });

  it('reads the highest surface under a point: the station pad, the site curb, else the paving', () => {
    const lot = lotOf();
    const ground = stationGround(lot, { x: 5, z: 1, turn: 0 }, chargerPadRects('dc'));
    // On the pad.
    expect(ground(0, 0)).toBe(CHARGER_PAD.topM);
    // Over the front curb of the lot (lot z between -0.3 and 0).
    expect(ground(0, -1.15)).toBe(SURFACE_M.curb);
    // On the paving.
    expect(ground(3, 3)).toBe(SURFACE_M.paving);
  });

  it('uses the site surfaces it is given', () => {
    const ground = stationGround(
      lotOf(),
      { x: 0, z: 0, turn: 0 },
      [],
      [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1, top: 0.5 }],
    );
    expect(ground(0, 0)).toBe(0.5);
    expect(ground(2, 2)).toBe(SURFACE_M.paving);
  });
});
