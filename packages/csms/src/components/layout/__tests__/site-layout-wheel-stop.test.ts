// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  CHARGER_BEHIND_STALL_HEAD_M,
  DEFAULT_LAYOUT_GRID,
  STANDARD_DIMENSIONS,
  WHEEL_STOP,
  freeSpotRects,
} from '@evtivity/lib/site-layout';
import {
  AC_PAD_FRONT_Z,
  BAY_STATION_Z,
  bayToWorld,
  bayTurn,
  carNoseAtStop,
  chargerAtCurb,
  chargerBehindStallHead,
  chargerOnIsland,
  isSpot,
  lotOf,
  parkingRowGaps,
  spotRect,
  stallHeadZ,
  stationBackShift,
  type WheelStopMount,
  tireTouchAhead,
  wheelStopCenterZ,
  wheelStopMount,
  wheelStopNearZ,
} from '../site-layout-grid';
import { CAR_PROFILES, type CarBodyType } from '../site-layout-car';

const base = { kind: 'ac' as const, wall: false, onSpot: true, largeSpot: false };

describe('wheel stops at AC spots', () => {
  it('puts a stop at AC pedestals and wall boxes of lot and office spots and AC car spots of a custom site', () => {
    expect(wheelStopMount({ ...base, siteType: 'parking_lot' })).toBe('curb');
    expect(wheelStopMount({ ...base, siteType: 'office_retail' })).toBe('curb');
    expect(wheelStopMount({ ...base, siteType: 'office_retail', wall: true })).toBe('wall');
    expect(wheelStopMount({ ...base, siteType: 'custom', onSpot: false })).toBe('curb');
  });

  it('puts none at DC chargers, curbs, depots, large spots or off the layout', () => {
    expect(wheelStopMount({ ...base, siteType: 'parking_lot', kind: 'dc' })).toBeNull();
    expect(wheelStopMount({ ...base, siteType: 'curbside' })).toBeNull();
    expect(wheelStopMount({ ...base, siteType: 'depot' })).toBeNull();
    expect(wheelStopMount({ ...base, siteType: 'custom', largeSpot: true })).toBeNull();
    expect(wheelStopMount({ ...base, siteType: 'parking_lot', onSpot: false })).toBeNull();
  });

  it('sets the stop from the stall head line, inside the full stall depth', () => {
    expect(WHEEL_STOP.fromStallHeadM).toBeCloseTo(0.61);
    // A pedestal behind its curb and a wall box: 2 ft from the stall head line.
    expect(stallHeadZ('curb')).toBeCloseTo(CHARGER_BEHIND_STALL_HEAD_M);
    expect(wheelStopNearZ('curb') - stallHeadZ('curb')).toBeCloseTo(0.61);
    expect(stallHeadZ('wall')).toBeCloseTo(-BAY_STATION_Z);
    expect(wheelStopNearZ('wall') - stallHeadZ('wall')).toBeCloseTo(0.61);
    expect(wheelStopCenterZ('curb') - wheelStopNearZ('curb')).toBeCloseTo(WHEEL_STOP.depthM / 2);
    // The stop lies inside the spot, across it; the stall keeps its full 5.5 m depth.
    expect(STANDARD_DIMENSIONS.spotDepthM).toBeCloseTo(5.5);
    expect(WHEEL_STOP.lengthM).toBeLessThan(STANDARD_DIMENSIONS.spotWidthM);
    for (const mount of ['curb', 'wall'] as const) {
      expect(wheelStopNearZ(mount)).toBeGreaterThan(stallHeadZ(mount));
      expect(wheelStopNearZ(mount) + WHEEL_STOP.depthM).toBeLessThan(
        stallHeadZ(mount) + STANDARD_DIMENSIONS.spotDepthM,
      );
    }
  });

  it('never puts a stop on a charger base, pad or bollard', () => {
    // The AC pedestal pad (1.0 by 0.9 m, centered on the charger) and the DC
    // plinth with its bollards (DC spots have no stop, checked anyway).
    const stopFor = (mount: WheelStopMount) => ({
      minX: -WHEEL_STOP.lengthM / 2,
      maxX: WHEEL_STOP.lengthM / 2,
      minZ: wheelStopNearZ(mount),
      maxZ: wheelStopNearZ(mount) + WHEEL_STOP.depthM,
    });
    const acPad = { minX: -0.5, maxX: 0.5, minZ: -AC_PAD_FRONT_Z, maxZ: AC_PAD_FRONT_Z };
    const dcPadAndBollards = { minX: -0.8, maxX: 0.8, minZ: -0.6, maxZ: 0.69 };
    const overlaps = (a: typeof acPad, b: typeof acPad) =>
      a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
    expect(overlaps(stopFor('curb'), acPad)).toBe(false);
    expect(overlaps(stopFor('curb'), dcPadAndBollards)).toBe(false);
    // A clear gap between the stop and the pad (a sweeper passes; no tire on the pad).
    expect(wheelStopNearZ('curb') - AC_PAD_FRONT_Z).toBeGreaterThan(0.3);
    // A wall box has no base on the ground.
    expect(wheelStopNearZ('wall')).toBeGreaterThan(stallHeadZ('wall'));
  });

  it('parks every car body type with its front tires at the stop and its nose clear of the charger', () => {
    for (const bodyType of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[bodyType];
      for (const mount of ['curb', 'wall'] as const) {
        const nose = carNoseAtStop(mount, profile);
        const axle = nose + profile.frontAxle;
        // The tire meets the stop's far face at the stop's height.
        expect(axle - tireTouchAhead(profile.wheelRadius)).toBeCloseTo(
          wheelStopNearZ(mount) + WHEEL_STOP.depthM,
        );
        // The front tire rests against the stop, never on top of it.
        expect(axle - profile.wheelRadius).toBeLessThan(wheelStopNearZ(mount) + WHEEL_STOP.depthM);
        const obstacle = mount === 'wall' ? stallHeadZ(mount) : AC_PAD_FRONT_Z + 0.2;
        // The bumper overhangs the stop but stops short of the pad, and the
        // car body stays inside its stall.
        expect(nose).toBeGreaterThan(obstacle);
        expect(nose).toBeLessThan(wheelStopNearZ(mount));
      }
    }
  });

  it('stands every AC pedestal behind the stall head line, the stall keeping its full depth', () => {
    // Lot Edge rows and the outer rows of Islands: the curb strip at the lot edge.
    const edge = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 3, chargerPlacement: 'lot_edge' });
    for (const bay of [
      { col: 1, row: 0 },
      { col: 1, row: 2 },
    ]) {
      expect(chargerBehindStallHead(bay, edge, 'ac', false)).toBe(true);
      const shift = stationBackShift(bay, edge, 'ac', false);
      expect(shift).toBeCloseTo(BAY_STATION_Z + CHARGER_BEHIND_STALL_HEAD_M);
      const spot = spotRect(bay, edge);
      const z = bayToWorld(bay, edge).z + (bay.row === 0 ? -shift : shift);
      // Outside its spot, 0.6 m behind the lot edge (the stall head line).
      if (bay.row === 0) expect(spot.minZ - z).toBeCloseTo(CHARGER_BEHIND_STALL_HEAD_M);
      else expect(z - spot.maxZ).toBeCloseTo(CHARGER_BEHIND_STALL_HEAD_M);
      // A DC dispenser keeps its place in the head of its spot, behind its bollards.
      expect(stationBackShift(bay, edge, 'dc', false)).toBe(0);
    }
    // An island pedestal already stands behind its curb.
    const islands = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4 });
    expect(chargerBehindStallHead({ col: 0, row: 1 }, islands, 'ac', false)).toBe(false);
    // Every row of 1 to 7 row lots, both placements: the first and last row move
    // behind the lot edge, the others stand on an island or, the next to last
    // row of an odd lot, on the charger strip at its head. No pedestal stands in
    // its stall or in an aisle.
    for (const chargerPlacement of ['islands', 'lot_edge'] as const) {
      for (let rows = 1; rows <= 7; rows++) {
        const lot = lotOf({ ...DEFAULT_LAYOUT_GRID, rows, chargerPlacement });
        for (let row = 0; row < rows; row++) {
          const bay = { col: 1, row };
          if (!isSpot(bay, lot)) continue;
          const label = `${chargerPlacement} rows ${String(rows)} row ${String(row)}`;
          const shift = stationBackShift(bay, lot, 'ac', false);
          const z = bayToWorld(bay, lot).z + (bayTurn(bay, lot) !== 0 ? shift : -shift);
          const spot = spotRect(bay, lot);
          const back = bayTurn(bay, lot) !== 0;
          // The pedestal center stands the setback past the stall head line.
          expect(back ? z - spot.maxZ : spot.minZ - z, label).toBeCloseTo(
            CHARGER_BEHIND_STALL_HEAD_M,
          );
          // Its pad stays out of the stall.
          expect(back ? z - AC_PAD_FRONT_Z : z + AC_PAD_FRONT_Z, label).toSatisfy((edge: number) =>
            back ? edge >= spot.maxZ - 1e-6 : edge <= spot.minZ + 1e-6,
          );
          const aisle = parkingRowGaps(lot).some(
            (g) => g.kind === 'aisle' && z > g.minZ + 1e-6 && z < g.maxZ - 1e-6,
          );
          expect(aisle, label).toBe(false);
          expect(chargerAtCurb(bay, lot, 'ac', false), label).toBe(true);
        }
      }
    }
    // The odd lot's strip is a curbed island between the head and the aisle.
    const odd = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 3 });
    expect(parkingRowGaps(odd).map((g) => g.kind)).toEqual(['aisle', 'island', 'aisle']);
    expect(chargerOnIsland({ col: 1, row: 1 }, odd)).toBe(true);
    // Office or retail stall posts on the sidewalk, wall boxes on the facade.
    const office = lotOf({
      siteType: 'office_retail',
      spotsPerRow: 6,
      rows: 1,
      facingDeg: 0,
      chargers: 6,
    });
    const post = { col: 2, row: 0 };
    expect(chargerBehindStallHead(post, office, 'ac', false)).toBe(true);
    expect(bayToWorld(post, office).z - stationBackShift(post, office, 'ac', false)).toBeCloseTo(
      -CHARGER_BEHIND_STALL_HEAD_M,
    );
    expect(chargerBehindStallHead(post, office, 'ac', true)).toBe(false);
    // Off the layout (on the grass) nothing moves.
    expect(chargerBehindStallHead({ col: 0, row: 9 }, edge, 'ac', false)).toBe(false);
    // A custom site's car spot begins at the stall head line in front of its charger.
    expect(freeSpotRects(1, 'car')[0]?.minZ).toBeCloseTo(stallHeadZ('curb'));
  });

  it('touches a step of the stop height ahead of the axle', () => {
    // A 0.34 m tire meets a 0.15 m step about 0.28 m ahead of its axle.
    expect(tireTouchAhead(0.34)).toBeCloseTo(Math.sqrt(0.34 ** 2 - 0.19 ** 2));
  });
});
