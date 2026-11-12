// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  bayToPosition,
  effectiveLayoutSettings,
  layoutRowLengths,
} from '@evtivity/lib/site-layout';
import {
  UNIT_CARDS_PER_LINE,
  packUnitCardBays,
  packUnitCardGrid,
  stationBays,
} from '../site-layout-2d-bays';
import { expandUnitStations } from '../site-layout-units';
import {
  CARD_GAP,
  STATION_CARD_SIZE,
  cardRectsOverlap,
  gridCardLayout,
} from '../site-layout-2d-placement';
import type { LayoutStation } from '../StationCard';

const type2 = {
  connectorId: 1,
  connectorType: 'Type2',
  maxPowerKw: 22,
  status: 'available',
  isPluggedIn: false,
  energyDeliveredWh: null,
};

function station(id: string, col: number, row: number, boxes = 0): LayoutStation {
  const at = bayToPosition({ col, row });
  const evseCount = boxes > 0 ? boxes * 2 : 2;
  return {
    id,
    stationId: id.toUpperCase(),
    model: 'AC',
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: at.x,
    positionY: at.y,
    placed: true,
    chargingKind: 'ac',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: Array.from({ length: evseCount }, (_, i) => ({
      evseId: i + 1,
      status: 'available',
      unitId: boxes > 0 ? `unt_${String(Math.floor(i / 2) + 1)}` : null,
      connectors: [type2],
    })),
    units: Array.from({ length: boxes }, (_, i) => ({
      id: `unt_${String(i + 1)}`,
      name: `Box ${String(i + 1)}`,
      evseIds: [2 * i + 1, 2 * i + 2],
      boardPosition: null,
    })),
    boardPosition: null,
  };
}

// Parkhaus Lindenhof: rows of 18 spots, a master with 8 dual-port boxes.
const garage = effectiveLayoutSettings({
  siteType: 'parking_lot',
  spotsPerRow: 18,
  rows: 2,
  facingDeg: 0,
  chargerPlacement: 'islands',
  transformers: [],
});

function gridOf(stations: LayoutStation[], blocked: ReadonlySet<string> = new Set()) {
  const view = expandUnitStations(stations, garage);
  const board = packUnitCardGrid(
    view,
    stationBays(view, garage),
    layoutRowLengths(garage),
    blocked,
  );
  const list = view.flatMap((s) => {
    const bay = board.bays.get(s.id);
    return bay == null ? [] : [{ id: s.id, bay }];
  });
  return { view, board, layout: gridCardLayout(list, board.rowLengths, board.blocked) };
}

const PITCH_X = STATION_CARD_SIZE.width + CARD_GAP;
const PITCH_Y = STATION_CARD_SIZE.height + CARD_GAP;

describe('packUnitCardGrid (owner decision 2026-11-12)', () => {
  it('stands the 8 unit cards of a station in two lines of four at the card pitch', () => {
    const { view, layout } = gridOf([station('sta_em4', 0, 0, 8)]);
    expect(view).toHaveLength(8);
    const slots = view.map((s) => layout.cards.get(s.id));
    const x0 = slots[0]?.x ?? 0;
    const y0 = slots[0]?.y ?? 0;
    slots.forEach((slot, i) => {
      expect(slot?.x).toBe(x0 + (i % UNIT_CARDS_PER_LINE) * PITCH_X);
      expect(slot?.y).toBe(y0 + Math.floor(i / UNIT_CARDS_PER_LINE) * PITCH_Y);
    });
  });

  it('moves the rows below a unit block down, and no card meets another', () => {
    const { layout } = gridOf([station('sta_em4', 0, 0, 8), station('sta_c', 1, 1)]);
    const em4 = layout.cards.get('sta_em4');
    const other = layout.cards.get('sta_c');
    expect(other?.y).toBe((em4?.y ?? 0) + 2 * PITCH_Y);
    const cards = [...layout.cards.values()];
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i];
        const b = cards[j];
        if (a != null && b != null) expect(cardRectsOverlap(a, b)).toBe(false);
      }
    }
  });

  it('leaves a site without units exactly as it was', () => {
    const plain = [station('sta_a', 0, 0), station('sta_b', 3, 0), station('sta_c', 1, 1)];
    const bays = stationBays(plain, garage);
    const blocked = new Set(['1:0']);
    const board = packUnitCardGrid(plain, bays, layoutRowLengths(garage), blocked);
    expect(board.bays).toEqual(bays);
    expect(board.rowLengths).toEqual(layoutRowLengths(garage));
    expect(board.blocked).toEqual(blocked);
  });
});

describe('packUnitCardBays (owner decision 2026-11-12)', () => {
  it('stands the unit bays of a station side by side', () => {
    const view = expandUnitStations([station('sta_em4', 0, 0, 8)], garage);
    const bays = packUnitCardBays(view, stationBays(view, garage));
    expect(view.map((s) => bays.get(s.id)?.col)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('packs a run from its own first bay', () => {
    const view = expandUnitStations([station('sta_em4', 2, 1, 3)], garage);
    const bays = packUnitCardBays(view, stationBays(view, garage));
    expect(view.map((s) => bays.get(s.id))).toEqual([
      { col: 2, row: 1 },
      { col: 3, row: 1 },
      { col: 4, row: 1 },
    ]);
  });

  it('keeps every station without units in its own bay', () => {
    const plain = [station('sta_a', 0, 0), station('sta_b', 3, 0), station('sta_c', 1, 1)];
    const bays = stationBays(plain, garage);
    expect(packUnitCardBays(plain, bays)).toEqual(bays);
    // Beside a station with units, a station without units keeps its bay too.
    const view = expandUnitStations([station('sta_em4', 0, 0, 4), station('sta_c', 1, 1)], garage);
    const mixed = stationBays(view, garage);
    expect(packUnitCardBays(view, mixed).get('sta_c')).toEqual(mixed.get('sta_c'));
  });
});
