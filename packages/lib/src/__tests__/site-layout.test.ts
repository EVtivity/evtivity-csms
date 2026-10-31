// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYOUT_GRID,
  TRANSFORMER_CLEARANCE_M,
  assignBays,
  bayInGrid,
  bayToPosition,
  cardsOverlap,
  effectiveLayoutSettings,
  firstFreeSlot,
  fitPositionsToGrid,
  freeSlotsFor,
  gridBoardExtent,
  layoutGridCapacity,
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
  type LayoutBattery,
  type LayoutEnergyAsset,
  SITE_TYPES,
  type SiteLayoutSettings,
  snapTransformerToGrass,
} from '../site-layout.js';
import { siteLayoutSettingsSchema } from '../site-layout-schema.js';

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

  it('uses the default lot of 2 rows of 10 spots, grown to hold the stations, with one transformer', () => {
    const fresh = effectiveLayoutSettings(null);
    expect(fresh).toMatchObject({ spotsPerRow: 10, rows: 2, spotWidthM: 3.2, laneWidthM: 6 });
    expect(fresh.transformers).toHaveLength(1);
    const t = fresh.transformers[0]!;
    // On the grass right of the lot.
    expect(t.x).toBeGreaterThanOrEqual(lotExtentM(fresh).width + TRANSFORMER_CLEARANCE_M);
    const grown = effectiveLayoutSettings(null, [{ col: 12, row: 3 }]);
    expect(grown).toMatchObject({ spotsPerRow: 13, rows: 4 });
    // Stored settings stay as stored, with transformers kept on the grass.
    const stored = {
      ...DEFAULT_LAYOUT_GRID,
      spotsPerRow: 4,
      rows: 1,
      transformers: [{ id: 'a', name: null, ratedKva: null, x: 2, z: 2 }],
    };
    const kept = effectiveLayoutSettings(stored, [{ col: 30, row: 9 }]);
    expect(kept.spotsPerRow).toBe(4);
    expect(kept.transformers[0]).toMatchObject({ x: -2.5, z: 2 });
    expect(layoutGridCapacity(kept)).toBe(4);
  });

  it('moves a transformer off the lot to the nearest side and keeps it within reach', () => {
    const grid = { ...DEFAULT_LAYOUT_GRID, spotsPerRow: 2, rows: 1, laneWidthM: 0 };
    // Lot 6.4 by 5.6 m.
    expect(snapTransformerToGrass(6, 3, grid)).toEqual({ x: 8.9, z: 3 });
    expect(snapTransformerToGrass(0.5, 3, grid)).toEqual({ x: -2.5, z: 3 });
    expect(snapTransformerToGrass(3, 5, grid)).toEqual({ x: 3, z: 8.1 });
    expect(snapTransformerToGrass(20, -9, grid)).toEqual({ x: 20, z: -9 });
    expect(snapTransformerToGrass(1e6, 0, grid).x).toBe(206.4);
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
    expect(bayInGrid({ col: 1, row: 0 }, grid)).toBe(true);
    expect(bayInGrid({ col: 2, row: 0 }, grid)).toBe(false);
    expect(gridBoardExtent(grid)).toEqual({ width: 380, height: 140 });
  });

  it('compares settings field by field, transformers included', () => {
    const a = effectiveLayoutSettings(null);
    expect(sameLayoutSettings(a, { ...a, transformers: [...a.transformers] })).toBe(true);
    expect(sameLayoutSettings(a, { ...a, facingDeg: 90 })).toBe(false);
    expect(sameLayoutSettings(a, { ...a, transformers: [] })).toBe(false);
    expect(sameLayoutSettings(a, { ...a, siteType: 'office_retail' })).toBe(false);
    expect(sameLayoutGrid(layoutGridOf(a), DEFAULT_LAYOUT_GRID)).toBe(true);
  });

  it('reads settings without a site type as a parking lot, and keeps a stored one', () => {
    expect(effectiveLayoutSettings(null).siteType).toBe('parking_lot');
    const legacy: SiteLayoutSettings = { ...effectiveLayoutSettings(null) };
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
    expect(nearestFreeBay({ col: 1, row: 0 }, [], 5, 2)).toEqual({ col: 1, row: 0 });
    expect(nearestFreeBay({ col: 9, row: 9 }, [], 5, 2)).toEqual({ col: 4, row: 1 });
    expect(nearestFreeBay({ col: 0, row: 0 }, [{ col: 0, row: 0 }], 2, 1)).toEqual({
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
        2,
        1,
      ),
    ).toBeNull();
  });
});

