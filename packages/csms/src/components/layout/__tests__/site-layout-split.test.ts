// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
import { DEFAULT_LAYOUT_GRID, SPLIT_SYSTEM } from '@evtivity/lib/site-layout';
import {
  CABINET_PREFIX,
  loadFlows,
  loadLinks,
  placePanels,
  splitDispenserId,
  withSplitCabinets,
  type LinkPanel,
} from '../site-layout-links';
import {
  dispenserHolsters,
  lotOf,
  stationBackPoint,
  STATION_BACK_OFFSET,
} from '../site-layout-grid';
import { stationStalls } from '../site-layout-stalls';
import { customSplitDispenserXs } from '../site-layout-free';

const LOT = lotOf({ ...DEFAULT_LAYOUT_GRID, spotsPerRow: 8, rows: 2 });
const ground = { minX: 0, maxX: LOT.width, minZ: 0, maxZ: LOT.depth };

describe('DC split systems on the 3D layout', () => {
  it('stands a dispenser in the head of each stall of a split system', () => {
    const stalls = stationStalls({ col: 2, row: 0 }, LOT, { pair: false, access: null, span: 3 });
    expect(stalls?.dispensers).toBe(true);
    expect(stalls?.stalls.map((s) => s.x)).toEqual([0, LOT.spotW, 2 * LOT.spotW]);
    // A turned row (chargers at its back edge) runs its own x the other way.
    const back = stationStalls({ col: 2, row: 1 }, LOT, { pair: false, access: null, span: 3 });
    expect(back?.stalls.map((s) => s.x)).toEqual([0, -LOT.spotW, -2 * LOT.spotW]);
    // One stall without a span, as before.
    expect(stationStalls({ col: 2, row: 0 }, LOT, { pair: false, access: null })?.stalls).toEqual([
      { x: 0, width: LOT.spotW },
    ]);
  });

  it('hangs one holstered cable per connector, at most four, at least one', () => {
    expect(dispenserHolsters(1)).toEqual([{ side: -1, dropM: 0 }]);
    // A CCS and CHAdeMO dispenser: one cable on each side.
    expect(dispenserHolsters(2).map((h) => h.side)).toEqual([-1, 1]);
    // A triple-outlet dispenser (ABB Terra 54 CJG: CCS, CHAdeMO, AC Type 2).
    expect(dispenserHolsters(3)).toEqual([
      { side: -1, dropM: 0 },
      { side: 1, dropM: 0 },
      { side: -1, dropM: 0.34 },
    ]);
    expect(dispenserHolsters(6)).toHaveLength(4);
    expect(dispenserHolsters(0)).toHaveLength(1);
  });

  it('feeds the dispensers from one power cabinet on the equipment pad that counts the circuit once', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'main',
        name: 'Main Switchboard',
        breakerRatingAmps: 800,
        maxContinuousKw: 532,
        circuits: [
          {
            id: 'c-split',
            name: 'Split System',
            breakerRatingAmps: 300,
            maxContinuousKw: 199,
            stations: [{ id: 'split', allocatedLimitKw: null }],
          },
          {
            id: 'c-dc',
            name: 'DC 1',
            breakerRatingAmps: 300,
            maxContinuousKw: 199,
            stations: [{ id: 'dc', allocatedLimitKw: null }],
          },
        ],
        childPanels: [],
      },
    ];
    const routed = withSplitCabinets(hierarchy, new Map([['split', 3]]));
    const main = routed[0]!;
    expect(main.circuits.map((c) => c.id)).toEqual(['c-dc']);
    const cabinet = main.childPanels[0]!;
    expect(cabinet.id).toBe(`${CABINET_PREFIX}split`);
    expect(cabinet.breakerRatingAmps).toBe(300);
    expect(cabinet.maxContinuousKw).toBe(199);
    expect(cabinet.circuits[0]?.stations.map((s) => s.id)).toEqual([
      'split',
      splitDispenserId('split', 2),
      splitDispenserId('split', 3),
    ]);
    // The cabinet's draw is its circuit once, not per dispenser.
    const flows = loadFlows(routed, (id) => (id === 'split' ? 120 : id === 'dc' ? 50 : undefined));
    expect(flows.loads.get(cabinet.id)?.drawKw).toBe(120);

    // The split system in spots 0 to 2 of row 0, a DC charger in spot 3; the transformer left of row 0.
    const point = (col: number) => ({
      charger: stationBackPoint({ col, row: 0 }, LOT, -STATION_BACK_OFFSET),
      back: stationBackPoint({ col, row: 0 }, LOT),
    });
    const points = new Map([
      ['split', point(0)],
      [splitDispenserId('split', 2), point(1)],
      [splitDispenserId('split', 3), point(2)],
      ['dc', point(3)],
    ]);
    const transformer = { x: -2.5, z: 2.5 };
    const placed = placePanels(routed, ground, transformer, points, new Set());
    const cab = placed.find((p) => p.id === cabinet.id)!;
    expect(cab.model).toBe('cabinet');
    // On the pad beside the switchboard, next to the group it feeds (and within the 80 m cable run).
    const main0 = placed.find((p) => p.id === 'main')!;
    expect(Math.abs(cab.point.z - main0.point.z)).toBeLessThan(1e-6);
    const nearest = Math.min(
      ...[0, 1, 2].map((c) =>
        Math.hypot(point(c).charger.x - cab.point.x, point(c).charger.z - cab.point.z),
      ),
    );
    expect(nearest).toBeLessThanOrEqual(14);
    const links = loadLinks(routed, placed, points, ground, transformer, new Set());
    // A branch to every dispenser.
    for (const id of ['split', splitDispenserId('split', 2), splitDispenserId('split', 3)]) {
      expect(links.segments.some((s) => s.id === `station:${id}`)).toBe(true);
    }
    for (const seg of links.segments) {
      let length = 0;
      for (let i = 1; i < seg.points.length; i++) {
        length +=
          Math.abs(seg.points[i]!.x - seg.points[i - 1]!.x) +
          Math.abs(seg.points[i]!.z - seg.points[i - 1]!.z);
      }
      expect(length).toBeLessThanOrEqual(SPLIT_SYSTEM.maxCableM);
    }
  });

  it('puts a dispenser at the head of each car spot of a custom split system only', () => {
    const evses = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ evseId: i + 1, status: 'available', connectors: [] }));
    const place = { placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 4 };
    const xs = customSplitDispenserXs({ chargingKind: 'dc', evses: evses(4) }, place);
    expect(xs).toEqual([-3.9, -1.3, 1.3, 3.9]);
    expect(
      customSplitDispenserXs({ chargingKind: 'dc', evses: evses(2) }, { ...place, spots: 2 }),
    ).toBeNull();
    expect(customSplitDispenserXs({ chargingKind: 'ac', evses: evses(4) }, place)).toBeNull();
  });
});
