// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  STATION_CARD_SIZE,
  boardScale,
  cardRectsOverlap,
  customCardLayout,
  depotCardLayout,
  depotColumns,
  gridCardLayout,
  nearestFreeSlot,
  stepSlot,
  UNIT_BOARD_CARD_HEIGHT,
  CARD_GAP,
  bayKey,
  type CardLayout,
} from '../site-layout-2d-placement';

const WIDTHS = [360, 1440];
const COUNTS = Array.from({ length: 150 }, (_, i) => i + 1);

// Every pair of cards apart, every card inside the board.
function expectNoOverlap(layout: CardLayout, label: string): void {
  const cards = [...layout.cards.values()];
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i];
    if (a == null) continue;
    expect(a.x, label).toBeGreaterThanOrEqual(0);
    expect(a.y, label).toBeGreaterThanOrEqual(0);
    expect(a.x + STATION_CARD_SIZE.width, label).toBeLessThanOrEqual(layout.width);
    expect(a.y + STATION_CARD_SIZE.height, label).toBeLessThanOrEqual(layout.height);
    for (let j = i + 1; j < cards.length; j++) {
      const b = cards[j];
      if (b != null && cardRectsOverlap(a, b)) {
        throw new Error(`${label}: cards ${a.key} and ${b.key} overlap`);
      }
    }
  }
}

// A seeded random, so the cases are the same on every run.
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('2D card placement', () => {
  it('places 1 to 150 stations on a parking lot, office or retail row and street without overlap', () => {
    for (const n of COUNTS) {
      // Rows of 10 spots, every station in its own spot; and a street of two curbs.
      const lot = Array.from({ length: n }, (_, i) => ({
        id: `s${String(i)}`,
        bay: { col: i % 10, row: Math.floor(i / 10) },
      }));
      expectNoOverlap(gridCardLayout(lot, Array(Math.ceil(n / 10)).fill(10)), `lot ${String(n)}`);
      const street = Array.from({ length: n }, (_, i) => ({
        id: `s${String(i)}`,
        bay: { col: Math.floor(i / 2), row: i % 2 },
      }));
      const side = Math.ceil(n / 2);
      expectNoOverlap(gridCardLayout(street, [side, side]), `street ${String(n)}`);
      const office = Array.from({ length: n }, (_, i) => ({
        id: `s${String(i)}`,
        bay: { col: i, row: 0 },
      }));
      expectNoOverlap(gridCardLayout(office, [n]), `office ${String(n)}`);
    }
  });

  it('places 1 to 150 depot stations without overlap at 360 and 1440 px, wrapping to the width', () => {
    for (const width of WIDTHS) {
      for (const n of COUNTS) {
        const bus = Math.ceil(n / 2);
        const stations = Array.from({ length: n }, (_, i) => ({
          id: `s${String(i)}`,
          bay: i < bus ? { col: i, row: 0 } : { col: i - bus, row: 1 },
        }));
        const layout = depotCardLayout(stations, [bus, n - bus], width / boardScale(width));
        expectNoOverlap(layout, `depot ${String(n)} at ${String(width)}`);
        // Bus bays first, then the truck lanes below them.
        const lastBus = layout.cards.get(`s${String(bus - 1)}`);
        const firstTruck = n > bus ? layout.cards.get(`s${String(bus)}`) : undefined;
        if (lastBus != null && firstTruck != null) expect(firstTruck.y).toBeGreaterThan(lastBus.y);
      }
    }
  });

  it('places 1 to 150 custom stations without overlap, also stacked on one point', () => {
    const rnd = random(7);
    for (const n of COUNTS) {
      const scattered = Array.from({ length: n }, (_, i) => ({
        id: `s${String(i)}`,
        x: rnd() * 120 - 20,
        z: rnd() * 80 - 10,
      }));
      expectNoOverlap(customCardLayout(scattered), `custom ${String(n)}`);
      expectNoOverlap(customCardLayout(scattered, true), `custom ring ${String(n)}`);
      const stacked = Array.from({ length: n }, (_, i) => ({ id: `s${String(i)}`, x: 5, z: 5 }));
      expectNoOverlap(customCardLayout(stacked), `custom stacked ${String(n)}`);
    }
  });

  it('keeps each site type in its order', () => {
    // A lot: spot (col, row) to slot (col, row).
    const grid = gridCardLayout(
      [
        { id: 'a', bay: { col: 3, row: 1 } },
        { id: 'b', bay: { col: 0, row: 0 } },
      ],
      [5, 5],
    );
    expect(grid.cards.get('a')).toMatchObject({ col: 3, row: 1 });
    expect((grid.cards.get('a')?.x ?? 0) > (grid.cards.get('b')?.x ?? 0)).toBe(true);
    // A custom site: front to back, then left to right, without the gaps of the site.
    const custom = customCardLayout([
      { id: 'back', x: 0, z: 60 },
      { id: 'right', x: 90, z: 0 },
      { id: 'left', x: 0, z: 0 },
    ]);
    expect(custom.cards.get('left')).toMatchObject({ col: 0, row: 0 });
    expect(custom.cards.get('right')).toMatchObject({ col: 1, row: 0 });
    expect(custom.cards.get('back')).toMatchObject({ col: 0, row: 1 });
  });

  it('wraps a depot to at least two columns and scales a phone board to two cards', () => {
    expect(depotColumns(300)).toBe(2);
    expect(depotColumns(1440)).toBe(6);
    expect(boardScale(1440)).toBe(1);
    const phone = boardScale(343);
    expect(phone).toBeLessThan(1);
    expect(depotColumns(343 / phone)).toBe(2);
  });

  it('drops a card in the nearest free slot and never on a held spot or another card', () => {
    const layout = gridCardLayout(
      [
        { id: 'a', bay: { col: 0, row: 0 } },
        { id: 'b', bay: { col: 1, row: 0 } },
      ],
      [4],
      new Set([bayKey(2, 0)]),
    );
    const b = layout.cards.get('b');
    if (b == null) throw new Error('no slot');
    // Dropped right on b: the nearest free slot that is not a's.
    const drop = nearestFreeSlot(layout, 'a', { x: b.x + 10, y: b.y + 10 });
    expect(drop?.key).toBe(bayKey(0, 0));
    const far = nearestFreeSlot(layout, 'a', { x: 10_000, y: 0 });
    expect(far?.key).toBe(bayKey(3, 0));
  });

  it('moves a card to the next free slot with the arrow keys, skipping taken and held ones', () => {
    const layout = gridCardLayout(
      [
        { id: 'a', bay: { col: 0, row: 0 } },
        { id: 'b', bay: { col: 1, row: 0 } },
      ],
      [4, 4],
      new Set([bayKey(2, 0)]),
    );
    expect(stepSlot(layout, 'a', 'right')?.key).toBe(bayKey(3, 0));
    expect(stepSlot(layout, 'a', 'down')?.key).toBe(bayKey(0, 1));
    expect(stepSlot(layout, 'a', 'left')).toBeNull();
    expect(stepSlot(layout, 'a', 'up')).toBeNull();
  });

  it('maps a custom slot back to a site point, past the outermost stations too', () => {
    const layout = customCardLayout(
      [
        { id: 'a', x: 0, z: 0 },
        { id: 'b', x: 30, z: 0 },
      ],
      true,
    );
    expect(layout.slotPoint({ col: 1, row: 0 })).toEqual({ x: 30, z: 0 });
    expect(layout.slotPoint({ col: 2, row: 0 }).x).toBeGreaterThan(30);
    expect(layout.slotPoint({ col: -1, row: 0 }).x).toBeLessThan(0);
    expect(layout.slotPoint({ col: 0, row: 1 }).z).toBeGreaterThan(0);
  });
});

