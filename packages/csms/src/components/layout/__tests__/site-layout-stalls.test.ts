// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { ACCESSIBLE_SPACE, STANDARD_DIMENSIONS } from '@evtivity/lib/site-layout';
import { chargerBehindStallHead, lotOf } from '../site-layout-grid';
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
        // EVSE 1 serves the left stall seen from the charger's front, in a turned row too
        // (OCPP numbering: left to right), so each EVSE's cable stays on its own side.
        expect(Math.sign(left!.stalls[0]!.x)).toBe(-1);
        expect(Math.sign(left!.stalls[1]!.x)).toBe(1);
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

  it('widens the paired stall that holds the accessible space and keeps the other stall', () => {
    const l = lot('islands');
    // A dual-outlet dispenser on spots 2 and 3, its stall 3 widened toward the aisle at 4.
    const space = { stall: { col: 3, row: 0 }, aisle: { col: 4, row: 0 } };
    const boxes = accessibleSpaceBoxes(space, l);
    const stalls = stationStalls({ col: 2, row: 0 }, l, { pair: true, access: space });
    expect(stalls?.shiftX).toBeCloseTo(W / 2);
    expect(stalls?.stalls[0]?.x).toBeCloseTo(-W / 2);
    expect(stalls?.stalls[0]?.width).toBe(W);
    expect(stalls?.stalls[1]?.width).toBeCloseTo(boxes.vehicle.maxX - boxes.vehicle.minX);
    expect(stalls?.stalls[1]?.x).toBeCloseTo((boxes.vehicle.minX + boxes.vehicle.maxX) / 2 - 3 * W);
  });

  it('draws no stalls on a street or off the layout', () => {
    const street = lotOf({ siteType: 'curbside', spotsPerRow: 4, rows: 2, facingDeg: 0 });
    expect(stationStalls({ col: 0, row: 0 }, street, { pair: true, access: null })).toBeNull();
    expect(
      stationStalls({ col: 0, row: 9 }, lot('islands'), { pair: true, access: null }),
    ).toBeNull();
  });

  it('stands a two-port wall box on the line between two office or retail spots', () => {
    const office = lotOf({
      siteType: 'office_retail',
      chargers: 5,
      mounting: 'wall',
      spotsPerRow: 5,
      rows: 1,
      facingDeg: 0,
    });
    expect(lotPairPartner({ col: 2, row: 0 }, office)).toEqual({ col: 3, row: 0 });
    expect(lotPairPartner({ col: 4, row: 0 }, office)).toBeNull();
    const s = stationStalls({ col: 0, row: 0 }, office, { pair: true, access: null });
    expect(s?.shiftX).toBeCloseTo(W / 2, 6);
    expect(s?.stalls[0]?.x).toBeCloseTo(-W / 2, 6);
    expect(s?.stalls[1]?.x).toBeCloseTo(W / 2, 6);
    // Unpaired: its own spot only.
    const one = stationStalls({ col: 0, row: 0 }, office, { pair: false, access: null });
    expect(one).toEqual({ shiftX: 0, stalls: [{ x: 0, width: W }] });
  });

  it('stands a two-port post on the line between two stall-mounted office or retail spots', () => {
    const office = lotOf({
      siteType: 'office_retail',
      chargers: 4,
      mounting: 'stall',
      spotsPerRow: 4,
      rows: 1,
      facingDeg: 0,
    });
    expect(lotPairPartner({ col: 0, row: 0 }, office)).toEqual({ col: 1, row: 0 });
    const s = stationStalls({ col: 0, row: 0 }, office, { pair: true, access: null });
    expect(s?.shiftX).toBeCloseTo(W / 2, 6);
    expect(s?.stalls.map((st) => st.x)).toEqual([
      expect.closeTo(-W / 2, 6),
      expect.closeTo(W / 2, 6),
    ]);
    // The post stands on the sidewalk behind the stall head, never in a stall.
    expect(chargerBehindStallHead({ col: 0, row: 0 }, office, 'ac', false)).toBe(true);
  });
});
