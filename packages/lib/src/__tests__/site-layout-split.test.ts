// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  CHARGER_PORT_LIMITS,
  FREE_LAYOUT,
  SPLIT_SYSTEM,
  drawnConnectorCounts,
  accessibleChargingSpace,
  effectiveLayoutSettings,
  firstFreeSlotFor,
  fitGroupedPositions,
  freeSlotsFor,
  freeSpotCount,
  heldSpots,
  layoutStationCountsOfKinds,
  positionToBay,
  spanSpots,
  splitDispenserCount,
  bayToPosition,
  type SiteLayoutSettings,
} from '../site-layout.js';

const DC2 = { charging: 'dc', depot: 'bus', ports: 2 } as const;
const DC3 = { charging: 'dc', depot: 'bus', ports: 3 } as const;
const DC4 = { charging: 'dc', depot: 'bus', ports: 4 } as const;
const AC2 = { charging: 'ac', depot: null, ports: 2 } as const;

const lot = (rows = 2): SiteLayoutSettings =>
  effectiveLayoutSettings({
    siteType: 'parking_lot',
    spotsPerRow: 8,
    rows,
    facingDeg: 0,
    chargerPlacement: 'islands',
    transformers: [{ id: 'tx', x: -2.5, z: 2.5 }],
  });

describe('DC split systems hold one spot per dispenser', () => {
  it('counts a dispenser per EVSE for a DC station of three or more, on lots and office rows only', () => {
    const s = lot();
    expect(splitDispenserCount(DC2, s)).toBe(1);
    expect(splitDispenserCount(DC3, s)).toBe(3);
    expect(splitDispenserCount(DC4, s)).toBe(4);
    expect(splitDispenserCount({ ...DC4, ports: 12 }, s)).toBe(SPLIT_SYSTEM.maxDispensers);
    expect(splitDispenserCount(AC2, s)).toBe(1);
    expect(splitDispenserCount({ charging: 'ac', ports: 4 }, s)).toBe(1);
    const depot = effectiveLayoutSettings({
      siteType: 'depot',
      spotsPerRow: 1,
      rows: 1,
      facingDeg: 0,
      busBays: 4,
      truckLanes: 0,
      transformers: [],
    });
    expect(splitDispenserCount(DC4, depot)).toBe(1);
    // A custom site gives such a station one car spot per EVSE, up to four.
    expect(FREE_LAYOUT.maxSpots).toBe(4);
    expect(freeSpotCount(4)).toBe(4);
    expect(freeSpotCount(6)).toBe(4);
  });

  it('places a split system on contiguous free spots of its row in the DC group', () => {
    const s = lot();
    const [a, b] = freeSlotsFor([DC3, DC4], [], s);
    const first = positionToBay(a!);
    const second = positionToBay(b!);
    // DC fills from the transformer end (left): spots 0 to 2, then 3 to 6.
    expect(first).toEqual({ col: 0, row: 0 });
    expect(second).toEqual({ col: 3, row: 0 });
    const held = heldSpots(
      [
        { ...a!, charging: 'dc', span: 3 },
        { ...b!, charging: 'dc', span: 4 },
      ],
      s,
      false,
    );
    expect([...held.keys()].sort()).toEqual(
      ['0:0', '1:0', '2:0', '3:0', '4:0', '5:0', '6:0'].sort(),
    );
    // No room left for a third four-dispenser system in row 0: the next row.
    const third = positionToBay(
      firstFreeSlotFor(
        [
          { ...a!, charging: 'dc', span: 3 },
          { ...b!, charging: 'dc', span: 4 },
        ],
        s,
        DC4,
      ),
    );
    expect(third.row).toBe(1);
    expect(spanSpots(third, 4, s)).not.toBeNull();
    expect(spanSpots({ col: 6, row: 0 }, 3, s)).toBeNull();
  });

  it('keeps the accessible space off a split system and counts its spots for the lot size', () => {
    const s = lot();
    const placed = [{ ...bayToPosition({ col: 0, row: 0 }), charging: 'dc' as const, span: 3 }];
    expect(accessibleChargingSpace(placed, s)).toBeNull();
    expect(layoutStationCountsOfKinds([DC4, DC2, AC2]).spots).toBe(4 + 1 + 2);
  });

  it('regroups a split system onto free contiguous spots of its group', () => {
    const s = lot();
    const fit = fitGroupedPositions(
      [
        { key: 'split', position: bayToPosition({ col: 6, row: 0 }), kind: DC4 },
        { key: 'dc', position: bayToPosition({ col: 1, row: 0 }), kind: DC2 },
      ],
      s,
    );
    const at = positionToBay(fit.moved.get('split') ?? bayToPosition({ col: 6, row: 0 }));
    const spots = spanSpots(at, 4, s);
    expect(spots).not.toBeNull();
    expect(spots!.some((b) => b.col === 1 && b.row === 0)).toBe(false);
    expect(fit.unfit).toEqual([]);
  });
});

describe('charger port limits', () => {
  it('draws at most 2 ports of one connector on an AC unit', () => {
    expect(CHARGER_PORT_LIMITS.ac).toEqual({ evses: 2, connectorsPerEvse: 1, cables: 2 });
    expect(drawnConnectorCounts('ac', [1])).toEqual([1]);
    expect(drawnConnectorCounts('ac', [1, 1])).toEqual([1, 1]);
    // A station that reports more: the first two ports, one connector each.
    expect(drawnConnectorCounts('ac', [2, 1, 1])).toEqual([1, 1]);
  });

  it('draws at most 2 EVSEs, 2 connectors each and 4 cables on a DC dispenser', () => {
    expect(CHARGER_PORT_LIMITS.dc).toEqual({
      evses: 2,
      connectorsPerEvse: 2,
      cables: 4,
      singleEvseConnectors: 3,
    });
    expect(drawnConnectorCounts('dc', [1, 1])).toEqual([1, 1]);
    expect(drawnConnectorCounts('dc', [2, 2])).toEqual([2, 2]);
    expect(drawnConnectorCounts('dc', [3, 3])).toEqual([2, 2]);
    expect(drawnConnectorCounts('dc', [2])).toEqual([2]);
    // A one-EVSE multi-standard dispenser (CCS, CHAdeMO, AC): three cables.
    expect(drawnConnectorCounts('dc', [3])).toEqual([3]);
    expect(drawnConnectorCounts('dc', [5])).toEqual([3]);
    // No EVSE reported yet: one connector.
    expect(drawnConnectorCounts('dc', [])).toEqual([1]);
    expect(drawnConnectorCounts('dc', [0])).toEqual([1]);
  });

  it('keeps a DC station with more EVSEs than one dispenser holds a split system', () => {
    expect(SPLIT_SYSTEM.minDispensers).toBe(CHARGER_PORT_LIMITS.dc.evses + 1);
  });
});
