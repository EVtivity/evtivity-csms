// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { ACCESSIBLE_SPACE, STANDARD_DIMENSIONS } from '@evtivity/lib/site-layout';
import { lotOf } from '../site-layout-grid';
import { accessibleSpaceBoxes, lotPairPartner, stationStalls } from '../site-layout-stalls';

const W = STANDARD_DIMENSIONS.spotWidthM;

const lot = (chargerPlacement: 'islands' | 'lot_edge') =>
  lotOf({
    siteType: 'parking_lot',
    spotsPerRow: 8,
    rows: 4,
    facingDeg: 0,
    chargerPlacement,
  });

describe('station stalls', () => {
  for (const placement of ['islands', 'lot_edge'] as const) {
    it(`stands a 2-port pedestal on the line between its two spots (${placement})`, () => {
      const l = lot(placement);
      // Row 0 faces +z; row 3 (the last row) is turned.
      for (const row of [0, 3]) {
        const left = stationStalls({ col: 2, row }, l, { pair: true, access: null });
        const right = stationStalls({ col: 3, row }, l, { pair: true, access: null });
        expect(left?.shiftX).toBeCloseTo(W / 2);
        expect(right?.shiftX).toBeCloseTo(-W / 2);
        // Two stalls, one spot width each, centered half a spot either side.
        for (const s of left?.stalls ?? []) expect(Math.abs(s.x)).toBeCloseTo(W / 2);
        expect(left?.stalls).toHaveLength(2);
        expect(left?.stalls.every((s) => s.width === W)).toBe(true);
        // EVSE 1 serves the lower column: on the left in a row facing +z, on the right in a turned row.
        expect(Math.sign(left!.stalls[0]!.x)).toBe(row === 0 ? -1 : 1);
      }
    });
  }

  it('keeps a 1-port station in its own spot', () => {
    expect(
      stationStalls({ col: 2, row: 0 }, lot('islands'), { pair: false, access: null }),
    ).toEqual({ shiftX: 0, stalls: [{ x: 0, width: W }] });
  });

  it('treats a pedestal at an odd row end, with no partner, as one spot', () => {
    const l = lotOf({ siteType: 'parking_lot', spotsPerRow: 7, rows: 2, facingDeg: 0 });
    expect(lotPairPartner({ col: 6, row: 0 }, l)).toBeNull();
    expect(stationStalls({ col: 6, row: 0 }, l, { pair: true, access: null })?.stalls).toHaveLength(
      1,
    );
  });

  it('widens the accessible station stall and keeps a 60 in aisle beside it', () => {
    const l = lot('islands');
    const space = { stall: { col: 3, row: 0 }, aisle: { col: 4, row: 0 } };
    const boxes = accessibleSpaceBoxes(space, l);
    expect(boxes.aisle.maxX - boxes.aisle.minX).toBeCloseTo(ACCESSIBLE_SPACE.aisleWidthM);
    expect(boxes.vehicle.maxX - boxes.vehicle.minX).toBeGreaterThanOrEqual(
      ACCESSIBLE_SPACE.vehicleMinWidthM,
    );
    expect(boxes.vehicle.maxX).toBeCloseTo(boxes.aisle.minX);
    const stalls = stationStalls(space.stall, l, { pair: false, access: space });
    expect(stalls?.shiftX).toBe(0);
    expect(stalls?.stalls[0]?.width).toBeCloseTo(boxes.vehicle.maxX - boxes.vehicle.minX);
    // The aisle on the lower side mirrors it.
    const before = accessibleSpaceBoxes(
      { stall: { col: 3, row: 0 }, aisle: { col: 2, row: 0 } },
      l,
    );
    expect(before.aisle.minX).toBeCloseTo(2 * W);
    expect(before.vehicle.minX).toBeCloseTo(before.aisle.maxX);
  });

  it('draws no stalls on a street or off the layout', () => {
    const street = lotOf({ siteType: 'curbside', spotsPerRow: 4, rows: 2, facingDeg: 0 });
    expect(stationStalls({ col: 0, row: 0 }, street, { pair: true, access: null })).toBeNull();
    expect(
      stationStalls({ col: 0, row: 9 }, lot('islands'), { pair: true, access: null }),
    ).toBeNull();
  });
});
