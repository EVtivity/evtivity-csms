// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  assignBays,
  bayToPosition,
  cardsOverlap,
  firstFreeSlot,
  freeSlotsFor,
  nearestFreeBay,
  positionToBay,
  resolveCardDrop,
} from '../site-layout.js';

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
    const fullRow = [0, 1, 2, 3, 4].map((col) => bayToPosition({ col, row: 0 }));
    expect(firstFreeSlot(fullRow)).toEqual({ x: 20, y: 160 });
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
