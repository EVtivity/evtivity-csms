// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DUAL_OUTLET_BUS_CHARGER,
  FREE_LAYOUT,
  dualOutletBusCharger,
  twoPortCurbPost,
  TWO_PORT_CURB_POST,
  firstFreeDepotSlot,
  fitDepotPositions,
  accessibleChargingSpace,
  effectiveLayoutSettings,
  firstFreeSlotFor,
  fitGroupedPositions,
  freeSlotsFor,
  freeSpotCount,
  freeSpotRects,
  heldSpotCount,
  heldSpots,
  layoutStationCountsOfKinds,
  layoutStationKind,
  positionToBay,
  sharesSpotPair,
  splitDispenserCount,
  stationFreeSpotCount,
  stationSpanCount,
  stationUnitChargers,
  unitChargerKinds,
  unitChargerSpans,
  unitChargerSpotCount,
  bayToPosition,
  type LayoutStationKind,
  type SiteLayoutSettings,
} from '../site-layout.js';

// The discussion 59 setup: an OCPP 1.6 ABL eM4 master with seven extenders,
// 8 boxes "Box 1" to "Box 8" of 2 AC EVSEs each (Type2).
const type2 = { connectorType: 'Type2', maxPowerKw: 22 };
const ccs = { connectorType: 'CCS2', maxPowerKw: 150 };
const evses16 = Array.from({ length: 16 }, (_, i) => ({ evseId: i + 1, connectors: [type2] }));
const boxes = Array.from({ length: 8 }, (_, i) => ({
  id: `unt_${String(i + 1)}`,
  name: `Box ${String(i + 1)}`,
  evseIds: [2 * i + 1, 2 * i + 2],
}));

const lot = (spotsPerRow = 20, rows = 2): SiteLayoutSettings =>
  effectiveLayoutSettings({
    siteType: 'parking_lot',
    spotsPerRow,
    rows,
    facingDeg: 0,
    chargerPlacement: 'islands',
    transformers: [{ id: 'tx', x: -2.5, z: 2.5 }],
  });

const kindOf = (
  station: Parameters<typeof stationUnitChargers>[0],
): LayoutStationKind & { units?: unknown } =>
  layoutStationKind(
    station.evses.flatMap((e) => e.connectors),
    station.evses.length,
    unitChargerKinds(stationUnitChargers(station)),
  );

describe('stationUnitChargers', () => {
  it('returns null for a station without units, so every caller keeps its path', () => {
    expect(stationUnitChargers({ evses: evses16 })).toBeNull();
    expect(stationUnitChargers({ units: [], evses: evses16 })).toBeNull();
    // Units that hold none of the station's EVSEs: the station draws as before.
    expect(
      stationUnitChargers({ units: [{ id: 'u', name: 'U', evseIds: [99] }], evses: evses16 }),
    ).toBeNull();
  });

  it('draws one charger per unit in order, then one for the EVSEs without a unit', () => {
    const chargers = stationUnitChargers({ units: boxes.slice(0, 3), evses: evses16 });
    expect(chargers?.map((c) => c.name)).toEqual(['Box 1', 'Box 2', 'Box 3', null]);
    expect(chargers?.map((c) => c.evseIds)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    ]);
    expect(chargers?.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chargers?.every((c) => c.charging === 'ac')).toBe(true);
  });

  it('skips a unit with no listed EVSE and never draws an EVSE twice', () => {
    const chargers = stationUnitChargers({
      units: [
        { id: 'a', name: 'A', evseIds: [1, 2] },
        { id: 'empty', name: 'Empty', evseIds: [] },
        { id: 'b', name: 'B', evseIds: [2, 3] },
      ],
      evses: evses16.slice(0, 4),
    });
    expect(chargers?.map((c) => [c.name, c.evseIds])).toEqual([
      ['A', [1, 2]],
      ['B', [3]],
      [null, [4]],
    ]);
  });

  it('gives each unit its own charging kind', () => {
    const chargers = stationUnitChargers({
      units: [
        { id: 'ac', name: 'AC', evseIds: [1, 2] },
        { id: 'dc', name: 'DC', evseIds: [3] },
      ],
      evses: [
        { evseId: 1, connectors: [type2] },
        { evseId: 2, connectors: [type2] },
        { evseId: 3, connectors: [ccs] },
      ],
    });
    expect(chargers?.map((c) => c.charging)).toEqual(['ac', 'dc']);
  });
});

