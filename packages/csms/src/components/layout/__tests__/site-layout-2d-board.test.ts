// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  BOARD_ZOOM,
  boardPositions,
  cardsBounds,
  cardsTooClose,
  clampZoom,
  fitBoardView,
  screenToBoard,
  slideToFree,
  zoomViewAt,
  type BoardPoint,
} from '../site-layout-2d-board';
import { CARD_GAP, STATION_CARD_SIZE } from '../site-layout-2d-placement';

const W = STATION_CARD_SIZE.width;
const H = STATION_CARD_SIZE.height;

function overlaps(a: BoardPoint, b: BoardPoint): boolean {
  return a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H;
}

/** A seeded 32-bit generator (mulberry32): the same seed gives the same drops on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The nearest clear place by checking every candidate of every card (the slow reference). */
function referenceSlide(target: BoardPoint, others: readonly BoardPoint[]): BoardPoint {
  const clear = (p: BoardPoint): boolean => !others.some((o) => cardsTooClose(p, o));
  if (clear(target)) return target;
  const xs = [target.x, ...others.flatMap((o) => [o.x - W - CARD_GAP, o.x + W + CARD_GAP])];
  const ys = [target.y, ...others.flatMap((o) => [o.y - H - CARD_GAP, o.y + H + CARD_GAP])];
  let best = target;
  let bestD = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const d = (x - target.x) ** 2 + (y - target.y) ** 2;
      if (d < bestD && clear({ x, y })) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best;
}

