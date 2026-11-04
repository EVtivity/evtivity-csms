// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYOUT_GRID,
  TRANSFORMER_CLEARANCE_M,
  assignBays,
  bayInLayout,
  bayToPosition,
  cardsOverlap,
  effectiveLayoutSettings,
  firstFreeSlot,
  fitPositionsToGrid,
  freeSlotsFor,
  gridBoardExtent,
  layoutCapacity,
  layoutRowLengths,
  showsBatteries,
  showsLoadPanels,
  layoutFacingOf,
  chargerMountingOf,
  withSiteType,
  STANDARD_DIMENSIONS,
  layoutGridOf,
  lotExtentM,
  nearestFreeBay,
  positionToBay,
  resolveCardDrop,
  sameLayoutGrid,
  sameLayoutSettings,
  showsSolar,
  showsTransformers,
  siteTypeOf,
  ENERGY_ASSET_TYPES,
  LAYOUT_GRID_LIMITS,
  energyAssetsOf,
  placeEnergyAsset,
  placePowerEquipment,
  placeEnergyAssetPositions,
  layoutEquipmentPoint,
  layoutPositionsOf,
  newBatteryPoint,
  newTransformerPoint,
  NO_POWER_EQUIPMENT,
  type LayoutBattery,
  type LayoutPowerEquipment,
  type LayoutSolarCanopy,
  SITE_TYPES,
  type SiteLayoutSettings,
  snapTransformerToGrass,
  FREE_LAYOUT,
  firstFreePlacement,
  freeFootprint,
  freeFootprintsOverlap,
  fitFreePlacementsInReach,
  freePlacementFromSlot,
  freeSolarPlacement,
  freeSpotCount,
  freeStationsBox,
  freeToSite,
  normalizeRotationDeg,
  overlappingFreeStations,
  resolveFreeOverlaps,
  snapFreePlacement,
  solarCanopySize,
  usesFreePositions,
  FREE_SPOT_DEFAULT_BODY_TYPE,
  FREE_SPOT_DIMENSIONS,
  FREE_SPOT_TYPES,
  freeSpotRects,
  freeSpotsExtent,
  freeSpotTypeOf,
  isFreeSpotType,
  DEPOT_LAYOUT,
  depotDriveLaneM,
  DEPOT_ROWS,
  depotLayout,
  depotSlotPlacement,
  depotStationKind,
  firstFreeDepotSlot,
  fitDepotPositions,
  firstFreeSlotFor,
  fitGroupedPositions,
  groupedSpotOrder,
  layoutStationCountsOfKinds,
  spotVehicleBodyType,
  usesDepotSpots,
} from '../site-layout.js';
import type { FreePlacement, LayoutPoint } from '../site-layout.js';
import { freePlacementSchema, siteLayoutSettingsSchema } from '../site-layout-schema.js';