describe('unit spans', () => {
  it('draws the 8-box station as 8 dual-port pedestals on 16 spots of one run', () => {
    const settings = lot();
    const kind = kindOf({ units: boxes, evses: evses16 });
    expect(kind.charging).toBe('ac');
    expect(kind.units).toHaveLength(8);
    // Never a split system or a station spot pair as a whole.
    expect(splitDispenserCount({ ...kind, charging: 'dc' }, settings)).toBe(1);
    expect(sharesSpotPair(kind, settings)).toBe(false);
    expect(stationSpanCount(kind, settings)).toBe(16);
    expect(heldSpotCount(kind, settings)).toBe(16);
    expect(unitChargerSpans(kind.units ?? [], settings)).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ offset: 2 * i, spots: 2 })),
    );
  });

  it('counts one spot for a single-port unit and two for a two-EVSE unit', () => {
    const settings = lot();
    expect(unitChargerSpotCount({ charging: 'ac', ports: 1 }, settings)).toBe(1);
    expect(unitChargerSpotCount({ charging: 'ac', ports: 2 }, settings)).toBe(2);
    expect(unitChargerSpotCount({ charging: 'dc', ports: 2 }, settings)).toBe(2);
    // A DC unit is never a split system: it draws its first two EVSEs on one dispenser.
    expect(unitChargerSpotCount({ charging: 'dc', ports: 4 }, settings)).toBe(2);
    const office = { ...settings, siteType: 'office_retail' as const, chargers: 20 };
    expect(unitChargerSpotCount({ charging: 'ac', ports: 2 }, office)).toBe(2);
    expect(unitChargerSpotCount({ charging: 'dc', ports: 2 }, office)).toBe(1);
    const street = { ...settings, siteType: 'curbside' as const };
    expect(unitChargerSpotCount({ charging: 'ac', ports: 2 }, street)).toBe(1);
    // A street gives each unit its own curb post (owner decision 2026-11-12).
    expect(
      stationSpanCount(
        {
          charging: 'ac',
          ports: 4,
          units: [
            { charging: 'ac', ports: 2 },
            { charging: 'ac', ports: 2 },
          ],
        },
        street,
      ),
    ).toBe(2);
  });

  it('places a station whose units mix AC and DC in the DC group', () => {
    const kind = kindOf({
      units: [
        { id: 'ac', name: 'AC', evseIds: [1, 2] },
        { id: 'dc', name: 'DC', evseIds: [3] },
      ],
      evses: [
        { evseId: 1, connectors: [type2] },
        { evseId: 2, connectors: [type2] },
        { evseId: 3, connectors: [ccs] },
      ],
    });
    expect(kind.charging).toBe('dc');
    expect(stationSpanCount(kind, lot())).toBe(3);
  });

  it('places a unit station on a free run of its spots and holds every one of them', () => {
    const settings = lot();
    const kind = kindOf({ units: boxes, evses: evses16 });
    const slot = firstFreeSlotFor([], settings, kind);
    const bay = positionToBay(slot);
    const held = heldSpots([{ ...slot, charging: 'ac', span: 16 }], settings, false);
    expect(held.size).toBe(16);
    for (let i = 0; i < 16; i++)
      expect(held.has(`${String(bay.col + i)}:${String(bay.row)}`)).toBe(true);
    // A second station takes a spot outside the run.
    const [next] = freeSlotsFor(
      [kind, { charging: 'ac', depot: null, ports: 1 }],
      [],
      settings,
    ).slice(1);
    expect(next).toBeDefined();
    if (next != null)
      expect(
        held.has(`${String(positionToBay(next).col)}:${String(positionToBay(next).row)}`),
      ).toBe(false);
  });

  it('keeps a stored unit station that fits and moves one whose run no longer fits', () => {
    const settings = lot(20);
    const kind = kindOf({ units: boxes, evses: evses16 });
    const fit = fitGroupedPositions(
      [{ key: 'units', position: bayToPosition({ col: 10, row: 0 }), kind }],
      settings,
    );
    // From column 10 the 16 spots leave a 20-spot row: the station moves to a run that fits.
    expect(fit.unfit).toEqual([]);
    const moved = fit.moved.get('units');
    expect(moved).toBeDefined();
    if (moved != null) expect(positionToBay(moved).col).toBeLessThanOrEqual(4);
  });

  it('widens a lot without stored settings so the widest unit station fits in a row', () => {
    const kind = kindOf({ units: boxes, evses: evses16 });
    const counts = layoutStationCountsOfKinds([kind]);
    expect(counts.widestSpan).toBe(16);
    expect(effectiveLayoutSettings(null, [], counts).spotsPerRow).toBe(16);
  });
});

