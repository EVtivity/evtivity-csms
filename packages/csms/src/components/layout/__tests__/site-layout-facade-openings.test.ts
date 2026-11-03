// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_GRID, EV_SIGNS } from '@evtivity/lib/site-layout';
import { facadeOpenings } from '../site-layout-facade-openings';
import { lotOf } from '../site-layout-grid';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { AC_WALL_BOX } from '../site-layout-model-wall-box';
import { WALL_BOX_HANGER, wallBoxHangerSpec } from '../site-layout-wall-box-cable';
import { WALL_SIGN } from '../site-layout-signs';

type Rect = { name: string; minX: number; maxX: number; minY: number; maxY: number };

// The facade panelboard (0.51 by 0.97 m, its bottom at 0.68 m) half a stall
// left of its first wall box (`placeFacadePanels`).
const PANEL = { widthM: 0.51, bottomM: 0.68, topM: 1.65 };
const CLEARANCE_M = 0.1;

function stationItems(x: number, spotW: number): Rect[] {
  const w = AC_WALL_BOX;
  const signTop = WALL_SIGN.bottomM + EV_SIGNS.chargingOnly.heightM;
  const towBottom = WALL_SIGN.bottomM - 0.05 - EV_SIGNS.towAway.heightM;
  return [
    {
      name: 'wall box',
      minX: x - w.widthM / 2 - 0.01,
      maxX: x + w.widthM / 2 + 0.01,
      minY: WALL_BOX_BOTTOM_M - 0.01,
      maxY: WALL_BOX_BOTTOM_M + w.heightM + 0.01,
    },
    {
      name: 'conduit',
      minX: x + w.conduit.x - 0.02,
      maxX: x + w.conduit.x + 0.02,
      minY: 0,
      maxY: WALL_BOX_BOTTOM_M,
    },
    {
      // The cable hanger, with the coil hanging from its saddle to its lowest turn
      // (the turns at most 0.12 m to each side, the saddle with its lips at most 0.13 m).
      name: 'hanger',
      minX: x + WALL_BOX_HANGER.x - Math.max(0.12, wallBoxHangerSpec(0.0125).radiusM + 0.03),
      maxX: x + WALL_BOX_HANGER.x + Math.max(0.12, wallBoxHangerSpec(0.0125).radiusM + 0.03),
      minY: 0.2,
      maxY: WALL_BOX_HANGER.saddleTopY + 0.04,
    },
    {
      name: 'signs',
      minX: x + WALL_SIGN.x - EV_SIGNS.towAway.widthM / 2,
      maxX: x + WALL_SIGN.x + EV_SIGNS.towAway.widthM / 2,
      minY: towBottom,
      maxY: signTop,
    },
    {
      name: 'panelboard',
      minX: x - spotW / 2 - PANEL.widthM / 2,
      maxX: x - spotW / 2 + PANEL.widthM / 2,
      minY: PANEL.bottomM,
      maxY: PANEL.topM,
    },
  ];
}

const overlaps = (a: Rect, b: Omit<Rect, 'name'>, c: number): boolean =>
  a.minX < b.maxX + c && a.maxX > b.minX - c && a.minY < b.maxY + c && a.maxY > b.minY - c;

describe('facade openings', () => {
  it('keeps every facade-mounted item clear of the windows, door and canopy on every wall-mounted row', () => {
    for (let chargers = 1; chargers <= 12; chargers++) {
      const lot = lotOf({
        ...DEFAULT_LAYOUT_GRID,
        siteType: 'office_retail',
        chargers,
        mounting: 'wall',
      });
      const openings = facadeOpenings(lot);
      for (let c = 0; c < chargers; c++) {
        const x = (c + 0.5) * lot.spotW;
        for (const item of stationItems(x, lot.spotW)) {
          for (const o of openings) {
            expect(
              overlaps(item, o, CLEARANCE_M),
              `${String(chargers)} ${String(c)} ${item.name} ${o.kind}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('lists the ground floor windows above the wall box signs', () => {
    const lot = lotOf({
      ...DEFAULT_LAYOUT_GRID,
      siteType: 'office_retail',
      chargers: 6,
      mounting: 'wall',
    });
    const lowestWindow = Math.min(
      ...facadeOpenings(lot)
        .filter((o) => o.kind === 'window')
        .map((o) => o.minY),
    );
    expect(WALL_SIGN.bottomM + EV_SIGNS.chargingOnly.heightM).toBeLessThan(
      lowestWindow - CLEARANCE_M,
    );
  });
});
