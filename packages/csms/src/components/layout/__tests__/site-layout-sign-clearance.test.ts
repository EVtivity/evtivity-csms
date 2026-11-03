// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { EV_SIGNS, SPLIT_SYSTEM, type SiteType } from '@evtivity/lib/site-layout';
import { AC_PEDESTAL } from '../site-layout-model-ac-pedestal';
import { DC_DISPENSER } from '../site-layout-model-dc-dispenser';
import { stallSignPostXs, stationSignMount } from '../site-layout-signs';

// A sign post keeps clear of the charger it serves: half its anchor post, a
// hand's width (0.1 m, a design value: no standard sets the gap) from the
// charger's footprint, holsters and handles included (0.12 m out of a side wall).
const HOLSTER_AND_HANDLE_M = 0.12;
const HAND_M = 0.1;
const clearance = (chargerHalfWidth: number): number =>
  chargerHalfWidth + HOLSTER_AND_HANDLE_M + EV_SIGNS.anchorWidthM / 2 + HAND_M;

const SPOT_W = 2.6;

describe('sign posts stand clear of the chargers', () => {
  it('puts a dual-port pedestal posts at the outer stall lines, in either row direction', () => {
    for (const stalls of [
      [
        { x: -1.3, width: SPOT_W },
        { x: 1.3, width: SPOT_W },
      ],
      [
        { x: 1.3, width: SPOT_W },
        { x: -1.3, width: SPOT_W },
      ],
    ]) {
      const xs = stallSignPostXs(stalls, false);
      for (const x of xs) expect(Math.abs(x)).toBeCloseTo(2.4, 6);
      for (const x of xs) {
        expect(Math.abs(x)).toBeGreaterThanOrEqual(clearance(AC_PEDESTAL.head.widthM / 2));
      }
    }
  });

  it('keeps every split system post clear of the satellite in its stall', () => {
    const stalls = [0, 2.6, 5.2, -2.6].map((x) => ({ x, width: SPOT_W }));
    stallSignPostXs(stalls, true).forEach((x, i) => {
      const at = stalls[i]?.x ?? 0;
      expect(Math.abs(x - at)).toBeGreaterThanOrEqual(clearance(SPLIT_SYSTEM.dispenser.widthM / 2));
    });
  });

  it('keeps the single post of every site type clear of an AC pedestal or a DC dispenser at the station', () => {
    const types: SiteType[] = ['parking_lot', 'office_retail', 'curbside', 'custom'];
    for (const siteType of types) {
      for (const wall of siteType === 'office_retail' ? [false, true] : [false]) {
        const mount = stationSignMount({
          siteType,
          onSpot: true,
          wall,
          freeSpots: siteType === 'custom' ? 1 : null,
          largeSpot: false,
          california: false,
        });
        // A wall box sign hangs on the facade above the box, not on a post.
        if (mount == null || mount.onWall) continue;
        const need = Math.max(
          clearance(AC_PEDESTAL.head.widthM / 2),
          clearance(DC_DISPENSER.widthM / 2),
        );
        expect(Math.abs(mount.x), `${siteType} ${String(wall)}`).toBeGreaterThanOrEqual(need);
      }
    }
  });
});