describe('a station without units is unchanged', () => {
  it('keeps the counts, spans and pairs of today', () => {
    const settings = lot();
    const ac2 = { charging: 'ac', depot: null, ports: 2 } as const;
    const dc4 = { charging: 'dc', depot: 'bus', ports: 4 } as const;
    expect(stationSpanCount(ac2, settings)).toBe(1);
    expect(stationSpanCount(dc4, settings)).toBe(splitDispenserCount(dc4, settings));
    expect(heldSpotCount(ac2, settings)).toBe(2);
    expect(sharesSpotPair(ac2, settings)).toBe(true);
    const counts = layoutStationCountsOfKinds([ac2, dc4]);
    expect(counts).not.toHaveProperty('widestSpan');
    expect(effectiveLayoutSettings(null, [], counts).spotsPerRow).toBe(10);
    expect(layoutStationKind([type2], 2, null)).toEqual({ charging: 'ac', depot: null, ports: 2 });
    expect(layoutStationKind([type2], 2, [])).toEqual({ charging: 'ac', depot: null, ports: 2 });
  });

  it('keeps the custom site spot count and its four-spot cap', () => {
    expect(stationFreeSpotCount(6)).toBe(freeSpotCount(6));
    expect(stationFreeSpotCount(6, { units: [] })).toBe(FREE_LAYOUT.maxSpots);
    expect(freeSpotRects(freeSpotCount(9))).toHaveLength(4);
  });
});

describe('custom site unit spots', () => {
  it('gives one car spot per unit EVSE, two per charger at most, up to 16', () => {
    const kind = kindOf({ units: boxes, evses: evses16 });
    expect(stationFreeSpotCount(16, kind)).toBe(16);
    expect(freeSpotRects(stationFreeSpotCount(16, kind))).toHaveLength(16);
    expect(
      stationFreeSpotCount(4, {
        units: [
          { charging: 'dc', ports: 4 },
          { charging: 'ac', ports: 1 },
        ],
      }),
    ).toBe(3);
    const many = Array.from({ length: 12 }, () => ({ charging: 'ac' as const, ports: 2 }));
    expect(stationFreeSpotCount(24, { units: many })).toBe(FREE_LAYOUT.maxUnitSpots);
  });
});

describe('accessible charging space at a unit station', () => {
  it('lets the end of a unit run hold the space, never a split system run', () => {
    const settings = lot();
    const slot = { x: 20, y: 20, charging: 'ac' as const, span: 16 };
    // A split system run (no unitRun) never holds it: the only station, so none.
    expect(accessibleChargingSpace([slot], settings)).toBeNull();
    const space = accessibleChargingSpace([{ ...slot, unitRun: true }], settings);
    expect(space?.aisle).toEqual({ col: 16, row: 0 });
    expect(space?.stall).toEqual({ col: 15, row: 0 });
  });
});

