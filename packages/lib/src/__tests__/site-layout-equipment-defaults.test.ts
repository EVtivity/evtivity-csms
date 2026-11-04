// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Default places of power equipment without a stored position (owner report
// 2026-11-04: "the transformer by default not arranged by user should stay as
// close to the site as possible"). A transformer stands next to the stations
// it feeds, at the distance the site layout standards cite (2.5 m center from
// the lot edge, level with its group), the rule the demo seed follows.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSFORMER_PITCH_M,
  TRANSFORMER_CLEARANCE_M,
  effectiveLayoutSettings,
  layoutEquipmentGround,
  layoutStationPlaces,
  lotExtentM,
  newBatteryPoint,
  placePowerEquipment,
  type LayoutPowerEquipment,
  type LayoutStationPlace,
  type LayoutTransformerInfo,
  type SiteLayoutSettings,
} from '../site-layout.js';

function service(id: string, stationIds?: string[]): LayoutTransformerInfo {
  return {
    id,
    kind: 'service',
    name: id,
    ratedKva: 1500,
    maxContinuousKw: 1080,
    ...(stationIds != null ? { stationIds } : {}),
  };
}

function equipment(transformers: LayoutTransformerInfo[]): LayoutPowerEquipment {
  return { transformers, energyAssets: [] };
}

/** A tall lot: 10 spots per row, 20 rows (about 160 m deep), as the large demo sites. */
const LOT: SiteLayoutSettings = effectiveLayoutSettings({
  siteType: 'parking_lot',
  spotsPerRow: 10,
  rows: 20,
  facingDeg: 0,
  transformers: [],
});

/** Stations `prefix-0..n-1` in row `row`, columns 0 to n-1 (grid positions). */
function rowStations(prefix: string, row: number, n: number) {
  return Array.from({ length: n }, (_, c) => ({
    id: `${prefix}-${String(c)}`,
    positionX: c * 100 + 50,
    positionY: row * 100 + 50,
  }));
}

function zRange(places: readonly LayoutStationPlace[]): { min: number; max: number } {
  const zs = places.map((p) => p.z);
  return { min: Math.min(...zs), max: Math.max(...zs) };
}