const dist = (a: BoardPoint, b: BoardPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('cardsTooClose', () => {
  it('keeps a gap of CARD_GAP between cards', () => {
    expect(cardsTooClose({ x: 0, y: 0 }, { x: W + CARD_GAP, y: 0 })).toBe(false);
    expect(cardsTooClose({ x: 0, y: 0 }, { x: W + CARD_GAP - 1, y: 0 })).toBe(true);
    expect(cardsTooClose({ x: 0, y: 0 }, { x: 0, y: H + CARD_GAP })).toBe(false);
    expect(cardsTooClose({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true);
  });
});

describe('slideToFree', () => {
  it('lands exactly where a card is dropped when nothing is in the way', () => {
    expect(slideToFree({ x: 17.25, y: -31 }, [{ x: 600, y: 600 }])).toEqual({ x: 17.25, y: -31 });
  });

  it('moves a card dropped onto another the shortest distance until it just clears', () => {
    const other = { x: 0, y: 0 };
    // Up is nearest: exactly a card height plus the gap above the other card.
    const up = slideToFree({ x: 24, y: 0 }, [other]);
    expect(up).toEqual({ x: 24, y: -(H + CARD_GAP) });
    expect(cardsTooClose(up, other)).toBe(false);
    // Dropped near the right edge: exactly the card width plus the gap to the right.
    expect(slideToFree({ x: 200, y: 30 }, [other])).toEqual({ x: W + CARD_GAP, y: 30 });
  });

  it('finds the nearest clear corner between several cards', () => {
    const others = [
      { x: 0, y: 0 },
      { x: W + CARD_GAP, y: 0 },
      { x: 0, y: H + CARD_GAP },
    ];
    const p = slideToFree({ x: 120, y: 80 }, others);
    expect(others.some((o) => cardsTooClose(p, o))).toBe(false);
  });

  it('lands clear and as near as the reference for 30 seeds of random boards and drops', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = seeded(seed);
      const cards: BoardPoint[] = [];
      // Dense boards too: up to 80 cards in a box that holds about 70.
      const count = 10 + Math.floor(rand() * 70);
      while (cards.length < count) {
        cards.push(slideToFree({ x: rand() * 2400, y: rand() * 1400 }, cards));
      }
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          expect(overlaps(cards[i]!, cards[j]!), `seed ${String(seed)}`).toBe(false);
        }
      }
      for (let i = 0; i < 20; i++) {
        const target = { x: rand() * 2400, y: rand() * 1400 };
        const p = slideToFree(target, cards);
        expect(
          cards.some((c) => cardsTooClose(p, c)),
          `seed ${String(seed)}`,
        ).toBe(false);
        if (!cards.some((c) => cardsTooClose(target, c))) expect(p).toEqual(target);
        expect(dist(p, target)).toBeCloseTo(dist(referenceSlide(target, cards), target), 6);
      }
    }
  });

  it('clears a drop exactly on a corner, on an edge and inside a full cluster', () => {
    const reachX = W + CARD_GAP;
    const reachY = H + CARD_GAP;
    // A 5 by 5 cluster with no gap inside it.
    const cluster: BoardPoint[] = [];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++) cluster.push({ x: c * reachX, y: r * reachY });
    for (const target of [
      { x: 0, y: 0 },
      { x: reachX, y: reachY },
      { x: 2 * reachX + reachX / 2, y: 2 * reachY + reachY / 2 },
      { x: 4 * reachX, y: 2 * reachY },
      { x: -reachX + 0.5, y: 0 },
    ]) {
      const p = slideToFree(target, cluster);
      expect(cluster.some((o) => cardsTooClose(p, o))).toBe(false);
      expect(dist(p, target)).toBeCloseTo(dist(referenceSlide(target, cluster), target), 6);
    }
    // Exactly at the keep-out edge counts as clear and stays put.
    expect(slideToFree({ x: reachX, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: reachX, y: 0 });
  });

  it('answers a drop on a board of 150 cards quickly', () => {
    const cards: BoardPoint[] = [];
    for (let i = 0; i < 150; i++)
      cards.push({ x: (i % 15) * (W + CARD_GAP), y: Math.floor(i / 15) * (H + CARD_GAP) });
    const started = performance.now();
    for (let i = 0; i < 200; i++) slideToFree({ x: (i * 37) % 3000, y: (i * 53) % 1300 }, cards);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('boardPositions', () => {
  it('keeps saved positions and puts the others at their slot, or the free place nearest it', () => {
    const out = boardPositions([
      { id: 'a', fixed: { x: 0, y: 0 }, slot: { x: 500, y: 500 } },
      { id: 'b', fixed: null, slot: { x: 1000, y: 0 } },
      { id: 'c', fixed: null, slot: { x: 12, y: 12 } },
    ]);
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('b')).toEqual({ x: 1000, y: 0 });
    const c = out.get('c')!;
    expect(cardsTooClose(c, { x: 0, y: 0 })).toBe(false);
    expect(cardsTooClose(c, { x: 1000, y: 0 })).toBe(false);
  });

  it('lays a new station near the others without overlapping any', () => {
    const stations = Array.from({ length: 30 }, (_, i) => ({
      id: `s${String(i)}`,
      fixed: i < 29 ? { x: (i % 6) * 240, y: Math.floor(i / 6) * 144 } : null,
      slot: { x: 0, y: 0 },
    }));
    const out = boardPositions(stations);
    const newOne = out.get('s29')!;
    for (const [id, p] of out) if (id !== 's29') expect(cardsTooClose(newOne, p)).toBe(false);
    expect(Math.hypot(newOne.x, newOne.y)).toBeLessThan(1500);
  });
});

describe('board view', () => {
  it('frames every card, no closer than the cards own size', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2000, y: 1000 },
    ];
    const v = fitBoardView(points, 1000, 700);
    const box = cardsBounds(points)!;
    expect(box.minX * v.zoom + v.panX).toBeGreaterThanOrEqual(23.9);
    expect(box.maxX * v.zoom + v.panX).toBeLessThanOrEqual(1000 - 23.9);
    expect(box.maxY * v.zoom + v.panY).toBeLessThanOrEqual(700 - 23.9);
    expect(fitBoardView([{ x: 0, y: 0 }], 1000, 700).zoom).toBe(1);
  });

  it('opens no smaller than the minimum zoom, from the top left card', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({
      x: (i % 10) * 240,
      y: (i / 10) * 144,
    }));
    const v = fitBoardView(points, 1000, 700, 24, 0.6);
    expect(v.zoom).toBe(0.6);
    expect(v.panX).toBe(24);
    expect(v.panY).toBe(24);
  });

  it('zooms around the pointer and within its range', () => {
    const v = zoomViewAt({ panX: 0, panY: 0, zoom: 1 }, 2, { x: 100, y: 50 });
    expect(v.zoom).toBe(2);
    expect(screenToBoard(v, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(clampZoom(10)).toBe(BOARD_ZOOM.max);
    expect(clampZoom(0.01)).toBe(BOARD_ZOOM.min);
  });
});
