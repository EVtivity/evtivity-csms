// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ACCESSIBLE_SPACE,
  STANDARD_DIMENSIONS,
  accessibleChargingSpace,
  bayInLayout,
  bayToPosition,
  effectiveLayoutSettings,
  firstFreeSlotFor,
  fitGroupedPositions,
  freeSlotsFor,
  heldSpots,
  positionToBay,
  settlePairs,
  sharesSpotPair,
  spotPairPartner,
  type LayoutBay,
  type SiteLayoutSettings,
} from '../site-layout.js';

const AC1 = { charging: 'ac', depot: null, ports: 1 } as const;
const AC2 = { charging: 'ac', depot: null, ports: 2 } as const;
const DC = { charging: 'dc', depot: 'bus', ports: 2 } as const;
const DC1 = { charging: 'dc', depot: 'bus', ports: 1 } as const;

const lot = (placement: 'islands' | 'lot_edge', rows = 4): SiteLayoutSettings =>
  effectiveLayoutSettings({
    siteType: 'parking_lot',
    spotsPerRow: 8,
    rows,
    facingDeg: 0,
    chargerPlacement: placement,
    transformers: [{ id: 'tx', x: 30, z: 2.5 }],
  });

const bayOf = (p: { x: number; y: number }): LayoutBay => positionToBay(p);

