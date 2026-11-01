// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  bayInLayout,
  bayToPosition,
  chargerPlacementOf,
  effectiveLayoutSettings,
  firstFreeSlotFor,
  fitGroupedPositions,
  groupedSpotOrder,
  layoutCapacity,
  layoutRowLengths,
  lotExtentM,
  positionToBay,
  sameLayoutSettings,
  withSiteType,
  type SiteLayoutSettings,
} from '../site-layout.js';
import { siteLayoutSettingsSchema } from '../site-layout-schema.js';

const lot = (rows: number, placement?: 'islands' | 'lot_edge'): SiteLayoutSettings => ({
  siteType: 'parking_lot',
  spotsPerRow: 6,
  rows,
  facingDeg: 0,
  ...(placement != null ? { chargerPlacement: placement } : {}),
  transformers: [{ id: 'tx', name: null, ratedKva: null, x: 20, z: 2.5 }],
});

describe('parking lot charger placement', () => {
  it('reads islands when absent and on every other site type', () => {
    expect(chargerPlacementOf(lot(3))).toBe('islands');
    expect(chargerPlacementOf(lot(3, 'lot_edge'))).toBe('lot_edge');
    expect(chargerPlacementOf({ siteType: 'office_retail', chargerPlacement: 'lot_edge' })).toBe(
      'islands',
    );
  });

  it('charges every row with islands and only the edge rows with lot edge', () => {
    for (const rows of [1, 2, 3, 4]) {
      expect(layoutRowLengths(lot(rows))).toEqual(Array.from({ length: rows }, () => 6));
    }
    expect(layoutRowLengths(lot(1, 'lot_edge'))).toEqual([6]);
    expect(layoutRowLengths(lot(2, 'lot_edge'))).toEqual([6, 6]);
    expect(layoutRowLengths(lot(3, 'lot_edge'))).toEqual([6, 0, 6]);
    expect(layoutRowLengths(lot(4, 'lot_edge'))).toEqual([6, 0, 0, 6]);
    expect(layoutCapacity(lot(4, 'lot_edge'))).toBe(12);
    expect(bayInLayout({ col: 0, row: 1 }, lot(4, 'lot_edge'))).toBe(false);
    expect(bayInLayout({ col: 0, row: 3 }, lot(4, 'lot_edge'))).toBe(true);
  });

  it('keeps the same lot extent for both placements (the inner rows stay ordinary parking)', () => {
    for (const rows of [1, 2, 3, 4]) {
      expect(lotExtentM(lot(rows, 'lot_edge'))).toEqual(lotExtentM(lot(rows)));
    }
  });

  it('fills the edge nearest the transformer first, DC from its end and AC from the far end', () => {
    // The transformer stands right of the first row.
    const s = lot(4, 'lot_edge');
    const dc = groupedSpotOrder(s, 'dc');
    expect(dc[0]).toEqual({ col: 5, row: 0 });
    expect(dc.slice(0, 6).every((b) => b.row === 0)).toBe(true);
    expect(groupedSpotOrder(s, 'ac')[0]).toEqual({ col: 0, row: 3 });
    const slot = firstFreeSlotFor([], s, { charging: 'dc', depot: 'bus' });
    expect(positionToBay(slot)).toEqual({ col: 5, row: 0 });
  });

  it('moves stations from the inner rows to the edge rows when the placement turns to lot edge', () => {
    const s = lot(4, 'lot_edge');
    const fit = fitGroupedPositions(
      [
        {
          key: 'inner',
          position: bayToPosition({ col: 2, row: 1 }),
          kind: { charging: 'dc', depot: 'bus' },
        },
        {
          key: 'edge',
          position: bayToPosition({ col: 5, row: 0 }),
          kind: { charging: 'dc', depot: 'bus' },
        },
      ],
      s,
    );
    expect(fit.moved.has('edge')).toBe(false);
    const moved = positionToBay(fit.moved.get('inner')!);
    expect(moved.row === 0 || moved.row === 3).toBe(true);
  });

  it('keeps the placement in the effective settings of a parking lot only', () => {
    expect(effectiveLayoutSettings(lot(3, 'lot_edge')).chargerPlacement).toBe('lot_edge');
    const office = withSiteType(effectiveLayoutSettings(lot(3, 'lot_edge')), 'office_retail', 2);
    expect(effectiveLayoutSettings(office).chargerPlacement).toBeUndefined();
    expect(sameLayoutSettings(lot(3), lot(3, 'islands'))).toBe(true);
    expect(sameLayoutSettings(lot(3), lot(3, 'lot_edge'))).toBe(false);
  });

  it('accepts the placement on a parking lot and refuses it on other site types', () => {
    expect(siteLayoutSettingsSchema.safeParse(lot(3, 'lot_edge')).success).toBe(true);
    expect(
      siteLayoutSettingsSchema.safeParse({
        ...lot(3),
        siteType: undefined,
        chargerPlacement: 'lot_edge',
      }).success,
    ).toBe(true);
    expect(
      siteLayoutSettingsSchema.safeParse({ ...lot(3, 'lot_edge'), siteType: 'office_retail' })
        .success,
    ).toBe(false);
    expect(
      siteLayoutSettingsSchema.safeParse({ ...lot(3), chargerPlacement: 'perimeter' }).success,
    ).toBe(false);
  });
});