describe('site layout settings schema', () => {
  const valid = effectiveLayoutSettings(null);

  it('accepts the default settings and a named transformer', () => {
    expect(siteLayoutSettingsSchema.safeParse(valid).success).toBe(true);
    const named = {
      ...valid,
      transformers: [{ id: 'tx-2', name: 'Main Feed', ratedKva: 2500, x: 40, z: 3 }],
    };
    expect(siteLayoutSettingsSchema.safeParse(named).success).toBe(true);
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
    ['spot width below the minimum', { spotWidthM: 1.9 }],
    ['spot depth with 5 cm', { spotDepthM: 5.65 }],
    ['negative lane', { laneWidthM: -1 }],
    ['facing not a quarter turn', { facingDeg: 45 }],
    ['unlimited rows', { rows: null }],
    ['an unknown key', { color: 'red' }],
    ['an unknown site type', { siteType: 'garage' }],
    ['a null site type', { siteType: null }],
  ])('refuses %s', (_name, patch) => {
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('refuses duplicate transformer ids, a bad kVA and more than 10 transformers', () => {
    const t = { id: 'a', name: null, ratedKva: null, x: 40, z: 0 };
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, transformers: [t, t] }).success).toBe(
      false,
    );
    expect(
      siteLayoutSettingsSchema.safeParse({ ...valid, transformers: [{ ...t, ratedKva: 0 }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...t, id: `t${String(i)}` }));
    expect(siteLayoutSettingsSchema.safeParse({ ...valid, transformers: many }).success).toBe(
      false,
    );
  });
});

describe('site layout energy assets', () => {
  const base = effectiveLayoutSettings(null);
  const battery: LayoutBattery = {
    id: 'bat-1',
    type: 'battery',
    name: 'Storage',
    capacityKwh: 500,
    x: 5,
    z: 2,
  };
  const solar: LayoutEnergyAsset = {
    id: 'pv-1',
    type: 'solar',
    name: null,
    capacityKwp: 120,
    row: 7,
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

  it('moves a battery on the lot to the grass and clamps a solar row into the lot', () => {
    const placed = effectiveLayoutSettings({ ...base, energyAssets: [battery, solar] });
    const [b, s] = placed.energyAssets ?? [];
    expect(b).toEqual({
      ...battery,
      ...snapTransformerToGrass(battery.x, battery.z, base),
    });
    expect(b?.type === 'battery' && b.z).toBe(-TRANSFORMER_CLEARANCE_M);
    expect(s).toEqual({ ...solar, row: base.rows - 1 });
    expect(placeEnergyAsset({ ...solar, row: 0 }, base)).toEqual({ ...solar, row: 0 });
    // A smaller lot clamps the row again.
    const oneRow = effectiveLayoutSettings({ ...base, rows: 1, energyAssets: [solar] });
    expect(oneRow.energyAssets?.[0]).toEqual({ ...solar, row: 0 });
  });

  it('shows solar only on a parking lot and compares energy assets field by field', () => {
    expect(showsSolar(base)).toBe(true);
    expect(showsSolar({ ...base, siteType: 'office_retail' })).toBe(false);
    const a = { ...base, energyAssets: [battery, solar] };
    expect(sameLayoutSettings(a, { ...base, energyAssets: [battery, solar] })).toBe(true);
    expect(sameLayoutSettings(a, { ...base, energyAssets: [solar, battery] })).toBe(false);
    expect(sameLayoutSettings(a, { ...base, energyAssets: [battery, { ...solar, row: 0 }] })).toBe(
      false,
    );
    expect(
      sameLayoutSettings(a, { ...base, energyAssets: [{ ...battery, capacityKwh: 1 }, solar] }),
    ).toBe(false);
    expect(sameLayoutSettings(a, base)).toBe(false);
  });

  it('accepts both kinds in the schema and refuses bad ones', () => {
    const parse = (energyAssets: unknown) =>
      siteLayoutSettingsSchema.safeParse({ ...base, energyAssets }).success;
    expect(parse([battery, solar])).toBe(true);
    expect(parse(undefined)).toBe(true);
    expect(parse([battery, { ...solar, id: 'bat-1' }])).toBe(false);
    expect(parse([{ ...battery, capacityKwh: 0 }])).toBe(false);
    expect(parse([{ ...battery, capacityKwh: 1.5 }])).toBe(false);
    expect(parse([{ ...solar, row: -1 }])).toBe(false);
    expect(parse([{ ...solar, row: 100 }])).toBe(false);
    expect(parse([{ ...solar, x: 1 }])).toBe(false);
    expect(parse([{ ...battery, type: 'wind' }])).toBe(false);
    expect(parse([{ ...battery, name: 'x'.repeat(61) }])).toBe(false);
    expect(parse(Array.from({ length: 11 }, (_, i) => ({ ...battery, id: `b${String(i)}` })))).toBe(
      false,
    );
  });
});