describe('dual-port AC pedestals share two spots', () => {
  it('pairs the spots of a row from its first spot, on a parking lot and an office or retail row', () => {
    const s = lot('islands');
    expect(spotPairPartner({ col: 0, row: 0 }, s)).toEqual({ col: 1, row: 0 });
    expect(spotPairPartner({ col: 5, row: 2 }, s)).toEqual({ col: 4, row: 2 });
    expect(spotPairPartner({ col: 0, row: 9 }, s)).toBeNull();
    const office = effectiveLayoutSettings({
      siteType: 'office_retail',
      chargers: 5,
      spotsPerRow: 6,
      rows: 1,
      facingDeg: 0,
      transformers: [],
    });
    expect(spotPairPartner({ col: 0, row: 0 }, office)).toEqual({ col: 1, row: 0 });
    expect(spotPairPartner({ col: 3, row: 0 }, office)).toEqual({ col: 2, row: 0 });
    // The last spot of an odd row has no partner.
    expect(spotPairPartner({ col: 4, row: 0 }, office)).toBeNull();
    const street = effectiveLayoutSettings({
      siteType: 'curbside',
      chargersLeft: 4,
      spotsPerRow: 4,
      rows: 1,
      facingDeg: 0,
      transformers: [],
    });
    expect(spotPairPartner({ col: 0, row: 0 }, street)).toBeNull();
    expect(sharesSpotPair(AC2, street)).toBe(false);
  });

  it('pairs a two-port wall box or stall post on an office or retail row', () => {
    const wall = effectiveLayoutSettings({
      siteType: 'office_retail',
      chargers: 6,
      mounting: 'wall',
      spotsPerRow: 6,
      rows: 1,
      facingDeg: 0,
      transformers: [],
    });
    expect(sharesSpotPair(AC2, wall)).toBe(true);
    expect(sharesSpotPair(AC1, wall)).toBe(false);
    // Wall mounting is the default.
    expect(sharesSpotPair(AC2, { ...wall, mounting: undefined })).toBe(true);
    // A two-port post at the stalls stands on the line between two stalls too (owner decision 2026-11-10).
    expect(sharesSpotPair(AC2, { ...wall, mounting: 'stall' })).toBe(true);
    expect(sharesSpotPair(AC1, { ...wall, mounting: 'stall' })).toBe(false);
    expect(sharesSpotPair({ charging: 'dc', ports: 2 }, { ...wall, mounting: 'stall' })).toBe(
      false,
    );
    // New two-port wall boxes each take a free pair; a one-port box one spot.
    const slots = freeSlotsFor([AC2, AC1, AC2], [], wall).map(bayOf);
    const held = heldSpots(
      slots.map((b, i) => ({
        ...bayToPosition(b),
        charging: 'ac' as const,
        pair: i !== 1,
      })),
      wall,
      false,
    );
    expect(held.size).toBe(5);
    for (const [i, b] of slots.entries()) {
      if (i === 1) continue;
      const partner = spotPairPartner(b, wall);
      expect(partner).not.toBeNull();
      expect(slots.some((o) => o.col === partner?.col)).toBe(false);
    }
    // A stored box whose partner spot another station holds keeps its one spot.
    const settled = settlePairs(
      [
        { ...bayToPosition({ col: 0, row: 0 }), charging: 'ac', pair: true },
        { ...bayToPosition({ col: 1, row: 0 }), charging: 'ac', pair: false },
      ],
      wall,
    );
    expect(settled.map((p) => p.pair)).toEqual([false, false]);
  });

  it('shares a pair for AC stations with two ports and DC stations with exactly two', () => {
    const s = lot('islands');
    expect(sharesSpotPair(AC2, s)).toBe(true);
    expect(sharesSpotPair(AC1, s)).toBe(false);
    expect(sharesSpotPair({ charging: 'ac' }, s)).toBe(false);
    // A dual-outlet DC dispenser (two EVSEs) too; one EVSE or a split system does not.
    expect(sharesSpotPair(DC, s)).toBe(true);
    expect(sharesSpotPair({ charging: 'dc', ports: 1 }, s)).toBe(false);
    expect(sharesSpotPair({ charging: 'dc' }, s)).toBe(false);
    expect(sharesSpotPair({ charging: 'dc', ports: 3 }, s)).toBe(false);
    const office = effectiveLayoutSettings({
      siteType: 'office_retail',
      chargers: 6,
      spotsPerRow: 6,
      rows: 1,
      facingDeg: 0,
      transformers: [],
    });
    expect(sharesSpotPair(DC, office)).toBe(false);
  });

  for (const placement of ['islands', 'lot_edge'] as const) {
    it(`places each 2-port pedestal on its own free pair, 1-port stations one spot each (${placement})`, () => {
      const s = lot(placement);
      const slots = freeSlotsFor([AC2, AC2, AC1, AC2], [], s);
      const bays = slots.map(bayOf);
      for (const b of bays) expect(bayInLayout(b, s)).toBe(true);
      const held = heldSpots(
        slots.map((p, i) => ({ ...p, charging: 'ac', pair: i !== 2 })),
        s,
      );
      // Every spot held once: the three pedestals hold two spots each, the 1-port one.
      const pedestalSpots = [0, 1, 3].flatMap((i) => {
        const partner = spotPairPartner(bays[i]!, s);
        expect(partner).not.toBeNull();
        return [bays[i]!, partner!];
      });
      const keys = [...pedestalSpots, bays[2]!].map((b) => `${String(b.col)}:${String(b.row)}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(held.has(k)).toBe(true);
    });
  }

  it('never puts a station on the partner spot of a 2-port pedestal', () => {
    const s = lot('islands');
    const pedestal = { ...bayToPosition({ col: 0, row: 1 }), charging: 'ac' as const, pair: true };
    for (let i = 0; i < 20; i++) {
      const slot = firstFreeSlotFor([pedestal], s, AC1);
      expect(bayOf(slot)).not.toEqual({ col: 1, row: 1 });
    }
    const all = freeSlotsFor(
      Array.from({ length: 31 }, () => AC1),
      [pedestal],
      s,
    );
    expect(all.map(bayOf)).not.toContainEqual({ col: 1, row: 1 });
  });

  it('keeps stored positions valid: a 2-port pedestal sharing its pair with another station moves to a free pair', () => {
    const s = lot('islands');
    const at = (col: number, row: number) => bayToPosition({ col, row });
    const fit = fitGroupedPositions(
      [
        { key: 'a', position: at(0, 1), kind: AC2 },
        { key: 'b', position: at(1, 1), kind: AC1 },
        { key: 'c', position: at(2, 1), kind: AC1 },
        { key: 'd', position: at(4, 1), kind: AC2 },
      ],
      s,
    );
    // a keeps its pair; b sat on a's partner and moves; c and d stay.
    expect(fit.moved.has('a')).toBe(false);
    expect(fit.moved.has('c')).toBe(false);
    expect(fit.moved.has('d')).toBe(false);
    const b = fit.moved.get('b');
    expect(b).toBeDefined();
    const bBay = bayOf(b!);
    expect([0, 1, 2, 4, 5].includes(bBay.col) && bBay.row === 1).toBe(false);
    expect(fit.unfit).toEqual([]);
    // 1-port stations stored side by side stay where they are.
    const singles = fitGroupedPositions(
      [
        { key: 'x', position: at(0, 1), kind: AC1 },
        { key: 'y', position: at(1, 1), kind: AC1 },
      ],
      s,
    );
    expect(singles.moved.size).toBe(0);
  });

  it('moves a pedestal with no free pair partner (odd row end) to a full pair', () => {
    const s = effectiveLayoutSettings({
      siteType: 'parking_lot',
      spotsPerRow: 7,
      rows: 2,
      facingDeg: 0,
      transformers: [{ id: 'tx', x: -5, z: 2.5 }],
    });
    expect(spotPairPartner({ col: 6, row: 0 }, s)).toBeNull();
    const fit = fitGroupedPositions(
      [{ key: 'p', position: bayToPosition({ col: 6, row: 0 }), kind: AC2 }],
      s,
    );
    const moved = fit.moved.get('p');
    expect(moved).toBeDefined();
    expect(spotPairPartner(bayOf(moved!), s)).not.toBeNull();
  });
});

describe('accessible charging space', () => {
  it('fits a vehicle space of at least 11 ft and a 5 ft aisle in two standard spots', () => {
    const w = STANDARD_DIMENSIONS.spotWidthM;
    expect(ACCESSIBLE_SPACE.aisleWidthM).toBeCloseTo(60 * 0.0254, 2);
    expect(ACCESSIBLE_SPACE.vehicleMinWidthM).toBeCloseTo(132 * 0.0254, 2);
    expect(2 * w - ACCESSIBLE_SPACE.aisleWidthM).toBeGreaterThanOrEqual(
      ACCESSIBLE_SPACE.vehicleMinWidthM,
    );
  });

  it('puts the accessible space and its aisle at the end of a continuous run of chargers', () => {
    const s = lot('islands');
    const slots = freeSlotsFor([DC1, DC1, DC1], [], s);
    const placed = slots.map((p) => ({ ...p, charging: 'dc' as const }));
    const space = accessibleChargingSpace(placed, s);
    expect(space).not.toBeNull();
    // The run is continuous (no charger-free spot inside it): the aisle lies past its end.
    const cols = slots.map((p) => bayOf(p).col).sort((a, b) => a - b);
    expect(cols[cols.length - 1]! - cols[0]!).toBe(cols.length - 1);
    expect(slots.every((p) => bayOf(p).row === bayOf(slots[0]!).row)).toBe(true);
    expect([cols[0]! - 1, cols[cols.length - 1]! + 1]).toContain(space!.aisle.col);
    expect([cols[0], cols[cols.length - 1]]).toContain(space!.stall.col);
    expect(Math.abs(space!.aisle.col - space!.stall.col)).toBe(1);
    expect(space!.aisle.row).toBe(space!.stall.row);
    // No station takes the aisle.
    for (const p of slots) expect(bayOf(p)).not.toEqual(space!.aisle);
  });

  it('prefers a one-spot station, else a paired stall with a free outer neighbor', () => {
    const s = lot('islands');
    const pedestal = { ...bayToPosition({ col: 0, row: 0 }), charging: 'ac' as const, pair: true };
    // Only a paired station: its stall next to a free spot (never its partner) is the space.
    expect(accessibleChargingSpace([pedestal], s)).toEqual({
      stall: { col: 1, row: 0 },
      aisle: { col: 2, row: 0 },
    });
    // A one-spot station with a free neighbor comes first.
    const single = { ...bayToPosition({ col: 4, row: 0 }), charging: 'dc' as const };
    expect(accessibleChargingSpace([pedestal, single], s)?.stall).toEqual({ col: 4, row: 0 });
  });

  it('has none on a depot, a street or a custom site', () => {
    for (const siteType of ['curbside', 'custom', 'depot'] as const) {
      const other = effectiveLayoutSettings({
        siteType,
        spotsPerRow: 6,
        rows: 2,
        facingDeg: 0,
        transformers: [],
        ...(siteType === 'depot' ? { busBays: 4, truckLanes: 0 } : {}),
      });
      expect(
        accessibleChargingSpace([{ ...bayToPosition({ col: 0, row: 0 }), charging: 'ac' }], other),
      ).toBeNull();
    }
  });

  it('models one on an office or retail row too', () => {
    const office = effectiveLayoutSettings({
      siteType: 'office_retail',
      chargers: 6,
      spotsPerRow: 6,
      rows: 1,
      facingDeg: 0,
      transformers: [],
    });
    const placed = [{ ...bayToPosition({ col: 2, row: 0 }), charging: 'ac' as const }];
    expect(accessibleChargingSpace(placed, office)).toEqual({
      stall: { col: 2, row: 0 },
      aisle: { col: 3, row: 0 },
    });
  });
});

describe('settled spot pairs', () => {
  it('keeps a pair only while its partner spot is free, so stored neighbors stay valid', () => {
    const s = lot('islands');
    const at = (col: number) => ({
      ...bayToPosition({ col, row: 0 }),
      charging: 'dc' as const,
      pair: true,
    });
    // Two dual-outlet dispensers stored side by side (before DC paired): each keeps its own spot.
    const settled = settlePairs([at(0), at(1)], s);
    expect(settled.map((p) => p.pair)).toEqual([false, false]);
    const held = heldSpots([at(0), at(1)], s, false);
    expect([...held.keys()].sort()).toEqual(['0:0', '1:0']);
    // Apart, both pair.
    expect(settlePairs([at(0), at(2)], s).map((p) => p.pair)).toEqual([true, true]);
    // A dispenser stored on another's partner spot: neither pairs, each keeps its own spot.
    const partner = { ...bayToPosition({ col: 3, row: 0 }), charging: 'dc' as const, pair: true };
    expect(settlePairs([at(2), partner], s).map((p) => p.pair)).toEqual([false, false]);
  });

  it('places a new dual-outlet DC dispenser on a free pair of its group', () => {
    const s = lot('islands');
    const first = firstFreeSlotFor([], s, DC);
    const bay = bayOf(first);
    const partner = spotPairPartner(bay, s);
    expect(partner).not.toBeNull();
    const second = firstFreeSlotFor([{ ...first, charging: 'dc', pair: true }], s, DC);
    expect([bay.col, partner!.col]).not.toContain(bayOf(second).col);
  });
});