describe('units at a depot and on a street (owner decision 2026-11-12)', () => {
  const depot = effectiveLayoutSettings({
    siteType: 'depot',
    spotsPerRow: 1,
    rows: 1,
    facingDeg: 0,
    busBays: 6,
    truckLanes: 2,
    transformers: [],
  });
  const busUnits = {
    charging: 'dc' as const,
    depot: 'bus' as const,
    ports: 3,
    units: [
      { charging: 'dc' as const, ports: 1 },
      { charging: 'dc' as const, ports: 1 },
      { charging: 'dc' as const, ports: 1 },
    ],
  };

  it('gives each unit its own bus bay, contiguous, and keeps a station without units at one bay', () => {
    expect(stationSpanCount(busUnits, depot)).toBe(3);
    expect(stationSpanCount({ charging: 'dc', ports: 3 }, depot)).toBe(1);
    // Bays 0 and 1 held: the run takes bays 2 to 4.
    const slot = firstFreeDepotSlot(
      [{ ...bayToPosition({ col: 1, row: 0 }), charging: 'dc' }],
      depot,
      'bus',
      3,
    );
    expect(positionToBay(slot)).toEqual({ col: 2, row: 0 });
    // One bay as before.
    expect(
      positionToBay(firstFreeDepotSlot([{ ...bayToPosition({ col: 0, row: 0 }) }], depot, 'bus')),
    ).toEqual({ col: 1, row: 0 });
    // The depot defaults count a bay per unit.
    expect(layoutStationCountsOfKinds([busUnits]).bus).toBe(3);
    // A plug-in bus station of two or more EVSEs is a dual-outlet charger over two bays;
    // a pantograph station keeps one (owner decision 2026-11-12).
    expect(layoutStationCountsOfKinds([{ charging: 'dc', depot: 'bus', ports: 3 }]).bus).toBe(2);
    expect(
      layoutStationCountsOfKinds([{ charging: 'dc', depot: 'bus', ports: 2, overhead: true }]).bus,
    ).toBe(1);
  });

  it('moves a unit station whose run leaves its area to a free run of its own area', () => {
    const fit = fitDepotPositions(
      [
        { key: 'units', position: bayToPosition({ col: 4, row: 0 }), kind: busUnits },
        {
          key: 'one',
          position: bayToPosition({ col: 0, row: 0 }),
          kind: { charging: 'dc', depot: 'bus', ports: 1 },
        },
      ],
      depot,
    );
    expect(fit.unfit).toEqual([]);
    const moved = fit.moved.get('units');
    expect(moved != null ? positionToBay(moved) : null).toEqual({ col: 3, row: 0 });
    expect(fit.moved.has('one')).toBe(false);
  });

  it('lays a street out with the unit run along one curb', () => {
    const kind = {
      charging: 'ac' as const,
      depot: null,
      ports: 16,
      units: Array.from({ length: 8 }, () => ({ charging: 'ac' as const, ports: 2 })),
    };
    const counts = layoutStationCountsOfKinds([kind]);
    expect(counts.curbSpots).toBe(8);
    const street = effectiveLayoutSettings(
      { siteType: 'curbside', spotsPerRow: 10, rows: 2, facingDeg: 0, transformers: [] },
      [],
      counts,
    );
    expect(street.chargersLeft).toBe(8);
    expect(stationSpanCount(kind, street)).toBe(8);
    const slot = firstFreeSlotFor([], street, kind);
    expect(positionToBay(slot).col + 8).toBeLessThanOrEqual(street.chargersLeft ?? 0);
    // A street without units keeps its split over both curbs.
    const plain = effectiveLayoutSettings(
      { siteType: 'curbside', spotsPerRow: 10, rows: 2, facingDeg: 0, transformers: [] },
      [],
      layoutStationCountsOfKinds([{ charging: 'ac', depot: null, ports: 1 }, undefined, undefined]),
    );
    expect([plain.chargersLeft, plain.chargersRight]).toEqual([2, 1]);
  });
});

