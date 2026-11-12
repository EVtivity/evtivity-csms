// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The free 2D board (owner decisions 2026-11-03): an unlimited pan and zoom
// canvas where each station card stands at its saved board position, else at
// its computed default slot (`site-layout-2d-placement.ts`). A card lands
// exactly where it is dropped, with no grid. Cards never overlap: a drop onto
// another card moves the shortest distance until it just clears, and a
// station without a saved position takes the free place nearest its default
// slot. Pure: no React, no DOM.

import { CARD_GAP, STATION_CARD_SIZE } from './site-layout-2d-placement';

/** Board px an arrow key moves a focused card (Shift: 4 times). */
export const BOARD_KEY_STEP = 12;
/** The zoom range of the board view. */
export const BOARD_ZOOM = { min: 0.2, max: 2 } as const;

export interface BoardPoint {
  x: number;
  y: number;
}

/** The board view: board point (0, 0) at screen (panX, panY), board px times `zoom`. */
export interface BoardView {
  panX: number;
  panY: number;
  zoom: number;
}

/** Whether two cards at these corners come closer than `CARD_GAP` (so they would overlap or touch). */
export function cardsTooClose(
  a: BoardPoint,
  b: BoardPoint,
  cardHeight: number = STATION_CARD_SIZE.height,
): boolean {
  return (
    a.x < b.x + STATION_CARD_SIZE.width + CARD_GAP &&
    b.x < a.x + STATION_CARD_SIZE.width + CARD_GAP &&
    a.y < b.y + cardHeight + CARD_GAP &&
    b.y < a.y + cardHeight + CARD_GAP
  );
}

/**
 * The free place nearest `target`: the target itself when no card of `others`
 * is too close, else the nearest point clear of every one. That point lies on
 * the edge of the cards' keep-out boxes, so its x is the target's or one at a
 * box side. For each such x, nearest first, the cards whose keep-out spans it
 * block open runs of y; the nearest clear y on that line is the target's or
 * the end of the run that holds it. The search stops once a line's x alone is
 * farther than the best place found.
 */
export function slideToFree(
  target: BoardPoint,
  others: readonly BoardPoint[],
  cardHeight: number = STATION_CARD_SIZE.height,
): BoardPoint {
  if (!others.some((o) => cardsTooClose(target, o, cardHeight))) return target;
  const reachX = STATION_CARD_SIZE.width + CARD_GAP;
  const reachY = cardHeight + CARD_GAP;
  const xs = [target.x, ...others.flatMap((o) => [o.x - reachX, o.x + reachX])].sort(
    (a, b) => Math.abs(a - target.x) - Math.abs(b - target.x),
  );
  let best = target;
  let bestD = Infinity;
  for (const x of xs) {
    const dx = Math.abs(x - target.x);
    if (dx >= bestD) break;
    // Open y runs the cards spanning this x keep out, merged.
    const runs = others
      .filter((o) => x > o.x - reachX && x < o.x + reachX)
      .map((o) => [o.y - reachY, o.y + reachY] as const)
      .sort((u, v) => u[0] - v[0]);
    let y = target.y;
    let lo = Number.NaN;
    let hi = Number.NaN;
    // One pass over the sorted runs, closing each merged run before the next starts.
    for (const [start, end] of [...runs, [Infinity, Infinity] as const]) {
      if (start < hi) {
        hi = Math.max(hi, end);
        continue;
      }
      if (target.y > lo && target.y < hi) {
        y = target.y - lo <= hi - target.y ? lo : hi;
        break;
      }
      lo = start;
      hi = end;
    }
    const d = Math.hypot(dx, y - target.y);
    if (d < bestD) {
      best = { x, y };
      bestD = d;
    }
  }
  return best;
}

/**
 * Where every card stands: a fixed position (a pending move or a saved board
 * position) as it is, a station without one at the free place nearest its
 * default slot, in the order given, clear of every card placed before it.
 */
export function boardPositions(
  stations: ReadonlyArray<{ id: string; fixed: BoardPoint | null; slot: BoardPoint }>,
  cardHeight: number = STATION_CARD_SIZE.height,
): Map<string, BoardPoint> {
  const out = new Map<string, BoardPoint>();
  for (const s of stations) if (s.fixed != null) out.set(s.id, s.fixed);
  for (const s of stations) {
    if (s.fixed != null) continue;
    const others = [...out.values()];
    out.set(
      s.id,
      others.some((o) => cardsTooClose(s.slot, o, cardHeight))
        ? slideToFree(s.slot, others, cardHeight)
        : s.slot,
    );
  }
  return out;
}

/** The box around every card, in board px; null without cards. */
export function cardsBounds(
  points: Iterable<BoardPoint>,
  cardHeight: number = STATION_CARD_SIZE.height,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const p of points) {
    const maxX = p.x + STATION_CARD_SIZE.width;
    const maxY = p.y + cardHeight;
    box =
      box == null
        ? { minX: p.x, minY: p.y, maxX, maxY }
        : {
            minX: Math.min(box.minX, p.x),
            minY: Math.min(box.minY, p.y),
            maxX: Math.max(box.maxX, maxX),
            maxY: Math.max(box.maxY, maxY),
          };
  }
  return box;
}

export function clampZoom(zoom: number): number {
  return Math.min(BOARD_ZOOM.max, Math.max(BOARD_ZOOM.min, zoom));
}

/** The lowest zoom the board opens at, so the cards stay readable; Fit goes lower. */
export const BOARD_OPEN_MIN_ZOOM = 0.6;

/**
 * The view that frames every card in a `width` by `height` viewport with
 * `padding` px around (zoomed in no further than 1, the cards' own size).
 * With `minZoom` the view zooms out no further than that and, when every card
 * does not fit then, shows the cards from their top left corner.
 */
export function fitBoardView(
  points: Iterable<BoardPoint>,
  width: number,
  height: number,
  padding = 24,
  minZoom: number = BOARD_ZOOM.min,
  cardHeight: number = STATION_CARD_SIZE.height,
): BoardView {
  const box = cardsBounds(points, cardHeight);
  if (box == null || width <= 0 || height <= 0) return { panX: padding, panY: padding, zoom: 1 };
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const fits = Math.min(
    1,
    (width - 2 * padding) / Math.max(1, w),
    (height - 2 * padding) / Math.max(1, h),
  );
  const zoom = clampZoom(Math.max(fits, Math.min(1, minZoom)));
  const centered = (size: number, extent: number, min: number): number =>
    extent * zoom <= size - 2 * padding
      ? (size - extent * zoom) / 2 - min * zoom
      : padding - min * zoom;
  return { zoom, panX: centered(width, w, box.minX), panY: centered(height, h, box.minY) };
}

/** The view zoomed by `factor` around a screen point, which stays over the same board point. */
export function zoomViewAt(view: BoardView, factor: number, at: BoardPoint): BoardView {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, panX: at.x - (at.x - view.panX) * k, panY: at.y - (at.y - view.panY) * k };
}

/** A screen point (relative to the viewport) on the board. */
export function screenToBoard(view: BoardView, p: BoardPoint): BoardPoint {
  return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom };
}