describe('default transformer places next to the stations they feed', () => {
  it('stands 2.5 m past the lot edge, level with its group, for each group of a long lot', () => {
    const near = rowStations('near', 1, 6);
    const middle = rowStations('mid', 9, 6);
    const far = rowStations('far', 18, 6);
    const places = layoutStationPlaces([...near, ...middle, ...far], LOT);
    const placed = placePowerEquipment(
      LOT,
      equipment([
        service(
          'tfm_far',
          far.map((s) => s.id),
        ),
        service(
          'tfm_near',
          near.map((s) => s.id),
        ),
        service(
          'tfm_mid',
          middle.map((s) => s.id),
        ),
      ]),
      places,
    );
    const lot = lotExtentM(LOT);
    for (const [id, group] of [
      ['tfm_near', near],
      ['tfm_mid', middle],
      ['tfm_far', far],
    ] as const) {
      const t = placed.transformers.find((x) => x.id === id);
      expect(t).toBeDefined();
      if (t == null) continue;
      // The cited center distance from the lot edge.
      expect(t.x).toBeCloseTo(lot.width + TRANSFORMER_CLEARANCE_M, 1);
      // Level with its group: inside the z range of its stations' spots.
      const range = zRange(places.filter((p) => group.some((s) => s.id === p.id)));
      expect(t.z).toBeGreaterThanOrEqual(range.min - 0.1);
      expect(t.z).toBeLessThanOrEqual(range.max + 0.1);
    }
  });

  it('keeps two transformers of one group a pitch apart, along the same edge', () => {
    const group = rowStations('g', 4, 8);
    const ids = group.map((s) => s.id);
    const placed = placePowerEquipment(
      LOT,
      equipment([service('tfm_a', ids), service('tfm_b', ids)]),
      layoutStationPlaces(group, LOT),
    );
    const [a, b] = placed.transformers;
    expect(a != null && b != null).toBe(true);
    if (a == null || b == null) return;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(
      DEFAULT_TRANSFORMER_PITCH_M - 1e-6,
    );
    expect(b.x).toBeCloseTo(a.x, 1);
  });

  it('keeps clear of a stored transformer and leaves the stored one where it is', () => {
    const group = rowStations('g', 0, 4);
    const ids = group.map((s) => s.id);
    const lot = lotExtentM(LOT);
    const stored = { id: 'tfm_stored', x: lot.width + TRANSFORMER_CLEARANCE_M, z: 2.8 };
    const placed = placePowerEquipment(
      { ...LOT, transformers: [stored] },
      equipment([service('tfm_stored', ids), service('tfm_new', ids)]),
      layoutStationPlaces(group, LOT),
    );
    expect(placed.transformers[0]).toMatchObject(stored);
    const added = placed.transformers[1];
    expect(added).toBeDefined();
    if (added == null) return;
    expect(Math.hypot(added.x - stored.x, added.z - stored.z)).toBeGreaterThanOrEqual(
      DEFAULT_TRANSFORMER_PITCH_M - 1e-6,
    );
  });

  it('stacks transformers that feed no station along the lot edge, never far out', () => {
    const placed = placePowerEquipment(
      LOT,
      equipment([service('tfm_1'), service('tfm_2'), service('tfm_3')]),
      [],
    );
    const lot = lotExtentM(LOT);
    for (const t of placed.transformers) {
      expect(t.x).toBeCloseTo(lot.width + TRANSFORMER_CLEARANCE_M, 1);
      expect(t.z).toBeGreaterThanOrEqual(0);
      expect(t.z).toBeLessThanOrEqual(lot.depth);
    }
    // Without the station places (a caller that has none) the same rule applies.
    expect(
      placePowerEquipment(LOT, equipment([service('tfm_1'), service('tfm_2')])).transformers,
    ).toEqual(placed.transformers.slice(0, 2));
  });

  it('stands behind a depot yard, level with the bays it feeds', () => {
    const depot = effectiveLayoutSettings({
      siteType: 'depot',
      busBays: 6,
      truckLanes: 2,
      facingDeg: 0,
      spotsPerRow: 10,
      rows: 2,
      transformers: [],
    });
    const bays = Array.from({ length: 6 }, (_, c) => ({
      id: `bus-${String(c)}`,
      positionX: c * 100 + 50,
      positionY: 50,
    }));
    const places = layoutStationPlaces(bays, depot);
    const placed = placePowerEquipment(
      depot,
      equipment([
        service(
          'tfm_bus',
          bays.map((b) => b.id),
        ),
      ]),
      places,
    );
    const t = placed.transformers[0];
    expect(t).toBeDefined();
    if (t == null) return;
    const yard = layoutEquipmentGround(depot);
    // Behind the yard, within the cited clearance band (snapped to the grass).
    expect(t.z).toBeLessThanOrEqual(yard.minZ - TRANSFORMER_CLEARANCE_M + 0.05);
    expect(t.z).toBeGreaterThanOrEqual(yard.minZ - TRANSFORMER_CLEARANCE_M - 3);
    const xs = places.map((p) => p.x);
    expect(t.x).toBeGreaterThanOrEqual(Math.min(...xs) - 0.05);
    expect(t.x).toBeLessThanOrEqual(Math.max(...xs) + 0.05);
  });

  it('stands next to the stations of a custom site, wherever they are, and so does a battery', () => {
    const custom = effectiveLayoutSettings({
      siteType: 'custom',
      spotsPerRow: 10,
      rows: 2,
      facingDeg: 0,
      transformers: [],
    });
    const stations = Array.from({ length: 3 }, (_, i) => ({
      id: `s-${String(i)}`,
      positionX: 50,
      positionY: 50,
      freePosition: { x: 120 + 6 * i, z: 80 },
    }));
    const places = layoutStationPlaces(stations, custom);
    const placed = placePowerEquipment(
      custom,
      equipment([
        service(
          'tfm_c',
          stations.map((s) => s.id),
        ),
      ]),
      places,
    );
    const t = placed.transformers[0];
    expect(t).toBeDefined();
    if (t == null) return;
    expect(t.x).toBeCloseTo(120 - DEFAULT_TRANSFORMER_PITCH_M, 1);
    expect(t.z).toBeCloseTo(80, 1);
    const battery = newBatteryPoint(custom, 0, places);
    expect(Math.hypot(battery.x - 120, battery.z - 80)).toBeLessThan(12);
  });
});
