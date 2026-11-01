// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  bayInLayout,
  bayToPosition,
  effectiveLayoutSettings,
  fitGroupedPositions,
  freeSlotsFor,
  layoutStationCountsOfKinds,
  positionToBay,
  spotPairPartner,
  withSiteType,
  type LayoutStationKind,
  type SiteLayoutSettings,
} from '../site-layout.js';

// Charger groups on a lot: AC and DC never interleave, each group's charging
// spots are one continuous run (no charger-free spot inside it), and a site
// without stored settings holds every station on its lot.

const AC1: LayoutStationKind = { charging: 'ac', depot: null, ports: 1 };
const AC2: LayoutStationKind = { charging: 'ac', depot: null, ports: 2 };
const DC: LayoutStationKind = { charging: 'dc', depot: 'bus', ports: 2 };

/** A deterministic mix of kinds, in creation order. */
function mix(n: number, seed: number): LayoutStationKind[] {
  let x = seed;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    const r = x % 10;
    return r < 4 ? DC : r < 8 ? AC1 : AC2;
  });
}

/** The spots of each row a station holds, with its kind (a pedestal: both of its pair). */
function rowsOf(
  kinds: readonly LayoutStationKind[],
  slots: ReadonlyArray<{ x: number; y: number }>,
  settings: SiteLayoutSettings,
): Map<number, Map<number, 'ac' | 'dc'>> {
  const rows = new Map<number, Map<number, 'ac' | 'dc'>>();
  slots.forEach((p, i) => {
    const kind = kinds[i];
    const bay = positionToBay(p);
    if (kind == null || !bayInLayout(bay, settings)) return;
    const row = rows.get(bay.row) ?? new Map<number, 'ac' | 'dc'>();
    row.set(bay.col, kind.charging);
    const partner =
      kind.charging === 'ac' && (kind.ports ?? 1) >= 2 ? spotPairPartner(bay, settings) : null;
    if (partner != null) row.set(partner.col, kind.charging);
    rows.set(bay.row, row);
  });
  return rows;
}

describe('charger groups on a lot', () => {
  it('holds every station of a site without stored settings on its lot, grouped and continuous', () => {
    for (const [n, seed] of [
      [12, 1],
      [40, 7],
      [91, 3],
      [127, 11],
    ] as const) {
      const kinds = mix(n, seed);
      const settings = effectiveLayoutSettings(null, [], layoutStationCountsOfKinds(kinds));
      const slots = freeSlotsFor(kinds, [], settings);
      // Nobody waits below the lot in creation order (where AC and DC would interleave).
      expect(
        slots.every((p) => bayInLayout(positionToBay(p), settings)),
        `${String(n)} stations`,
      ).toBe(true);
      for (const [row, cols] of rowsOf(kinds, slots, settings)) {
        const sorted = [...cols].sort((a, b) => a[0] - b[0]);
        // At most one change of kind along a row.
        const changes = sorted.filter(([, k], i) => i > 0 && k !== sorted[i - 1]?.[1]).length;
        expect(changes, `${String(n)} stations, row ${String(row)}`).toBeLessThanOrEqual(1);
        // Each kind's spots in the row are one run: no charger-free spot inside it.
        for (const kind of ['ac', 'dc'] as const) {
          const own = sorted.filter(([, k]) => k === kind).map(([c]) => c);
          if (own.length === 0) continue;
          expect(
            own[own.length - 1]! - own[0]! + 1,
            `${String(n)} stations, row ${String(row)}, ${kind}`,
          ).toBe(own.length);
        }
      }
    }
  });

  it('regroups the AC stations of a depot that turns into a parking lot', () => {
    const kinds = [AC2, AC1, AC1];
    const depot = effectiveLayoutSettings(
      { siteType: 'depot', spotsPerRow: 8, rows: 1, facingDeg: 0, transformers: [] },
      [],
      layoutStationCountsOfKinds(kinds),
    );
    // A depot has no AC: the AC stations stand below its layout.
    const below = freeSlotsFor(kinds, [], depot);
    expect(below.every((p) => !bayInLayout(positionToBay(p), depot))).toBe(true);
    const lot = withSiteType(depot, 'parking_lot', layoutStationCountsOfKinds(kinds));
    const fit = fitGroupedPositions(
      kinds.map((kind, i) => ({ key: i, position: below[i]!, kind })),
      lot,
    );
    expect(fit.unfit).toEqual([]);
    const moved = kinds.map((_, i) => fit.moved.get(i) ?? below[i]!);
    expect(moved.every((p) => bayInLayout(positionToBay(p), lot))).toBe(true);
    const cols = [...rowsOf(kinds, moved, lot).values()].flatMap((row) => [...row.keys()]);
    // Four spots (the pedestal takes two), no two stations on one spot.
    expect(new Set(cols.map(String)).size).toBe(cols.length);
    expect(cols).toHaveLength(4);
  });

  it('keeps a group continuous when the access aisle sits at its end', () => {
    const settings = effectiveLayoutSettings({
      siteType: 'parking_lot',
      spotsPerRow: 8,
      rows: 2,
      facingDeg: 0,
      transformers: [{ id: 'tx', name: null, ratedKva: null, x: -5, z: 2.5 }],
    });
    // Placed one by one, as stations come online.
    const placed: Array<{ x: number; y: number; charging: 'dc' }> = [];
    for (let i = 0; i < 5; i++) {
      const [slot] = freeSlotsFor([DC], placed, settings);
      placed.push({ ...slot!, charging: 'dc' });
    }
    // The run in each row is continuous and nobody waits off the lot.
    expect(placed.every((p) => bayInLayout(positionToBay(p), settings))).toBe(true);
    for (const row of rowsOf(
      placed.map(() => DC),
      placed,
      settings,
    ).values()) {
      const cols = [...row.keys()].sort((a, b) => a - b);
      expect(cols[cols.length - 1]! - cols[0]! + 1).toBe(cols.length);
    }
    expect(bayToPosition(positionToBay(placed[0]!))).toEqual({ x: placed[0]!.x, y: placed[0]!.y });
  });
});
