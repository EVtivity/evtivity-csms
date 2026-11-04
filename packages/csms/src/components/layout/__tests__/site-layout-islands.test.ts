// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  CHARGER_BEHIND_STALL_HEAD_M,
  STANDARD_DIMENSIONS,
  WHEEL_STOP,
  lotExtentM,
} from '@evtivity/lib/site-layout';
import {
  BAY_STATION_Z,
  bayToWorld,
  carNoseAtStop,
  chargerOnIsland,
  chargersAtBack,
  lotOf,
  parkingRowGaps,
  rowFrontZ,
  spotRect,
  stationBackPoint,
  wheelStopMount,
  wheelStopNearZ,
  worldToBay,
} from '../site-layout-grid';
import { CAR_PROFILES } from '../site-layout-car';

const { spotDepthM: S, laneWidthM: A, islandWidthM: I } = STANDARD_DIMENSIONS;
const lot = (rows: number) =>
  lotOf({ siteType: 'parking_lot', spotsPerRow: 4, rows, facingDeg: 0 });

describe('parking lot rows with a center island', () => {
  it('lays out rows 0 and 1 around an aisle, rows 1 and 2 around an island, rows 2 and 3 around an aisle', () => {
    const l = lot(4);
    expect(l.depth).toBeCloseTo(lotExtentM({ spotsPerRow: 4, rows: 4, facingDeg: 0 }).depth);
    const gaps = parkingRowGaps(l);
    expect(gaps.map((g) => g.kind)).toEqual(['aisle', 'island', 'aisle']);
    const expected = [
      [S, S + A],
      [2 * S + A, 2 * S + A + I],
      [3 * S + A + I, 3 * S + 2 * A + I],
    ];
    gaps.forEach((g, i) => {
      expect(g.minZ).toBeCloseTo(expected[i]![0]!);
      expect(g.maxZ).toBeCloseTo(expected[i]![1]!);
    });
    expect(rowFrontZ(2, l)).toBeCloseTo(2 * S + A + I);
    expect(spotRect({ col: 1, row: 2 }, l).minZ).toBeCloseTo(2 * S + A + I);
    // A two-row lot has no island; the other site types have no gaps.
    expect(parkingRowGaps(lot(2)).map((g) => g.kind)).toEqual(['aisle']);
    expect(
      parkingRowGaps(
        lotOf({ siteType: 'office_retail', spotsPerRow: 4, rows: 1, facingDeg: 0, chargers: 4 }),
      ),
    ).toEqual([]);
  });

  it('stands the chargers of back-to-back rows on the island, facing their rows', () => {
    const l = lot(4);
    const island = parkingRowGaps(l)[1];
    if (island == null) throw new Error('no island');
    expect(chargersAtBack(1, l)).toBe(true);
    expect(chargersAtBack(2, l)).toBe(false);
    for (const row of [1, 2]) {
      expect(chargerOnIsland({ col: 0, row }, l)).toBe(true);
      const p = bayToWorld({ col: 0, row }, l);
      expect(p.z).toBeGreaterThan(island.minZ);
      expect(p.z).toBeLessThan(island.maxZ);
    }
    expect(bayToWorld({ col: 0, row: 1 }, l).z).toBeCloseTo(
      island.minZ + CHARGER_BEHIND_STALL_HEAD_M,
    );
    expect(bayToWorld({ col: 0, row: 2 }, l).z).toBeCloseTo(
      island.maxZ - CHARGER_BEHIND_STALL_HEAD_M,
    );
    // The link end behind each charger stays on the island too.
    expect(stationBackPoint({ col: 0, row: 1 }, l).z).toBeLessThan(island.maxZ);
    expect(stationBackPoint({ col: 0, row: 2 }, l).z).toBeGreaterThan(island.minZ);
    // The edge rows keep their chargers in the head of the spot at the lot edges.
    expect(chargerOnIsland({ col: 0, row: 0 }, l)).toBe(false);
    expect(bayToWorld({ col: 0, row: 0 }, l).z).toBeCloseTo(BAY_STATION_Z);
    expect(bayToWorld({ col: 0, row: 3 }, l).z).toBeCloseTo(l.depth - BAY_STATION_Z);
    // A point on the island picks the nearer row.
    expect(worldToBay(1.3, island.minZ + 0.2, l)).toEqual({ col: 0, row: 1 });
    expect(worldToBay(1.3, island.maxZ - 0.2, l)).toEqual({ col: 0, row: 2 });
  });

  it('sets the wheel stop of an island spot from the island curb and parks the car in the spot', () => {
    const l = lot(4);
    const base = {
      siteType: 'parking_lot' as const,
      kind: 'ac' as const,
      wall: false,
      onSpot: true,
    };
    expect(wheelStopMount({ ...base, largeSpot: false })).toBe('curb');
    // The curb is CHARGER_BEHIND_STALL_HEAD_M in front of the charger; the stop 2 ft past it.
    expect(wheelStopNearZ('curb')).toBeCloseTo(
      CHARGER_BEHIND_STALL_HEAD_M + WHEEL_STOP.fromStallHeadM,
    );
    const nose = carNoseAtStop('curb', CAR_PROFILES.sedan);
    expect(nose).toBeGreaterThan(CHARGER_BEHIND_STALL_HEAD_M);
    // In lot meters, row 2's car nose stands inside its spot.
    const charger = bayToWorld({ col: 0, row: 2 }, l).z;
    const rect = spotRect({ col: 0, row: 2 }, l);
    expect(charger + nose).toBeGreaterThan(rect.minZ);
    expect(charger + nose + 4.7).toBeLessThan(rect.maxZ + 1);
  });
});