describe('site layout grid', () => {
  it('maps a slot to px and back', () => {
    expect(bayToPosition({ col: 0, row: 0 })).toEqual({ x: 20, y: 20 });
    expect(bayToPosition({ col: 2, row: 1 })).toEqual({ x: 420, y: 160 });
    expect(positionToBay({ x: 420, y: 160 })).toEqual({ col: 2, row: 1 });
    expect(positionToBay({ x: 0, y: 0 })).toEqual({ col: 0, row: 0 });
    expect(positionToBay({ x: 500, y: 230 })).toEqual({ col: 2, row: 2 });
  });

  it('tells overlapping card footprints apart', () => {
    expect(cardsOverlap({ x: 20, y: 20 }, { x: 100, y: 60 })).toBe(true);
    expect(cardsOverlap({ x: 20, y: 20 }, { x: 220, y: 20 })).toBe(false);
    expect(cardsOverlap({ x: 20, y: 20 }, { x: 20, y: 160 })).toBe(false);
  });

  it('picks the first free slot row by row', () => {
    expect(firstFreeSlot([])).toEqual({ x: 20, y: 20 });
    expect(firstFreeSlot([{ x: 20, y: 20 }])).toEqual({ x: 220, y: 20 });
    // A card placed off the grid blocks every slot it overlaps.
    expect(firstFreeSlot([{ x: 120, y: 20 }])).toEqual({ x: 420, y: 20 });
    // The default lot has 10 spots in a row.
    const firstFive = [0, 1, 2, 3, 4].map((col) => bayToPosition({ col, row: 0 }));
    expect(firstFreeSlot(firstFive)).toEqual({ x: 1020, y: 20 });
    // A lot of 5 spots per row continues on the next row, and below a full lot.
    const five = { ...DEFAULT_LAYOUT_GRID, spotsPerRow: 5, rows: 1 };
    expect(firstFreeSlot(firstFive, five)).toEqual({ x: 20, y: 160 });
  });

  it('uses the default lot of 2 rows of 10 spots, grown to hold the stations, with no equipment positions', () => {
    const fresh = effectiveLayoutSettings(null);
    expect(fresh).toEqual(expect.objectContaining({ spotsPerRow: 10, rows: 2, facingDeg: 0 }));
    expect(fresh).not.toHaveProperty('spotWidthM');
    expect(fresh.transformers).toEqual([]);
    // The equipment point stands on the grass right of the lot.
    const t = layoutEquipmentPoint(fresh);
    expect(t.x).toBeGreaterThanOrEqual(lotExtentM(fresh).width + TRANSFORMER_CLEARANCE_M);
    const grown = effectiveLayoutSettings(null, [{ col: 12, row: 3 }]);
    expect(grown).toMatchObject({ spotsPerRow: 13, rows: 4 });
    // Stored settings stay as stored, with transformers kept on the grass.
    const stored = {
      ...DEFAULT_LAYOUT_GRID,
      spotsPerRow: 4,
      rows: 1,
      transformers: [{ id: 'a', x: 2, z: 2 }],
    };
    const kept = effectiveLayoutSettings(stored, [{ col: 30, row: 9 }]);
    expect(kept.spotsPerRow).toBe(4);
    expect(kept.transformers[0]).toMatchObject({ x: -2.5, z: 2 });
    expect(layoutCapacity(kept)).toBe(4);
  });

  it('moves a transformer off the lot to the nearest side and keeps it within reach', () => {
    const grid = { ...DEFAULT_LAYOUT_GRID, spotsPerRow: 2, rows: 1 };
    // Lot 5.2 by 5.5 m (standard spots).
    expect(lotExtentM(grid)).toEqual({ width: 5.2, depth: 5.5 });
    expect(snapTransformerToGrass(5, 3, grid)).toEqual({ x: 7.7, z: 3 });
    expect(snapTransformerToGrass(0.5, 3, grid)).toEqual({ x: -2.5, z: 3 });
    expect(snapTransformerToGrass(3, 5, grid)).toEqual({ x: 3, z: 8 });
    expect(snapTransformerToGrass(20, -9, grid)).toEqual({ x: 20, z: -9 });
    expect(snapTransformerToGrass(1e6, 0, grid).x).toBe(205.2);
  });

  it('fits stations into a smaller lot, refusing those with no free spot', () => {
    const grid = { ...DEFAULT_LAYOUT_GRID, spotsPerRow: 2, rows: 1 };
    const fit = fitPositionsToGrid(
      [
        { key: 'a', position: bayToPosition({ col: 0, row: 0 }) },
        { key: 'b', position: bayToPosition({ col: 4, row: 0 }) },
        { key: 'c', position: bayToPosition({ col: 3, row: 2 }) },
      ],
      grid,
    );
    expect(fit.moved.get('b')).toEqual(bayToPosition({ col: 1, row: 0 }));
    expect(fit.moved.has('a')).toBe(false);
    expect(fit.unfit).toEqual(['c']);
    expect(bayInLayout({ col: 1, row: 0 }, grid)).toBe(true);
    expect(bayInLayout({ col: 2, row: 0 }, grid)).toBe(false);
    expect(gridBoardExtent(grid)).toEqual({ width: 380, height: 140 });
  });

  it('compares settings field by field, transformer positions included', () => {
    const a = { ...effectiveLayoutSettings(null), transformers: [{ id: 'tfm_a', x: 30, z: 2 }] };
    expect(sameLayoutSettings(a, { ...a, transformers: [...a.transformers] })).toBe(true);
    expect(sameLayoutSettings(a, { ...a, facingDeg: 90 })).toBe(false);
    expect(sameLayoutSettings(a, { ...a, transformers: [] })).toBe(false);
    expect(sameLayoutSettings(a, { ...a, transformers: [{ id: 'tfm_a', x: 30, z: 3 }] })).toBe(
      false,
    );
    expect(sameLayoutSettings(a, { ...a, transformers: [{ id: 'tfm_b', x: 30, z: 2 }] })).toBe(
      false,
    );
    expect(sameLayoutSettings(a, { ...a, siteType: 'office_retail' })).toBe(false);
    expect(sameLayoutGrid(layoutGridOf(a), DEFAULT_LAYOUT_GRID)).toBe(true);
  });

  it('reads settings without a site type as a parking lot, and keeps a stored one', () => {
    expect(effectiveLayoutSettings(null).siteType).toBe('parking_lot');
    const legacy: SiteLayoutSettings = {
      ...effectiveLayoutSettings(null),
      transformers: [{ id: 'tfm_a', x: 30, z: 2 }],
    };
    delete legacy.siteType;
    expect(siteTypeOf(legacy)).toBe('parking_lot');
    expect(effectiveLayoutSettings(legacy).siteType).toBe('parking_lot');
    // Stored before the site type existed and the same settings with the default compare equal.
    expect(sameLayoutSettings(legacy, { ...legacy, siteType: 'parking_lot' })).toBe(true);
    const office = effectiveLayoutSettings({ ...legacy, siteType: 'office_retail' });
    expect(office.siteType).toBe('office_retail');
    // The transformers stay in the settings, hidden on an office or retail site.
    expect(office.transformers).toHaveLength(1);
    expect(showsTransformers(office)).toBe(false);
    expect(showsTransformers(legacy)).toBe(true);
  });

  describe('AC and DC grouping', () => {
    const AC = { charging: 'ac', depot: null } as const;
    const DC = { charging: 'dc', depot: 'bus' } as const;
    const lot = (transformerX: number) =>
      effectiveLayoutSettings({
        siteType: 'parking_lot',
        spotsPerRow: 10,
        rows: 2,
        facingDeg: 0,
        transformers: [{ id: 'tx', x: transformerX, z: 2.5 }],
      });
    const rowOf = (kinds: Map<string, 'ac' | 'dc'>, row: number, slots: Map<string, LayoutPoint>) =>
      [...slots]
        .map(([k, p]) => ({ k, bay: positionToBay(p) }))
        .filter((b) => b.bay.row === row)
        .sort((a, b) => a.bay.col - b.bay.col)
        .map((b) => kinds.get(b.k));
    const interleaved = (seq: Array<string | undefined>): boolean => {
      // AC and DC never alternate more than once along a row.
      let changes = 0;
      for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes++;
      return changes > 1;
    };

    it('puts the DC stations next to the transformer and the AC stations at the far end', () => {
      const s = lot(30);
      const order: Array<'ac' | 'dc'> = [
        'ac',
        'dc',
        'ac',
        'dc',
        'dc',
        'ac',
        'ac',
        'dc',
        'ac',
        'dc',
      ];
      const slots = freeSlotsFor(
        order.map((k) => (k === 'dc' ? DC : AC)),
        [],
        s,
      );
      const kinds = new Map(order.map((k, i) => [String(i), k]));
      const byKey = new Map(slots.map((p, i) => [String(i), p]));
      for (const row of [0, 1]) expect(interleaved(rowOf(kinds, row, byKey))).toBe(false);
      // The transformer stands right of the lot: DC at the right end, AC at the left.
      const dcCols = slots.filter((_, i) => order[i] === 'dc').map((p) => positionToBay(p).col);
      const acCols = slots.filter((_, i) => order[i] === 'ac').map((p) => positionToBay(p).col);
      expect(Math.min(...dcCols)).toBeGreaterThan(Math.max(...acCols));
      // A transformer left of the lot turns it around.
      const left = freeSlotsFor([DC], [], lot(-5));
      expect(positionToBay(left[0]!).col).toBe(0);
    });

    it('lets a new station join its own group first', () => {
      const s = lot(30);
      const placed = freeSlotsFor([DC, DC, AC, AC], [], s);
      const nextDc = firstFreeSlotFor(placed, s, DC);
      const nextAc = firstFreeSlotFor(placed, s, AC);
      const dcBays = placed.slice(0, 2).map(positionToBay);
      const acBays = placed.slice(2).map(positionToBay);
      expect(positionToBay(nextDc).col).toBeGreaterThanOrEqual(
        Math.min(...dcBays.map((b) => b.col)) - 1,
      );
      expect(positionToBay(nextAc).col).toBeLessThanOrEqual(
        Math.max(...acBays.map((b) => b.col)) + 1,
      );
      expect(groupedSpotOrder(s, 'dc')[0]).toEqual({ col: 9, row: 0 });
      expect(groupedSpotOrder(s, 'ac')[0]).toEqual({ col: 0, row: 1 });
    });

    it('never puts a station inside the other kind range: it goes below the layout instead', () => {
      const s = lot(30);
      // 20 spots: automatic placement continues a run through the access
      // aisle, so every spot takes a station.
      const capacity = 20;
      // 15 AC stations fill from the far end, then 5 DC fill the spots nearest the transformer.
      const ac = freeSlotsFor(
        Array.from({ length: 15 }, () => AC),
        [],
        s,
      );
      const placed = [
        ...ac.map((p) => ({ ...p, charging: 'ac' as const })),
        ...freeSlotsFor(
          Array.from({ length: 5 }, () => DC),
          ac.map((p) => ({ ...p, charging: 'ac' as const })),
          s,
        ).map((p) => ({ ...p, charging: 'dc' as const })),
      ];
      expect(placed.every((p) => bayInLayout(positionToBay(p), s))).toBe(true);
      expect(placed).toHaveLength(capacity);
      // The lot is full: both kinds go below it.
      expect(bayInLayout(positionToBay(firstFreeSlotFor(placed, s, DC)), s)).toBe(false);
      expect(bayInLayout(positionToBay(firstFreeSlotFor(placed, s, AC)), s)).toBe(false);

      // One AC station at the far end and free spots between: a DC station
      // past the DC range (every spot up to the AC one) takes none beyond it.
      const far = groupedSpotOrder(s, 'ac')[0]!;
      const oneAc = [{ ...bayToPosition(far), charging: 'ac' as const }];
      const dcSlots = freeSlotsFor(
        Array.from({ length: 19 }, () => DC),
        oneAc,
        s,
      );
      expect(dcSlots.every((p) => bayInLayout(positionToBay(p), s))).toBe(true);
      // The next DC station finds the AC spot next in its order and stops there.
      const next = firstFreeSlotFor(
        [...oneAc, ...dcSlots.map((p) => ({ ...p, charging: 'dc' as const }))],
        s,
        DC,
      );
      expect(bayInLayout(positionToBay(next), s)).toBe(false);

      // A DC station holds the far end: a new AC station does not walk past it.
      const dcFar = [{ ...bayToPosition(far), charging: 'dc' as const }];
      expect(bayInLayout(positionToBay(firstFreeSlotFor(dcFar, s, AC)), s)).toBe(false);
      // Without kinds (connectors unknown), the slot rule stays row by row.
      expect(bayInLayout(positionToBay(firstFreeSlotFor([bayToPosition(far)], s, AC)), s)).toBe(
        true,
      );
    });

    it('regroups interleaved stations when the site type changes, keeping grouped ones', () => {
      const s = withSiteType(lot(30), 'office_retail', 6);
      const at = (col: number) => bayToPosition({ col, row: 0 });
      const stations = [
        { key: 'a', position: at(0), kind: DC },
        { key: 'b', position: at(1), kind: AC },
        { key: 'c', position: at(2), kind: DC },
        { key: 'd', position: at(3), kind: AC },
        { key: 'e', position: at(4), kind: DC },
        { key: 'f', position: at(5), kind: AC },
      ];
      const fit = fitGroupedPositions(stations, s);
      const final = new Map(
        stations.map((st) => [st.key, positionToBay(fit.moved.get(st.key) ?? st.position)]),
      );
      const seq = [...final]
        .sort((x, y) => x[1].col - y[1].col)
        .map(([k]) => stations.find((st) => st.key === k)?.kind.charging);
      expect(interleaved(seq)).toBe(false);
      expect(fit.unfit).toEqual([]);
      // Already grouped: nothing moves.
      const grouped = fitGroupedPositions(
        [
          { key: 'a', position: at(0), kind: AC },
          { key: 'b', position: at(5), kind: DC },
        ],
        s,
      );
      expect(grouped.moved.size).toBe(0);
    });

    it('moves nothing on a custom site', () => {
      const s = withSiteType(lot(30), 'custom', 2);
      const fit = fitGroupedPositions(
        [
          { key: 'a', position: bayToPosition({ col: 0, row: 0 }), kind: DC },
          { key: 'b', position: bayToPosition({ col: 1, row: 0 }), kind: AC },
        ],
        s,
      );
      expect(fit.moved.size).toBe(0);
    });
  });

  it('hands out distinct slots for several unplaced stations', () => {
    const slots = freeSlotsFor(3, [{ x: 220, y: 20 }]);
    expect(slots).toEqual([
      { x: 20, y: 20 },
      { x: 420, y: 20 },
      { x: 620, y: 20 },
    ]);
  });

  it('snaps a 2D drop to the 20 px grid inside the board', () => {
    const bounds = { width: 800, height: 700 };
    expect(resolveCardDrop({ x: 47, y: 31 }, [], bounds, { x: 0, y: 0 })).toEqual({ x: 40, y: 40 });
    // Right and bottom edges clamp so the card ends inside the board.
    expect(resolveCardDrop({ x: 2000, y: 2000 }, [], bounds, { x: 0, y: 0 })).toEqual({
      x: 640,
      y: 580,
    });
    expect(resolveCardDrop({ x: -50, y: -50 }, [], bounds, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('moves a 2D drop off another card to the nearest free grid point', () => {
    const bounds = { width: 800, height: 700 };
    const drop = resolveCardDrop({ x: 40, y: 40 }, [{ x: 20, y: 20 }], bounds, { x: 400, y: 400 });
    expect(cardsOverlap(drop, { x: 20, y: 20 })).toBe(false);
    expect(drop.x % 20).toBe(0);
    expect(drop.y % 20).toBe(0);
    // The nearest free point is just below or right of the other card.
    expect(Math.hypot(drop.x - 40, drop.y - 40)).toBeLessThanOrEqual(120);
  });

  it('keeps the card where it was when the board has no free point', () => {
    const bounds = { width: 160, height: 120 };
    expect(resolveCardDrop({ x: 0, y: 0 }, [{ x: 0, y: 0 }], bounds, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
    });
  });

  it('gives each station its own bay in 3D, the later one moving to the nearest free bay', () => {
    const bays = assignBays(
      [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
        { x: 220, y: 20 },
      ],
      5,
    );
    expect(bays[0]).toEqual({ col: 0, row: 0 });
    expect(bays[1]).toEqual({ col: 1, row: 0 });
    expect(new Set(bays.map((b) => `${String(b.col)}:${String(b.row)}`)).size).toBe(3);
  });

  it('drops a 3D station on the nearest free bay inside the lot', () => {
    expect(nearestFreeBay({ col: 1, row: 0 }, [], [5, 5])).toEqual({ col: 1, row: 0 });
    expect(nearestFreeBay({ col: 9, row: 9 }, [], [5, 5])).toEqual({ col: 4, row: 1 });
    expect(nearestFreeBay({ col: 0, row: 0 }, [{ col: 0, row: 0 }], [2])).toEqual({
      col: 1,
      row: 0,
    });
    expect(
      nearestFreeBay(
        { col: 0, row: 0 },
        [
          { col: 0, row: 0 },
          { col: 1, row: 0 },
        ],
        [2],
      ),
    ).toBeNull();
    // A street with no charger on the left curb: a drop there goes to the right curb.
    expect(nearestFreeBay({ col: 0, row: 0 }, [], [0, 3])).toEqual({ col: 0, row: 1 });
  });
});

describe('site layout settings schema', () => {
  const valid = effectiveLayoutSettings(null);

  it('accepts the default settings and a transformer position by id, never a name or a rating', () => {
    expect(siteLayoutSettingsSchema.safeParse(valid).success).toBe(true);
    const positioned = {
      ...valid,
      transformers: [{ id: 'tfm_0a1b2c3d4e5f', x: 40, z: 3 }],
    };
    expect(siteLayoutSettingsSchema.safeParse(positioned).success).toBe(true);
    for (const extra of [{ name: 'Main Feed' }, { ratedKva: 2500 }, { name: null }]) {
      expect(
        siteLayoutSettingsSchema.safeParse({
          ...valid,
          transformers: [{ id: 'tfm_a', x: 40, z: 3, ...extra }],
        }).success,
      ).toBe(false);
    }
  });

  it('takes either site type, or none (stored before the site type existed)', () => {
    for (const siteType of SITE_TYPES) {
      expect(siteLayoutSettingsSchema.safeParse({ ...valid, siteType }).success).toBe(true);
    }
    const legacy: SiteLayoutSettings = { ...valid };
    delete legacy.siteType;
    expect(siteLayoutSettingsSchema.safeParse(legacy).success).toBe(true);
  });

  it.each([
    ['spots out of range', { spotsPerRow: 0 }],
    ['rows out of range', { rows: 101 }],
    ['a spot width (standard size, no setting)', { spotWidthM: 2.6 }],
    ['a spot depth', { spotDepthM: 5.5 }],
    ['a lane width', { laneWidthM: 7 }],
    ['no charger on either curb', { siteType: 'curbside', chargersLeft: 0, chargersRight: 0 }],
    ['office chargers out of range', { chargers: 0 }],
    ['an unknown mounting', { mounting: 'ceiling' }],
    ['a curb count out of range', { chargersLeft: 101 }],
    ['facing not a quarter turn', { facingDeg: 45 }],
    ['unlimited rows', { rows: null }],
    ['an unknown key', { color: 'red' }],
    ['an unknown site type', { siteType: 'garage' }],
    ['a null site type', { siteType: null }],
  ])('refuses %s', (_name, patch) => {
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('refuses duplicate transformer ids, a point out of reach and more than 10 transformers', () => {
    const t = { id: 'a', x: 40, z: 0 };
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, transformers: [t, t] }).success).toBe(
      false,
    );
    expect(
      siteLayoutSettingsSchema.safeParse({ ...valid, transformers: [{ ...t, x: 1e6 }] }).success,
    ).toBe(false);
    expect(
      siteLayoutSettingsSchema.safeParse({ ...valid, transformers: [{ ...t, id: 'a b' }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...t, id: `t${String(i)}` }));
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, transformers: many }).success).toBe(
      false,
    );
  });
});

describe('site layout energy assets', () => {
  const base = effectiveLayoutSettings(null);
  const batteryAt = { id: 'ena_battery', x: 5, z: 2 };
  const solarAt = { id: 'ena_solar', row: 7 };
  const equipment: LayoutPowerEquipment = {
    transformers: [],
    energyAssets: [
      { id: 'ena_battery', type: 'battery', name: 'Storage', capacityKwh: 500, peakKwp: null },
      { id: 'ena_solar', type: 'solar', name: 'Carport', capacityKwh: null, peakKwp: 120 },
    ],
  };

  it('reads absent energy assets as none, and a site without settings gets none', () => {
    expect(ENERGY_ASSET_TYPES).toEqual(['battery', 'solar']);
    expect(LAYOUT_GRID_LIMITS.energyAssets.max).toBe(10);
    expect(base.energyAssets).toEqual([]);
    const legacy: SiteLayoutSettings = { ...base };
    delete legacy.energyAssets;
    expect(energyAssetsOf(legacy)).toEqual([]);
    expect(effectiveLayoutSettings(legacy).energyAssets).toEqual([]);
    expect(sameLayoutSettings(legacy, base)).toBe(true);
  });

  it('clamps a stored solar row into the lot and leaves the rest of a position as stored', () => {
    const effective = effectiveLayoutSettings({ ...base, energyAssets: [batteryAt, solarAt] });
    expect(effective.energyAssets).toEqual([batteryAt, { ...solarAt, row: base.rows - 1 }]);
    const oneRow = effectiveLayoutSettings({ ...base, rows: 1, energyAssets: [solarAt] });
    expect(oneRow.energyAssets?.[0]).toEqual({ ...solarAt, row: 0 });
  });

  it('joins the table rows: the type, name and capacity from the table, the place by type', () => {
    const placed = placePowerEquipment(
      effectiveLayoutSettings({ ...base, energyAssets: [batteryAt, solarAt] }),
      equipment,
    );
    const [b, s] = placed.energyAssets;
    // A battery on the lot moves to the grass; a canopy covers its (clamped) row.
    expect(b).toEqual({
      id: 'ena_battery',
      type: 'battery',
      name: 'Storage',
      capacityKwh: 500,
      ...snapTransformerToGrass(batteryAt.x, batteryAt.z, base),
    });
    expect(b?.type === 'battery' && b.z).toBe(-TRANSFORMER_CLEARANCE_M);
    expect(s).toEqual({
      id: 'ena_solar',
      type: 'solar',
      name: 'Carport',
      capacityKwp: 120,
      row: base.rows - 1,
    });
    expect(placeEnergyAsset({ ...(s as LayoutSolarCanopy), row: 0 }, base)).toMatchObject({
      row: 0,
    });
  });

  it('gives equipment without a position the default place of its type, in table order', () => {
    const placed = placePowerEquipment(base, equipment);
    expect(placed.energyAssets[0]).toMatchObject({ type: 'battery', ...newBatteryPoint(base, 0) });
    // The first row without a canopy.
    expect(placed.energyAssets[1]).toMatchObject({ type: 'solar', row: 0 });
    expect(placed.energyAssets[1]).not.toHaveProperty('x');
    const two = placePowerEquipment(base, {
      transformers: [],
      energyAssets: [equipment.energyAssets[1]!, { ...equipment.energyAssets[1]!, id: 'ena_s2' }],
    });
    expect(two.energyAssets.map((a) => a.type === 'solar' && a.row)).toEqual([0, 1]);
  });

  it('places stored positions by the table type without filling in defaults', () => {
    const types = new Map([
      ['ena_battery', 'battery' as const],
      ['ena_solar', 'solar' as const],
    ]);
    const placed = placeEnergyAssetPositions(
      { ...base, energyAssets: [batteryAt, solarAt, { id: 'ena_unknown', x: 2, z: 2 }] },
      types,
    );
    expect(placed.energyAssets).toEqual([
      { id: 'ena_battery', ...snapTransformerToGrass(batteryAt.x, batteryAt.z, base) },
      { id: 'ena_solar', row: base.rows - 1 },
      { id: 'ena_unknown', x: 2, z: 2 },
    ]);
    expect(placeEnergyAssetPositions(base, types)).toEqual(base);
  });

  it('leaves out a stored position whose equipment is gone', () => {
    const placed = placePowerEquipment(
      { ...base, energyAssets: [{ id: 'ena_gone', x: 1, z: 1 }, batteryAt] },
      equipment,
    );
    expect(placed.energyAssets.map((a) => a.id)).toEqual(['ena_battery', 'ena_solar']);
    expect(layoutPositionsOf(placed).energyAssets).toEqual([
      { id: 'ena_battery', ...snapTransformerToGrass(batteryAt.x, batteryAt.z, base) },
      { id: 'ena_solar', row: 0 },
    ]);
  });

  it('shows solar only on a parking lot and compares energy asset positions field by field', () => {
    expect(showsSolar(base)).toBe(true);
    expect(showsSolar({ ...base, siteType: 'office_retail' })).toBe(false);
    const a = { ...base, energyAssets: [batteryAt, solarAt] };
    expect(sameLayoutSettings(a, { ...base, energyAssets: [batteryAt, solarAt] })).toBe(true);
    expect(sameLayoutSettings(a, { ...base, energyAssets: [solarAt, batteryAt] })).toBe(false);
    expect(
      sameLayoutSettings(a, { ...base, energyAssets: [batteryAt, { ...solarAt, row: 0 }] }),
    ).toBe(false);
    expect(
      sameLayoutSettings(a, { ...base, energyAssets: [{ ...batteryAt, x: 6 }, solarAt] }),
    ).toBe(false);
    expect(sameLayoutSettings(a, base)).toBe(false);
  });

  it('accepts positions by id in the schema and refuses a type, a name, a capacity or a half point', () => {
    const parse = (energyAssets: unknown) =>
      siteLayoutSettingsSchema.safeParse({ ...base, energyAssets }).success;
    expect(parse([batteryAt, solarAt])).toBe(true);
    expect(parse([{ id: 'ena_x' }])).toBe(true);
    expect(parse(undefined)).toBe(true);
    expect(parse([batteryAt, { ...solarAt, id: 'ena_battery' }])).toBe(false);
    expect(parse([{ ...batteryAt, type: 'battery' }])).toBe(false);
    expect(parse([{ ...batteryAt, name: 'Storage' }])).toBe(false);
    expect(parse([{ ...batteryAt, capacityKwh: 500 }])).toBe(false);
    expect(parse([{ id: 'ena_x', x: 1 }])).toBe(false);
    expect(parse([{ ...solarAt, row: -1 }])).toBe(false);
    expect(parse([{ ...solarAt, row: 100 }])).toBe(false);
    expect(parse([{ ...solarAt, x: 1e6, z: 0 }])).toBe(false);
    expect(parse([{ ...solarAt, rotationDeg: 360 }])).toBe(false);
    expect(
      parse(Array.from({ length: 11 }, (_, i) => ({ ...batteryAt, id: `b${String(i)}` }))),
    ).toBe(false);
  });
});

describe('site layout power equipment', () => {
  const base = effectiveLayoutSettings(null);
  const service = (id: string, name: string) => ({
    id,
    kind: 'service' as const,
    name,
    ratedKva: 1500,
    maxContinuousKw: 1425,
  });

  it('places each service transformer at its stored point, else at its default point', () => {
    const settings = effectiveLayoutSettings({
      ...base,
      transformers: [{ id: 'tfm_b', x: 40, z: 3 }],
    });
    const placed = placePowerEquipment(settings, {
      transformers: [service('tfm_a', 'Main'), service('tfm_b', 'Second')],
      energyAssets: [],
    });
    expect(placed.transformers).toEqual([
      { ...service('tfm_a', 'Main'), ...newTransformerPoint(settings, 0) },
      { ...service('tfm_b', 'Second'), x: 40, z: 3 },
    ]);
    // The first default point is where the equipment stands without one.
    expect(newTransformerPoint(base, 0)).toEqual(layoutEquipmentPoint(base));
    expect(layoutPositionsOf(placed).transformers).toEqual([
      { id: 'tfm_a', ...newTransformerPoint(settings, 0) },
      { id: 'tfm_b', x: 40, z: 3 },
    ]);
  });

  it('leaves out step-down transformers and stored points of deleted transformers', () => {
    const placed = placePowerEquipment(
      { ...base, transformers: [{ id: 'tfm_gone', x: 40, z: 3 }] },
      {
        transformers: [
          service('tfm_a', 'Main'),
          { ...service('tfm_sd', 'Step-Down'), kind: 'step_down' },
        ],
        energyAssets: [],
      },
    );
    expect(placed.transformers.map((t) => t.id)).toEqual(['tfm_a']);
    expect(placePowerEquipment(base, NO_POWER_EQUIPMENT).transformers).toEqual([]);
  });
});

describe('site types', () => {
  const lot = effectiveLayoutSettings(null);

  it('lists the spots of each row per site type', () => {
    expect(layoutRowLengths(lot)).toEqual([10, 10]);
    expect(layoutRowLengths({ ...lot, siteType: 'office_retail', chargers: 12 })).toEqual([12]);
    expect(
      layoutRowLengths({ ...lot, siteType: 'curbside', chargersLeft: 0, chargersRight: 6 }),
    ).toEqual([0, 6]);
    const street = { ...lot, siteType: 'curbside' as const, chargersLeft: 4, chargersRight: 6 };
    expect(layoutCapacity(street)).toBe(10);
    expect(bayInLayout({ col: 3, row: 0 }, street)).toBe(true);
    expect(bayInLayout({ col: 4, row: 0 }, street)).toBe(false);
    expect(bayInLayout({ col: 5, row: 1 }, street)).toBe(true);
    expect(bayInLayout({ col: 0, row: 2 }, street)).toBe(false);
    // The 2D board takes the longest curb and both rows.
    expect(gridBoardExtent(street)).toEqual({ width: 1180, height: 280 });
  });

  it('fills office and curbside fields from the station count', () => {
    const office = effectiveLayoutSettings({ ...lot, siteType: 'office_retail' }, [], 7);
    expect(office.chargers).toBe(7);
    expect(office.mounting).toBe('wall');
    expect(chargerMountingOf(office)).toBe('wall');
    expect(effectiveLayoutSettings({ ...lot, siteType: 'office_retail' }, []).chargers).toBe(1);
    const street = effectiveLayoutSettings({ ...lot, siteType: 'curbside' }, [], 7);
    expect([street.chargersLeft, street.chargersRight]).toEqual([4, 3]);
    const one = effectiveLayoutSettings({ ...lot, siteType: 'curbside' }, [], 1);
    expect([one.chargersLeft, one.chargersRight]).toEqual([1, 0]);
    const leftOnly = effectiveLayoutSettings(
      { ...lot, siteType: 'curbside', chargersLeft: 0 },
      [],
      1,
    );
    expect([leftOnly.chargersLeft, leftOnly.chargersRight]).toEqual([0, 1]);
    const rightGiven = effectiveLayoutSettings(
      { ...lot, siteType: 'curbside', chargersRight: 2 },
      [],
      6,
    );
    expect([rightGiven.chargersLeft, rightGiven.chargersRight]).toEqual([4, 2]);
    // A stored count stays.
    expect(
      effectiveLayoutSettings({ ...lot, siteType: 'office_retail', chargers: 3 }, [], 9).chargers,
    ).toBe(3);
    // A parking lot gets no fields of the other types.
    expect(effectiveLayoutSettings(lot, [], 5)).not.toHaveProperty('chargers');
  });

  it('drops the spot and lane sizes of earlier builds', () => {
    const stored = {
      ...lot,
      spotWidthM: 3.2,
      spotDepthM: 5.6,
      laneWidthM: 6,
    } as SiteLayoutSettings;
    const read = effectiveLayoutSettings(stored);
    expect(read).not.toHaveProperty('spotWidthM');
    expect(read).not.toHaveProperty('spotDepthM');
    expect(read).not.toHaveProperty('laneWidthM');
    expect(siteLayoutSettingsSchema.safeParse(read).success).toBe(true);
  });

  it('keeps the fields of the other types when the type changes', () => {
    const office = withSiteType({ ...lot, chargersLeft: 2, chargersRight: 3 }, 'office_retail', 4);
    expect(office).toMatchObject({
      siteType: 'office_retail',
      chargers: 4,
      mounting: 'wall',
      chargersLeft: 2,
      chargersRight: 3,
      spotsPerRow: 10,
      rows: 2,
    });
    const back = withSiteType({ ...office, mounting: 'stall' }, 'parking_lot', 4);
    expect(back).toMatchObject({ siteType: 'parking_lot', chargers: 4, mounting: 'stall' });
    expect(layoutRowLengths(back)).toEqual([10, 10]);
  });

  it('compares the type fields', () => {
    const office = effectiveLayoutSettings({ ...lot, siteType: 'office_retail' }, [], 2);
    expect(sameLayoutSettings(office, { ...office })).toBe(true);
    expect(sameLayoutSettings(office, { ...office, chargers: 3 })).toBe(false);
    expect(sameLayoutSettings(office, { ...office, mounting: 'stall' })).toBe(false);
    expect(sameLayoutSettings(office, { ...office, chargersLeft: 1 })).toBe(false);
    expect(sameLayoutSettings(office, { ...office, chargersRight: 1 })).toBe(false);
  });

  it('shows transformers, energy assets and panels and turns by the facing on a parking lot only', () => {
    for (const siteType of ['office_retail', 'curbside'] as const) {
      const s = { ...lot, siteType, facingDeg: 90 as const };
      expect(showsTransformers(s)).toBe(false);
      expect(showsBatteries(s)).toBe(false);
      expect(showsSolar(s)).toBe(false);
      // An office or retail site hangs its AC panelboards on the facade.
      expect(showsLoadPanels(s)).toBe(siteType === 'office_retail');
      expect(layoutFacingOf(s)).toBe(0);
    }
    expect(showsBatteries(lot)).toBe(true);
    expect(showsLoadPanels(lot)).toBe(true);
    expect(layoutFacingOf({ ...lot, facingDeg: 90 })).toBe(90);
  });

  it('fits stations into an office row and a street, refusing those with no free spot', () => {
    const office = { ...lot, siteType: 'office_retail' as const, chargers: 2 };
    const fit = fitPositionsToGrid(
      [
        { key: 'a', position: bayToPosition({ col: 0, row: 1 }) },
        { key: 'b', position: bayToPosition({ col: 1, row: 1 }) },
        { key: 'c', position: bayToPosition({ col: 2, row: 1 }) },
      ],
      office,
    );
    expect(fit.moved.get('a')).toEqual(bayToPosition({ col: 0, row: 0 }));
    expect(fit.moved.get('b')).toEqual(bayToPosition({ col: 1, row: 0 }));
    expect(fit.unfit).toEqual(['c']);
    // A street without left chargers places on the right curb, then below it.
    const street = { ...lot, siteType: 'curbside' as const, chargersLeft: 0, chargersRight: 1 };
    expect(firstFreeSlot([], street)).toEqual(bayToPosition({ col: 0, row: 1 }));
    expect(firstFreeSlot([bayToPosition({ col: 0, row: 1 })], street)).toEqual(
      bayToPosition({ col: 0, row: 2 }),
    );
  });

  it('draws with standard dimensions', () => {
    expect(STANDARD_DIMENSIONS).toMatchObject({
      spotWidthM: 2.6,
      spotDepthM: 5.5,
      laneWidthM: 7.3,
      parallelSpotLengthM: 6,
      parallelSpotWidthM: 2.4,
    });
  });
});

describe('custom site free positions', () => {
  const custom: SiteLayoutSettings = {
    ...effectiveLayoutSettings(null),
    siteType: 'custom',
  };

  it('shows transformers, energy assets and panels without a facing and places stations freely', () => {
    expect(usesFreePositions(custom)).toBe(true);
    expect(usesFreePositions({ siteType: 'parking_lot' })).toBe(false);
    expect(showsTransformers(custom)).toBe(true);
    expect(showsBatteries(custom)).toBe(true);
    expect(showsSolar(custom)).toBe(true);
    expect(showsLoadPanels(custom)).toBe(true);
    expect(layoutFacingOf({ ...custom, facingDeg: 90 })).toBe(0);
    expect(layoutCapacity(custom)).toBe(Number.POSITIVE_INFINITY);
    // The stored slots stay as they are.
    const fit = fitPositionsToGrid([{ key: 'a', position: { x: 5000, y: 5000 } }], custom);
    expect(fit.moved.size).toBe(0);
    expect(fit.unfit).toEqual([]);
  });

  it('keeps transformers and batteries where they were put, within reach', () => {
    const settings = effectiveLayoutSettings({
      ...custom,
      transformers: [{ id: 'tx-1', x: 3, z: 4 }],
      energyAssets: [{ id: 'b1', x: 5.04, z: -900 }],
    });
    expect(settings.transformers[0]).toMatchObject({ x: 3, z: 4 });
    const placed = placePowerEquipment(settings, {
      transformers: [],
      energyAssets: [{ id: 'b1', type: 'battery', name: 'B', capacityKwh: null, peakKwp: null }],
    });
    expect(placed.energyAssets[0]).toMatchObject({ x: 5, z: -FREE_LAYOUT.reachM });
  });

  it('snaps positions to 0.5 m and turns to 15 degrees, or keeps a free turn', () => {
    expect(snapFreePlacement({ x: 1.26, z: -0.2, rotationDeg: 22 })).toEqual({
      x: 1.5,
      z: 0,
      rotationDeg: 15,
    });
    expect(snapFreePlacement({ x: 0, z: 0, rotationDeg: -7 })).toEqual({
      x: 0,
      z: 0,
      rotationDeg: 0,
    });
    expect(snapFreePlacement({ x: 0, z: 0, rotationDeg: 352.5 })).toMatchObject({ rotationDeg: 0 });
    expect(snapFreePlacement({ x: 0, z: 0, rotationDeg: -8.04 }, { freeRotation: true })).toEqual({
      x: 0,
      z: 0,
      rotationDeg: 352,
    });
    expect(snapFreePlacement({ x: 9999, z: -9999, rotationDeg: 0 })).toMatchObject({
      x: FREE_LAYOUT.reachM,
      z: -FREE_LAYOUT.reachM,
    });
    expect(normalizeRotationDeg(720)).toBe(0);
    expect(normalizeRotationDeg(359.97)).toBe(0);
  });

  it('gives one spot per EVSE, at most four (the dispensers of a split system)', () => {
    expect(freeSpotCount(0)).toBe(1);
    expect(freeSpotCount(1)).toBe(1);
    expect(freeSpotCount(2)).toBe(2);
    expect(freeSpotCount(4)).toBe(4);
    expect(freeSpotCount(5)).toBe(4);
  });

  it('lays the spots in front of the charger and turns them with the station', () => {
    // The charger stands 0.58 m behind the head of its spots (CPF50: 18 in from the curb).
    const corners = freeFootprint({ x: 10, z: 20, rotationDeg: 0 }, 2);
    expect(corners[0]!.x).toBeCloseTo(7.4);
    expect(corners[0]!.z).toBeCloseTo(19.42);
    expect(corners[2]!.x).toBeCloseTo(12.6);
    expect(corners[2]!.z).toBeCloseTo(26.08);
    expect(freeSpotRects(2, 'car')[0]).toMatchObject({ minZ: 0.58, maxZ: 6.08 });
    // A quarter turn clockwise from above: the spots lie toward -x.
    const turned = freeToSite({ x: 0, z: 0, rotationDeg: 90 }, 0, 4);
    expect(turned.x).toBeCloseTo(-4);
    expect(turned.z).toBeCloseTo(0);
  });

  it('finds overlapping spots and lets spots touch side by side', () => {
    const a = { placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 1 };
    expect(
      freeFootprintsOverlap(a, { placement: { x: 2.6, z: 0, rotationDeg: 0 }, spots: 1 }),
    ).toBe(false);
    expect(freeFootprintsOverlap(a, { placement: { x: 2, z: 0, rotationDeg: 0 }, spots: 1 })).toBe(
      true,
    );
    expect(freeFootprintsOverlap(a, { placement: { x: 3, z: 2, rotationDeg: 45 }, spots: 2 })).toBe(
      true,
    );
    expect(
      freeFootprintsOverlap(a, { placement: { x: 20, z: 2, rotationDeg: 45 }, spots: 2 }),
    ).toBe(false);
    expect(
      overlappingFreeStations([
        { key: 'a', ...a },
        { key: 'b', placement: { x: 1, z: 0, rotationDeg: 0 }, spots: 1 },
        { key: 'c', placement: { x: 30, z: 0, rotationDeg: 0 }, spots: 1 },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('keeps the spots of a converted station in place: parking rows, office row and curbs', () => {
    // The charger 0.58 m behind the stall head line, the spot where it was.
    const lot = { ...custom, siteType: 'parking_lot' as const, rows: 2 };
    expect(freePlacementFromSlot({ col: 0, row: 0 }, lot)).toEqual({
      x: 1.3,
      z: -0.58,
      rotationDeg: 0,
    });
    // Row 1 (behind the 7.3 m aisle) is turned: its chargers stand past its back edge.
    expect(freePlacementFromSlot({ col: 1, row: 1 }, lot)).toEqual({
      x: 3.9,
      z: 18.88,
      rotationDeg: 180,
    });
    expect(
      freePlacementFromSlot({ col: 2, row: 0 }, { ...lot, siteType: 'office_retail' }),
    ).toEqual({ x: 6.5, z: -0.58, rotationDeg: 0 });
    const street = { ...lot, siteType: 'curbside' as const };
    expect(freePlacementFromSlot({ col: 0, row: 0 }, street)).toEqual({
      x: 3,
      z: -0.58,
      rotationDeg: 0,
    });
    expect(freePlacementFromSlot({ col: 1, row: 1 }, street)).toMatchObject({
      x: 9,
      rotationDeg: 180,
    });
  });

  it('slides overlapping converted stations along their row until they are free', () => {
    const lot = { ...custom, siteType: 'parking_lot' as const };
    const stations = [0, 1, 2].map((col) => ({
      key: `s${String(col)}`,
      placement: freePlacementFromSlot({ col, row: 0 }, lot),
      spots: 2,
    }));
    const moved = resolveFreeOverlaps(stations);
    expect(moved.has('s0')).toBe(false);
    const final = stations.map((s) => ({ ...s, placement: moved.get(s.key) ?? s.placement }));
    expect(overlappingFreeStations(final)).toEqual([]);
    for (const s of final) expect(s.placement.rotationDeg).toBe(0);
  });

  it('clears two saved facing stations by the shortest slide, back along their spots', () => {
    // Saved while car spots began 0.9 m into the spot (2 m apart then); spots now begin
    // 0.6 m in front of the charger, so they reach 1.5 m further and overlap by 1 m.
    const a = { key: 'a', placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 };
    const b = { key: 'b', placement: { x: 0, z: 11.2, rotationDeg: 180 }, spots: 2 };
    expect(overlappingFreeStations([a, b])).toEqual(['a', 'b']);
    const moved = resolveFreeOverlaps([a, b], { nearest: true });
    expect(moved.has('a')).toBe(false);
    // The second steps 1 m back from the first, its row, turn and spots otherwise kept.
    expect(moved.get('b')).toEqual({ x: 0, z: 12.2, rotationDeg: 180 });
    expect(
      overlappingFreeStations([a, { ...b, placement: moved.get('b') ?? b.placement }]),
    ).toEqual([]);
    // Without `nearest` it slides along its row (the Custom type switch).
    const along = resolveFreeOverlaps([a, b]).get('b');
    expect(along?.z).toBe(11.2);
    expect(Math.abs(along?.x ?? 0)).toBeGreaterThan(5);
    // Stations that overlap nothing keep their hand-placed positions.
    expect(
      resolveFreeOverlaps([a, { ...b, placement: { x: 20, z: 3, rotationDeg: 90 } }], {
        nearest: true,
      }).size,
    ).toBe(0);
  });

  describe('a large layout switched to Custom stays within reach', () => {
    function settle(stations: Array<{ key: string; placement: FreePlacement; spots: number }>) {
      const resolved = resolveFreeOverlaps(stations);
      const settled = stations.map((s) => ({
        ...s,
        placement: resolved.get(s.key) ?? s.placement,
      }));
      const fitted = fitFreePlacementsInReach(settled);
      return {
        settled,
        fitted,
        final: settled.map((s) => ({ ...s, placement: fitted.get(s.key) ?? s.placement })),
      };
    }

    function expectInReachAndApart(
      final: Array<{ key: string; placement: FreePlacement; spots: number }>,
    ): void {
      const r = FREE_LAYOUT.reachM;
      for (const s of final) {
        expect(Math.abs(s.placement.x)).toBeLessThanOrEqual(r);
        expect(Math.abs(s.placement.z)).toBeLessThanOrEqual(r);
      }
      expect(overlappingFreeStations(final)).toEqual([]);
    }

    it('packs the far rows of a 100-row parking lot into free places', () => {
      const lot = { ...custom, siteType: 'parking_lot' as const, rows: 100, spotsPerRow: 4 };
      const stations = Array.from({ length: 100 * 4 }, (_, i) => ({
        key: `s${String(i)}`,
        placement: freePlacementFromSlot({ col: i % 4, row: Math.floor(i / 4) }, lot),
        spots: 1,
      }));
      // Without the fit, the far rows stand over a kilometer out.
      expect(Math.max(...stations.map((s) => s.placement.z))).toBeGreaterThan(1000);
      const { settled, fitted, final } = settle(stations);
      expectInReachAndApart(final);
      // Stations within reach keep their positions; only the far ones move.
      for (const s of settled) {
        const inReach = Math.abs(s.placement.x) <= 400 && Math.abs(s.placement.z) <= 400;
        expect(fitted.has(s.key)).toBe(!inReach);
      }
      for (const p of fitted.values())
        expect(p.rotationDeg === 0 || p.rotationDeg === 180).toBe(true);
    });

    it('packs the far posts of 100 curbside chargers per side into free places', () => {
      const street = {
        ...custom,
        siteType: 'curbside' as const,
        chargersLeft: 100,
        chargersRight: 100,
      };
      const stations = Array.from({ length: 200 }, (_, i) => ({
        key: `s${String(i)}`,
        placement: freePlacementFromSlot({ col: i % 100, row: Math.floor(i / 100) }, street),
        spots: 1,
      }));
      expect(Math.max(...stations.map((s) => s.placement.x))).toBeGreaterThan(400);
      const { fitted, final } = settle(stations);
      expect(fitted.size).toBeGreaterThan(0);
      expectInReachAndApart(final);
    });

    it('moves nothing when every station is within reach', () => {
      expect(
        fitFreePlacementsInReach([
          { key: 'a', placement: { x: 400, z: -400, rotationDeg: 0 }, spots: 2 },
        ]).size,
      ).toBe(0);
    });
  });

  it('places a new station right of the others, on no spot', () => {
    expect(firstFreePlacement([])).toEqual({ x: 0, z: 0, rotationDeg: 0 });
    const placed = [
      { placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 },
      { placement: { x: 6, z: 3, rotationDeg: 90 }, spots: 1 },
    ];
    const next = firstFreePlacement(placed, 2);
    expect(next.rotationDeg).toBe(0);
    expect(placed.some((p) => freeFootprintsOverlap(p, { placement: next, spots: 2 }))).toBe(false);
    expect(freeStationsBox(placed)!.maxX).toBeLessThan(next.x);
  });

  it('sizes a free canopy from its peak power in whole spots', () => {
    expect(solarCanopySize(null)).toEqual({ lengthM: 10.4, depthM: 6 });
    expect(solarCanopySize(60).lengthM).toBe(49.4);
    expect(solarCanopySize(1).lengthM).toBe(5.2);
    expect(solarCanopySize(100000).lengthM).toBe(60);
    const canopy = { id: 'pv', type: 'solar' as const, name: 'Canopy', capacityKwp: null, row: 1 };
    expect(freeSolarPlacement(canopy, custom)).toEqual({ x: 13, z: 15.55, rotationDeg: 0 });
    expect(freeSolarPlacement({ ...canopy, x: 2, z: 3, rotationDeg: 30 }, custom)).toEqual({
      x: 2,
      z: 3,
      rotationDeg: 30,
    });
  });

  it('accepts a free canopy and a free placement, and refuses a turn of 360', () => {
    const settings = {
      ...custom,
      energyAssets: [
        {
          id: 'pv',
          row: 0,
          x: 1,
          z: 2,
          rotationDeg: 15,
        },
      ],
    };
    expect(siteLayoutSettingsSchema.safeParse(settings).success).toBe(true);
    expect(freePlacementSchema.safeParse({ x: 1, z: 2, rotationDeg: 359.9 }).success).toBe(true);
    expect(freePlacementSchema.safeParse({ x: 1, z: 2, rotationDeg: 360 }).success).toBe(false);
    expect(freePlacementSchema.safeParse({ x: 401, z: 2, rotationDeg: 0 }).success).toBe(false);
  });
});

describe('spot types', () => {
  it('lists car spots, bus bays and truck pull-through lanes with real dimensions', () => {
    expect([...FREE_SPOT_TYPES]).toEqual(['car', 'bus_bay', 'truck_pull_through']);
    expect(FREE_SPOT_DIMENSIONS.car).toEqual({ widthM: 2.6, lengthM: 5.5 });
    // A 12 m bus (2.55 m wide) with room around it; CharIN truck bays 4.7 to 5.05 m wide, 19 m or more long.
    expect(FREE_SPOT_DIMENSIONS.bus_bay).toEqual({ widthM: 4.3, lengthM: 14 });
    expect(FREE_SPOT_DIMENSIONS.truck_pull_through.widthM).toBeGreaterThanOrEqual(4.7);
    expect(FREE_SPOT_DIMENSIONS.truck_pull_through.widthM).toBeLessThanOrEqual(5.05);
    expect(FREE_SPOT_DIMENSIONS.truck_pull_through.lengthM).toBeGreaterThanOrEqual(23);
    expect(FREE_SPOT_DEFAULT_BODY_TYPE).toEqual({
      car: 'sedan',
      bus_bay: 'bus',
      truck_pull_through: 'semi_truck',
    });
  });

  it('reads an absent or unknown spot type as car spots', () => {
    expect(freeSpotTypeOf({})).toBe('car');
    expect(freeSpotTypeOf({ spotType: 'boat' })).toBe('car');
    expect(freeSpotTypeOf(null)).toBe('car');
    expect(freeSpotTypeOf({ spotType: 'bus_bay' })).toBe('bus_bay');
    expect(isFreeSpotType('truck_pull_through')).toBe(true);
    expect(isFreeSpotType('lorry')).toBe(false);
  });

  it('puts the car spot heads 0.58 m in front of the charger, its base behind them', () => {
    expect(freeSpotsExtent(2)).toEqual({ minX: -2.6, maxX: 2.6, front: -0.58, back: 6.08 });
    expect(freeSpotsExtent(1, 'car')).toEqual({
      minX: -1.3,
      maxX: 1.3,
      front: -0.58,
      back: 6.08,
    });
  });

  it('puts two bus bays side by side, nose to the charger between them', () => {
    const rects = freeSpotRects(2, 'bus_bay');
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ minX: -4.3, maxX: 0, minZ: -0.9, maxZ: 13.1, heading: '-z' });
    expect(rects[1]).toMatchObject({ minX: 0, maxX: 4.3, heading: '-z' });
    expect(freeSpotsExtent(2, 'bus_bay')).toEqual({
      minX: -4.3,
      maxX: 4.3,
      front: -0.9,
      back: 13.1,
    });
  });

  it('runs truck lanes the same way past the island, each lane with its own dispenser on the left', () => {
    const one = freeSpotRects(1, 'truck_pull_through');
    expect(one).toEqual([
      { minX: -20, maxX: 5, minZ: 1, maxZ: 6, heading: '+x', chargerX: 0, chargerZ: 0 },
    ]);
    const two = freeSpotRects(2, 'truck_pull_through');
    expect(two[1]).toEqual({
      minX: -20,
      maxX: 5,
      minZ: 8,
      maxZ: 13,
      heading: '+x',
      chargerX: 0,
      chargerZ: 7,
    });
    // The island under the first dispenser is part of the footprint.
    expect(freeSpotsExtent(2, 'truck_pull_through')).toEqual({
      minX: -20,
      maxX: 5,
      front: -FREE_LAYOUT.truckIslandM / 2,
      back: 13,
    });
  });

  it('uses each spot type footprint in the overlap check', () => {
    const car = { placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 };
    // 8 m to the right: free of car spots, inside bus bays.
    const right = { x: 8, z: 0, rotationDeg: 0 };
    expect(freeFootprintsOverlap(car, { placement: right, spots: 2 })).toBe(false);
    expect(
      freeFootprintsOverlap(
        { placement: { ...car.placement, spotType: 'bus_bay' }, spots: 2 },
        { placement: { ...right, spotType: 'bus_bay' }, spots: 2 },
      ),
    ).toBe(true);
    // A truck lane runs 20 m back along x: a car station 15 m to its left overlaps it.
    expect(
      freeFootprintsOverlap(
        { placement: { x: 0, z: 0, rotationDeg: 0, spotType: 'truck_pull_through' }, spots: 1 },
        { placement: { x: -15, z: 1.5, rotationDeg: 0 }, spots: 1 },
      ),
    ).toBe(true);
    expect(freeFootprint({ x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' }, 1)).toEqual([
      { x: -2.15, z: -0.9 },
      { x: 2.15, z: -0.9 },
      { x: 2.15, z: 13.1 },
      { x: -2.15, z: 13.1 },
    ]);
  });

  it('snaps a free position and places a new station right of the others with car spots', () => {
    expect(snapFreePlacement({ x: 1.26, z: 0, rotationDeg: 7 })).toEqual({
      x: 1.5,
      z: 0,
      rotationDeg: 0,
    });
    const placed = [{ placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 }];
    const next = firstFreePlacement(placed, 1);
    expect(next.spotType).toBeUndefined();
    expect(freeFootprintsOverlap({ placement: next, spots: 1 }, placed[0]!)).toBe(false);
  });

  it('takes no spot type in the free position schema (a custom site has car spots only)', () => {
    expect(freePlacementSchema.safeParse({ x: 0, z: 0, rotationDeg: 0 }).success).toBe(true);
    expect(
      freePlacementSchema.safeParse({ x: 0, z: 0, rotationDeg: 0, spotType: 'bus_bay' }).success,
    ).toBe(false);
  });

  it('draws only a vehicle that fits a large spot, else the spot default', () => {
    expect(spotVehicleBodyType('bus_bay', null)).toBe('bus');
    expect(spotVehicleBodyType('bus_bay', 'bus')).toBe('bus');
    expect(spotVehicleBodyType('bus_bay', 'box_truck')).toBe('box_truck');
    // A tractor-trailer is far longer than a 14 m bay; a car never stands in one.
    expect(spotVehicleBodyType('bus_bay', 'semi_truck')).toBe('bus');
    expect(spotVehicleBodyType('bus_bay', 'sedan')).toBe('bus');
    expect(spotVehicleBodyType('truck_pull_through', undefined)).toBe('semi_truck');
    expect(spotVehicleBodyType('truck_pull_through', 'box_truck')).toBe('box_truck');
    expect(spotVehicleBodyType('truck_pull_through', 'bus')).toBe('bus');
    expect(spotVehicleBodyType('truck_pull_through', 'suv')).toBe('semi_truck');
    expect(spotVehicleBodyType('car', null)).toBe('sedan');
    expect(spotVehicleBodyType('car', 'pickup_truck')).toBe('pickup_truck');
  });
});

describe('depot site', () => {
  const depot = (extra: Partial<SiteLayoutSettings> = {}): SiteLayoutSettings => ({
    siteType: 'depot',
    ...DEFAULT_LAYOUT_GRID,
    transformers: [],
    ...extra,
  });

  it('is a site type with open ground, a facing and grid slots', () => {
    expect(SITE_TYPES).toContain('depot');
    const s = depot({ facingDeg: 90 });
    expect(usesDepotSpots(s)).toBe(true);
    expect(usesFreePositions(s)).toBe(false);
    expect(layoutFacingOf(s)).toBe(90);
    expect(showsTransformers(s)).toBe(true);
    expect(showsBatteries(s)).toBe(true);
    expect(showsSolar(s)).toBe(true);
    expect(showsLoadPanels(s)).toBe(true);
  });

  it('takes truck lanes for MCS connectors, bus bays for other DC stations and nothing for AC', () => {
    const c = (...types: Array<string | null>) =>
      types.map((connectorType) => ({ connectorType, maxPowerKw: 150 }));
    expect(depotStationKind(c('cMCS'))).toBe('truck');
    expect(depotStationKind(c('CCS1', 'MCS'))).toBe('truck');
    expect(depotStationKind(c('OppCharge'))).toBe('bus');
    expect(depotStationKind(c('Pan'))).toBe('bus');
    expect(depotStationKind(c('CCS1', null))).toBe('bus');
    // A depot charges DC only: AC plug-in chargers take no bay or lane.
    expect(depotStationKind([{ connectorType: 'Type2', maxPowerKw: 22 }])).toBeNull();
    expect(depotStationKind([{ connectorType: 'NACS', maxPowerKw: 11 }])).toBeNull();
    expect(depotStationKind([])).toBeNull();
  });

  it('never places an AC station in a bay or lane', () => {
    const s = depot({ busBays: 2, truckLanes: 1 });
    const below = bayToPosition({ col: 0, row: 2 });
    expect(firstFreeDepotSlot([], s, null)).toEqual(below);
    expect(firstFreeSlotFor([], s, { charging: 'ac', depot: null })).toEqual(below);
    expect(firstFreeSlotFor([below], s, { charging: 'ac', depot: null })).toEqual(
      bayToPosition({ col: 1, row: 2 }),
    );
    // Turning into a depot moves an AC station out of a bay; a layout Save does too.
    const at = (col: number, row: number) => bayToPosition({ col, row });
    const ac = { charging: 'ac', depot: null } as const;
    const bus = { charging: 'dc', depot: 'bus' } as const;
    const fit = fitDepotPositions(
      [
        { key: 'ac', position: at(0, 0), kind: ac },
        { key: 'bus', position: at(1, 0), kind: bus },
      ],
      s,
    );
    expect(fit.moved.get('ac')).toEqual(below);
    expect(fit.moved.has('bus')).toBe(false);
    const saved = fitPositionsToGrid([{ key: 'ac', position: at(1, 1 - 1), kind: ac }], s);
    expect(saved.moved.get('ac')).toEqual(below);
    // The defaults count no AC station.
    expect(layoutStationCountsOfKinds([ac, bus, ac])).toEqual({
      total: 3,
      bus: 1,
      truck: 0,
      spots: 3,
    });
  });

  it('defaults the bus bays and truck lanes from the stations by kind', () => {
    const counted = effectiveLayoutSettings(depot(), [], { total: 8, bus: 5, truck: 3 });
    expect(counted.busBays).toBe(5);
    expect(counted.truckLanes).toBe(3);
    // A plain station count: every station a bus station.
    expect(effectiveLayoutSettings(depot(), [], 4)).toMatchObject({ busBays: 4, truckLanes: 0 });
    // No station: one bus bay.
    expect(effectiveLayoutSettings(depot(), [], 0)).toMatchObject({ busBays: 1, truckLanes: 0 });
    // One count stored: the other follows the stations, at least 1 when the stored one is 0.
    expect(
      effectiveLayoutSettings(depot({ busBays: 0 }), [], { total: 2, bus: 2, truck: 0 }),
    ).toMatchObject({ busBays: 0, truckLanes: 1 });
    expect(
      effectiveLayoutSettings(depot({ truckLanes: 2 }), [], { total: 6, bus: 4, truck: 2 }),
    ).toMatchObject({ busBays: 4, truckLanes: 2 });
    expect(
      withSiteType(depot({ siteType: 'parking_lot' }), 'depot', { total: 3, bus: 1, truck: 2 }),
    ).toMatchObject({ siteType: 'depot', busBays: 1, truckLanes: 2 });
  });

  it('has the bus bays in row 0 and the truck lanes in row 1, one station each', () => {
    const s = depot({ busBays: 6, truckLanes: 3 });
    expect(layoutRowLengths(s)).toEqual([6, 3]);
    expect(layoutCapacity(s)).toBe(9);
    expect(bayInLayout({ col: 5, row: 0 }, s)).toBe(true);
    expect(bayInLayout({ col: 3, row: 1 }, s)).toBe(false);
    expect(DEPOT_ROWS).toEqual({ bus: 0, truck: 1 });
  });

  it('lays the bays, lanes, roads and yard edge out in standard dimensions', () => {
    const d = depotLayout(depot({ busBays: 2, truckLanes: 2 }));
    expect(d.bays).toEqual([
      { minX: 0, maxX: 4.3, minZ: 0, maxZ: 14 },
      { minX: 4.3, maxX: 8.6, minZ: 0, maxZ: 14 },
    ]);
    // The truck area past the median and the entry road; lanes from the drive lane back.
    const lanesLeft = 24.3; // 8.6 + 2 m median + 13.7 m entry road
    expect(d.lanes[0]).toEqual({ minX: lanesLeft, maxX: lanesLeft + 25, minZ: 9, maxZ: 14 });
    expect(d.lanes[1]).toEqual({ minX: lanesLeft, maxX: lanesLeft + 25, minZ: 2, maxZ: 7 });
    expect(d.islands[0]).toEqual({ minX: lanesLeft, maxX: lanesLeft + 25, minZ: 7, maxZ: 9 });
    expect(d.entryRoad).toEqual({ minX: 10.6, maxX: lanesLeft, minZ: 0, maxZ: 14 });
    expect(d.exitRoad?.minX).toBe(lanesLeft + 25);
    // The drive lane: the bus turning radius in front of the bus area, the
    // truck one only in front of the truck area, split in the median.
    expect(d.driveLanes).toEqual([
      { minX: -0.6, maxX: 9.6, minZ: 14, maxZ: 14 + DEPOT_LAYOUT.busDriveLaneM },
      { minX: 9.6, maxX: d.yard.maxX, minZ: 14, maxZ: 14 + DEPOT_LAYOUT.driveLaneM },
    ]);
    // Bus area 3 m head strip deep, truck area 14 m: the same back line here (2 lanes reach z 0).
    expect(d.busHead).toEqual({ minX: 0, maxX: 8.6, minZ: -3, maxZ: 0 });
    expect(d.yard.maxZ).toBe(14 + 13.7 + 0.6);
    // The front edge steps out in the median where the truck stretch begins.
    expect(d.outline[0]).toEqual({ x: -0.6, z: 14 + 12.7 + 0.6 });
    expect(d.outline).toHaveLength(8);
    expect(d.outline.slice(-3)).toEqual([
      { x: d.yard.maxX, z: d.yard.maxZ },
      { x: 9.6, z: d.yard.maxZ },
      { x: 9.6, z: 14 + 12.7 + 0.6 },
    ]);
    // Without truck lanes there is no truck area, and the drive lane is the bus one.
    const busOnly = depotLayout(depot({ busBays: 3, truckLanes: 0 }));
    expect(busOnly.lanes).toEqual([]);
    expect(busOnly.entryRoad).toBeNull();
    expect(busOnly.yard).toEqual({ minX: -0.6, maxX: 13.5, minZ: -3.6, maxZ: 27.3 });
    expect(busOnly.driveLanes).toEqual([
      { minX: -0.6, maxX: 13.5, minZ: 14, maxZ: 14 + DEPOT_LAYOUT.busDriveLaneM },
    ]);
    // Three lanes reach behind the bus area: the yard edge steps back in the median.
    const deep = depotLayout(depot({ busBays: 2, truckLanes: 3 }));
    expect(deep.outline).toHaveLength(8);
    expect(deep.yard.minZ).toBe(-7.6);
  });

  it('sizes the yard to its bays and lanes plus the cited turning space only', () => {
    // CITY-BUS 41.6 ft and WB-62/67 44.8 ft design turning radii (TxDOT RDM 4.3.3 Table 4-1).
    const ft = 0.3048;
    expect(DEPOT_LAYOUT.busDriveLaneM).toBeGreaterThanOrEqual(41.6 * ft);
    expect(DEPOT_LAYOUT.busDriveLaneM).toBeLessThan(41.6 * ft + 0.1);
    expect(DEPOT_LAYOUT.driveLaneM).toBeGreaterThanOrEqual(44.8 * ft);
    expect(DEPOT_LAYOUT.driveLaneM).toBeLessThan(44.8 * ft + 0.1);
    expect(DEPOT_LAYOUT.truckRoadM).toBe(DEPOT_LAYOUT.driveLaneM);
    expect(depotDriveLaneM(0)).toBe(DEPOT_LAYOUT.busDriveLaneM);
    expect(depotDriveLaneM(2)).toBe(DEPOT_LAYOUT.driveLaneM);
    // Small and large counts: the yard is the markings plus lanes, roads, median and margins.
    for (const [busBays, truckLanes] of [
      [1, 0],
      [2, 1],
      [6, 3],
      [20, 10],
      [0, 4],
    ] as const) {
      const d = depotLayout(depot({ busBays, truckLanes }));
      const width = d.yard.maxX - d.yard.minX;
      const marked =
        busBays * 4.3 +
        (truckLanes > 0 ? 25 + 2 * DEPOT_LAYOUT.truckRoadM + (busBays > 0 ? 2 : 0) : 0);
      expect(width).toBeCloseTo(marked + 2 * DEPOT_LAYOUT.marginM, 5);
      const depth = d.yard.maxZ - d.yard.minZ;
      const back = Math.max(busBays > 0 ? 3 : 0, truckLanes * 7 - 14);
      expect(depth).toBeCloseTo(14 + back + depotDriveLaneM(truckLanes) + 2 * 0.6, 5);
    }
  });

  it('stands each station at its bay head or on its lane island, never over another', () => {
    const s = depot({ busBays: 3, truckLanes: 2 });
    const d = depotLayout(s);
    const bus = depotSlotPlacement({ col: 1, row: 0 }, s);
    expect(bus).toEqual({ x: 6.45, z: 0.9, rotationDeg: 0, spotType: 'bus_bay' });
    // The bus bay footprint is the bay itself.
    const busCorners = freeFootprint(bus, 1);
    expect(busCorners[0]?.x).toBeCloseTo(4.3);
    expect(busCorners[0]?.z).toBeCloseTo(0);
    expect(busCorners[2]?.x).toBeCloseTo(8.6);
    expect(busCorners[2]?.z).toBeCloseTo(14);
    const truck = depotSlotPlacement({ col: 1, row: 1 }, s);
    expect(truck.spotType).toBe('truck_pull_through');
    // The lane of the dispenser is the layout's lane (freeSpotRects, unturned).
    const lane = freeSpotRects(1, 'truck_pull_through')[0]!;
    expect(truck.x + lane.minX).toBeCloseTo(d.lanes[1]!.minX);
    expect(truck.x + lane.maxX).toBeCloseTo(d.lanes[1]!.maxX);
    expect(truck.z + lane.minZ).toBeCloseTo(d.lanes[1]!.minZ);
    expect(truck.z + lane.maxZ).toBeCloseTo(d.lanes[1]!.maxZ);
    const all = [
      ...[0, 1, 2].map((col) => depotSlotPlacement({ col, row: 0 }, s)),
      ...[0, 1].map((col) => depotSlotPlacement({ col, row: 1 }, s)),
    ].map((placement, key) => ({ key, placement, spots: 1 }));
    expect(overlappingFreeStations(all)).toEqual([]);
    // Off the layout: car spots on the grass behind the yard.
    const off = depotSlotPlacement({ col: 0, row: 2 }, s);
    expect(off.spotType).toBeUndefined();
    expect(off.z).toBeLessThan(d.yard.minZ);
    // Switching to Custom keeps the charger point, with car spots.
    expect(freePlacementFromSlot({ col: 1, row: 0 }, s)).toEqual({
      x: 6.45,
      z: 0.9,
      rotationDeg: 0,
    });
  });

  it('keeps transformers and batteries on the grass outside the yard', () => {
    const s = depot({ busBays: 2, truckLanes: 1 });
    const yard = depotLayout(s).yard;
    const p = snapTransformerToGrass(5, 10, s);
    const outside =
      p.x <= yard.minX - TRANSFORMER_CLEARANCE_M ||
      p.x >= yard.maxX + TRANSFORMER_CLEARANCE_M ||
      p.z <= yard.minZ - TRANSFORMER_CLEARANCE_M ||
      p.z >= yard.maxZ + TRANSFORMER_CLEARANCE_M;
    expect(outside).toBe(true);
    const battery: LayoutBattery = {
      id: 'b',
      type: 'battery',
      name: 'Battery',
      capacityKwh: null,
      x: 5,
      z: 10,
    };
    expect(placeEnergyAsset(battery, s)).toMatchObject(p);
    // A solar canopy without a position stands behind the yard.
    const solar = freeSolarPlacement(
      { id: 'pv', type: 'solar', name: 'Canopy', capacityKwp: null, row: 0 },
      s,
    );
    expect(solar.z).toBeLessThan(yard.minZ);
  });

  it('sorts stations into their areas when a site turns into a depot', () => {
    const s = depot({ busBays: 2, truckLanes: 2 });
    const at = (col: number, row: number) => bayToPosition({ col, row });
    const fit = fitDepotPositions(
      [
        { key: 'truckA', position: at(0, 0), kind: { charging: 'dc', depot: 'truck' } as const },
        { key: 'busA', position: at(1, 0), kind: { charging: 'dc', depot: 'bus' } as const },
        { key: 'busB', position: at(2, 0), kind: { charging: 'dc', depot: 'bus' } as const },
        { key: 'truckB', position: at(3, 0), kind: { charging: 'dc', depot: 'truck' } as const },
      ],
      s,
    );
    expect(fit.moved.get('truckA')).toEqual(at(0, 1));
    expect(fit.moved.has('busA')).toBe(false);
    expect(fit.moved.get('busB')).toEqual(at(0, 0));
    expect(fit.moved.get('truckB')).toEqual(at(1, 1));
    expect(fit.unfit).toEqual([]);
    // A third truck takes the free bus bay; nothing free is unfit.
    const full = fitDepotPositions(
      [
        { key: 'a', position: at(0, 1), kind: { charging: 'dc', depot: 'truck' } as const },
        { key: 'b', position: at(1, 1), kind: { charging: 'dc', depot: 'truck' } as const },
        { key: 'c', position: at(5, 0), kind: { charging: 'dc', depot: 'truck' } as const },
        { key: 'd', position: at(6, 0), kind: { charging: 'dc', depot: 'truck' } as const },
        { key: 'e', position: at(7, 0), kind: { charging: 'dc', depot: 'truck' } as const },
      ],
      s,
    );
    expect(full.moved.get('c')).toEqual(at(1, 0));
    expect(full.moved.get('d')).toEqual(at(0, 0));
    expect(full.unfit).toEqual(['e']);
  });

  it('gives a new station a free spot of its own area first', () => {
    const s = depot({ busBays: 2, truckLanes: 1 });
    expect(firstFreeDepotSlot([], s, 'truck')).toEqual(bayToPosition({ col: 0, row: 1 }));
    expect(firstFreeDepotSlot([bayToPosition({ col: 0, row: 1 })], s, 'truck')).toEqual(
      bayToPosition({ col: 0, row: 0 }),
    );
    expect(firstFreeDepotSlot([], s, 'bus')).toEqual(bayToPosition({ col: 0, row: 0 }));
  });

  it('validates the depot counts in the settings schema', () => {
    expect(siteLayoutSettingsSchema.safeParse(depot({ busBays: 6, truckLanes: 3 })).success).toBe(
      true,
    );
    expect(siteLayoutSettingsSchema.safeParse(depot({ busBays: 0, truckLanes: 0 })).success).toBe(
      false,
    );
    expect(siteLayoutSettingsSchema.safeParse(depot({ busBays: 101 })).success).toBe(false);
    expect(
      sameLayoutSettings(
        depot({ busBays: 2, truckLanes: 1 }),
        depot({ busBays: 2, truckLanes: 2 }),
      ),
    ).toBe(false);
  });
});