describe('the card height of a board with unit cards (owner decision 2026-11-12)', () => {
  const stations = [0, 1, 2].map((row) => ({ id: `s${String(row)}`, bay: { col: 0, row } }));

  it('keeps the station card height by default', () => {
    const layout = gridCardLayout(stations, [2, 2, 2]);
    expect(layout.cardHeight).toBe(STATION_CARD_SIZE.height);
    expect(layout.cards.get('s1')?.y).toBe(12 + STATION_CARD_SIZE.height + CARD_GAP);
  });

  it('spaces every layout by the taller unit board card, with no card overlapping', () => {
    const grid = gridCardLayout(stations, [2, 2, 2], new Set(), UNIT_BOARD_CARD_HEIGHT);
    expect(grid.cardHeight).toBe(UNIT_BOARD_CARD_HEIGHT);
    expect(grid.cards.get('s1')?.y).toBe(12 + UNIT_BOARD_CARD_HEIGHT + CARD_GAP);
    const depot = depotCardLayout(stations, [1, 1, 1], 1440, UNIT_BOARD_CARD_HEIGHT);
    const custom = customCardLayout(
      stations.map((s, i) => ({ id: s.id, x: 0, z: i * 6 })),
      false,
      UNIT_BOARD_CARD_HEIGHT,
    );
    for (const layout of [grid, depot, custom]) {
      const cards = [...layout.cards.values()];
      for (const a of cards) {
        expect(a.y + UNIT_BOARD_CARD_HEIGHT).toBeLessThanOrEqual(layout.height);
        for (const b of cards) {
          if (a !== b) expect(cardRectsOverlap(a, b, UNIT_BOARD_CARD_HEIGHT)).toBe(false);
        }
      }
    }
  });
});
