// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  FREE_LAYOUT,
  CHARGER_BEHIND_STALL_HEAD_M,
  STANDARD_DIMENSIONS,
  freePlacementFromSlot,
  lotExtentM,
  parkingChargerOnIsland,
  parkingChargerZ,
  parkingChargersAtBack,
  parkingRowGap,
  parkingRowZ,
} from '../site-layout.js';

const { spotDepthM: S, laneWidthM: A, islandWidthM: I } = STANDARD_DIMENSIONS;
const grid = (rows: number) => ({ spotsPerRow: 10, rows, facingDeg: 0 as const });

describe('double-loaded parking rows', () => {
  it('puts an aisle between rows facing each other and an island between rows back to back', () => {
    expect([0].map((r) => parkingRowGap(r, 2))).toEqual(['aisle']);
    // An odd last row keeps an aisle in front of it.
    expect([0, 1].map((r) => parkingRowGap(r, 3))).toEqual(['aisle', 'aisle']);
    expect([0, 1, 2].map((r) => parkingRowGap(r, 4))).toEqual(['aisle', 'island', 'aisle']);
    expect([0, 1, 2, 3].map((r) => parkingRowGap(r, 5))).toEqual([
      'aisle',
      'island',
      'aisle',
      'aisle',
    ]);
    // Slots past the lot continue with aisle spacing.
    expect(parkingRowGap(4, 4)).toBe('aisle');
  });

  it('sizes the lot from its rows, aisles and islands (1 to 4 rows)', () => {
    expect(lotExtentM(grid(1)).depth).toBeCloseTo(S);
    expect(lotExtentM(grid(2)).depth).toBeCloseTo(2 * S + A);
    expect(lotExtentM(grid(3)).depth).toBeCloseTo(3 * S + 2 * A);
    expect(lotExtentM(grid(4)).depth).toBeCloseTo(4 * S + 2 * A + I);
    expect(parkingRowZ(2, 4)).toBeCloseTo(2 * S + A + I);
    expect(lotExtentM(grid(4)).width).toBeCloseTo(10 * STANDARD_DIMENSIONS.spotWidthM);
  });

  it('faces rows 0 and 1 across an aisle, and keeps the outermost chargers at the lot edges', () => {
    expect([0].map((r) => parkingChargersAtBack(r, 1))).toEqual([false]);
    expect([0, 1].map((r) => parkingChargersAtBack(r, 2))).toEqual([false, true]);
    expect([0, 1, 2].map((r) => parkingChargersAtBack(r, 3))).toEqual([false, true, true]);
    expect([0, 1, 2, 3].map((r) => parkingChargersAtBack(r, 4))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('stands the chargers of rows back to back on their shared island, the others in the spot head', () => {
    expect([0, 1, 2, 3].map((r) => parkingChargerOnIsland(r, 4))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([0, 1, 2].map((r) => parkingChargerOnIsland(r, 3))).toEqual([false, false, false]);
    const into = FREE_LAYOUT.stationIntoSpotM;
    // Row 0: at the lot's front edge, in the head of the spot.
    expect(parkingChargerZ(0, 4)).toBeCloseTo(into);
    // Rows 1 and 2: back to back on the island, each on its half.
    const islandFront = parkingRowZ(1, 4) + S;
    expect(parkingChargerZ(1, 4)).toBeCloseTo(islandFront + CHARGER_BEHIND_STALL_HEAD_M);
    expect(parkingChargerZ(2, 4)).toBeCloseTo(islandFront + I - CHARGER_BEHIND_STALL_HEAD_M);
    expect(parkingChargerZ(2, 4) - parkingChargerZ(1, 4)).toBeGreaterThan(0.9);
    // Row 3: at the lot's back edge.
    expect(parkingChargerZ(3, 4)).toBeCloseTo(lotExtentM(grid(4)).depth - into);
  });

  it('keeps a charger where it stands when the lot turns into a custom site', () => {
    const settings = { siteType: 'parking_lot' as const, ...grid(4) };
    expect(freePlacementFromSlot({ col: 2, row: 2 }, settings)).toEqual({
      x: 6.5,
      z: Math.round(parkingChargerZ(2, 4) * 100) / 100,
      rotationDeg: 0,
    });
    expect(freePlacementFromSlot({ col: 0, row: 1 }, settings).rotationDeg).toBe(180);
  });
});