describe('dual-outlet depot bus charger (owner decision 2026-11-12)', () => {
  const depotShape = effectiveLayoutSettings({
    siteType: 'depot',
    spotsPerRow: 1,
    rows: 1,
    facingDeg: 0,
    busBays: 6,
    truckLanes: 0,
    transformers: [],
  });
  const ccs = (n: number) =>
    Array.from({ length: n }, () => ({ connectorType: 'CCS1', maxPowerKw: 150 }));

  it('holds two adjacent bus bays for a plug-in bus station of two EVSEs', () => {
    const kind = layoutStationKind(ccs(2), 2);
    expect(dualOutletBusCharger(kind)).toBe(true);
    expect(stationSpanCount(kind, depotShape)).toBe(DUAL_OUTLET_BUS_CHARGER.outlets);
    // Bay 1 held: the pair takes bays 2 and 3.
    const slot = firstFreeDepotSlot(
      [{ ...bayToPosition({ col: 1, row: 0 }), charging: 'dc' }],
      depotShape,
      'bus',
      stationSpanCount(kind, depotShape),
    );
    expect(positionToBay(slot)).toEqual({ col: 2, row: 0 });
  });

  it('keeps one bay for a one-EVSE bus charger, a pantograph pole and a megawatt dispenser', () => {
    expect(stationSpanCount(layoutStationKind(ccs(1), 1), depotShape)).toBe(1);
    const pantograph = layoutStationKind(
      [
        { connectorType: 'OppCharge', maxPowerKw: 450 },
        { connectorType: 'OppCharge', maxPowerKw: 450 },
      ],
      2,
    );
    expect(pantograph.overhead).toBe(true);
    expect(stationSpanCount(pantograph, depotShape)).toBe(1);
    const mcs = layoutStationKind(
      [
        { connectorType: 'MCS', maxPowerKw: 1200 },
        { connectorType: 'MCS', maxPowerKw: 1200 },
      ],
      2,
    );
    expect(stationSpanCount(mcs, depotShape)).toBe(1);
  });

  it('changes no other site type: a two-EVSE DC dispenser on a lot keeps its spot pair', () => {
    const kind = layoutStationKind(ccs(2), 2);
    expect(
      stationSpanCount(kind, effectiveLayoutSettings({ ...depotShape, siteType: 'parking_lot' })),
    ).toBe(1);
  });
});

describe('two-port curb post (owner decision 2026-11-12)', () => {
  const street = effectiveLayoutSettings({
    siteType: 'curbside',
    spotsPerRow: 8,
    rows: 2,
    facingDeg: 0,
    chargersLeft: 8,
    chargersRight: 0,
    transformers: [],
  });
  const type1 = (n: number) =>
    Array.from({ length: n }, () => ({ connectorType: 'Type1', maxPowerKw: 7 }));

  it('holds two parallel spots for an AC station of two EVSEs and one for one EVSE', () => {
    const two = layoutStationKind(type1(2), 2);
    expect(twoPortCurbPost(two)).toBe(true);
    expect(stationSpanCount(two, street)).toBe(TWO_PORT_CURB_POST.outlets);
    expect(stationSpanCount(layoutStationKind(type1(1), 1), street)).toBe(1);
    // DC at a curb keeps one post; a lot keeps its spot pair rule.
    expect(
      stationSpanCount(
        layoutStationKind(
          [
            { connectorType: 'CCS1', maxPowerKw: 50 },
            { connectorType: 'CCS1', maxPowerKw: 50 },
          ],
          2,
        ),
        street,
      ),
    ).toBe(1);
    expect(
      stationSpanCount(two, effectiveLayoutSettings({ ...street, siteType: 'parking_lot' })),
    ).toBe(1);
  });

  it('counts two curb spots for it in the street defaults, none set without one', () => {
    const counts = layoutStationCountsOfKinds([
      layoutStationKind(type1(2), 2),
      layoutStationKind(type1(1), 1),
    ]);
    expect(counts.curbSpots).toBe(3);
    expect(counts.widestCurbRun).toBe(2);
    expect(counts.widestSpan).toBeUndefined();
    const plain = layoutStationCountsOfKinds([layoutStationKind(type1(1), 1)]);
    expect(plain.curbSpots).toBeUndefined();
  });
});
