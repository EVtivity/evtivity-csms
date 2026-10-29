// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout grid, shared by the API placement, the migration test, the
// 2D card view and the 3D view. Positions are pixels on the 2D board; slot
// (c, r) sits at x = 20 + 200 c, y = 20 + 140 r. The 3D view shows slot (c, r)
// as parking bay (c, r), so both views read and write the same positions.

/** Columns of the grid a new station is placed on. */
export const LAYOUT_COLUMNS = 5;
/** Horizontal distance between two slots, in px. */
export const LAYOUT_SPACING_X = 200;
/** Vertical distance between two slots, in px. */
export const LAYOUT_SPACING_Y = 140;
/** Board padding before the first slot, in px. */
export const LAYOUT_PADDING = 20;
/** Snap step of a 2D drag, in px. */
export const LAYOUT_SNAP = 20;
/** Footprint of a station card used for the overlap check, in px. */
export const LAYOUT_CARD_WIDTH = 160;
export const LAYOUT_CARD_HEIGHT = 120;

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBay {
  col: number;
  row: number;
}

/** The px position of grid slot (col, row). */
export function bayToPosition(bay: LayoutBay): LayoutPoint {
  return {
    x: LAYOUT_PADDING + bay.col * LAYOUT_SPACING_X,
    y: LAYOUT_PADDING + bay.row * LAYOUT_SPACING_Y,
  };
}

/** The grid slot nearest a px position, never negative. */
export function positionToBay(point: LayoutPoint): LayoutBay {
  return {
    col: Math.max(0, Math.round((point.x - LAYOUT_PADDING) / LAYOUT_SPACING_X)),
    row: Math.max(0, Math.round((point.y - LAYOUT_PADDING) / LAYOUT_SPACING_Y)),
  };
}

/** Whether two card footprints at these positions overlap. */
export function cardsOverlap(a: LayoutPoint, b: LayoutPoint): boolean {
  return (
    a.x < b.x + LAYOUT_CARD_WIDTH &&
    b.x < a.x + LAYOUT_CARD_WIDTH &&
    a.y < b.y + LAYOUT_CARD_HEIGHT &&
    b.y < a.y + LAYOUT_CARD_HEIGHT
  );
}

/**
 * The first grid slot, row by row, whose card overlaps none of `placed`. The
 * grid has LAYOUT_COLUMNS columns and as many rows as needed.
 */
export function firstFreeSlot(placed: readonly LayoutPoint[]): LayoutPoint {
  for (let row = 0; ; row++) {
    for (let col = 0; col < LAYOUT_COLUMNS; col++) {
      const slot = bayToPosition({ col, row });
      if (!placed.some((p) => cardsOverlap(p, slot))) return slot;
    }
  }
}

/**
 * Free slots for stations without a stored position, in the order given: each
 * takes the first slot free of `placed` and of the slots handed out before it.
 */
export function freeSlotsFor(count: number, placed: readonly LayoutPoint[]): LayoutPoint[] {
  const taken = [...placed];
  const out: LayoutPoint[] = [];
  for (let i = 0; i < count; i++) {
    const slot = firstFreeSlot(taken);
    taken.push(slot);
    out.push(slot);
  }
  return out;
}

export interface LayoutBounds {
  /** Board width in px (the card must end inside it). */
  width: number;
  /** Board height in px. */
  height: number;
}

function snap(value: number): number {
  return Math.round(value / LAYOUT_SNAP) * LAYOUT_SNAP;
}

/**
 * Where a 2D card dropped at `target` lands: snapped to the 20 px grid, inside
 * the board, and on no other card. When the snapped spot overlaps another card,
 * the nearest free grid point (by distance from the drop) wins; when the board
 * has no free point, the card stays at `fallback`.
 */
export function resolveCardDrop(
  target: LayoutPoint,
  others: readonly LayoutPoint[],
  bounds: LayoutBounds,
  fallback: LayoutPoint,
): LayoutPoint {
  const maxX = Math.max(
    0,
    Math.floor((bounds.width - LAYOUT_CARD_WIDTH) / LAYOUT_SNAP) * LAYOUT_SNAP,
  );
  const maxY = Math.max(
    0,
    Math.floor((bounds.height - LAYOUT_CARD_HEIGHT) / LAYOUT_SNAP) * LAYOUT_SNAP,
  );
  const clamp = (p: LayoutPoint): LayoutPoint => ({
    x: Math.min(maxX, Math.max(0, snap(p.x))),
    y: Math.min(maxY, Math.max(0, snap(p.y))),
  });
  const start = clamp(target);
  const free = (p: LayoutPoint): boolean => !others.some((o) => cardsOverlap(o, p));
  if (free(start)) return start;
  let best: LayoutPoint | null = null;
  let bestDistance = Infinity;
  for (let y = 0; y <= maxY; y += LAYOUT_SNAP) {
    for (let x = 0; x <= maxX; x += LAYOUT_SNAP) {
      const p = { x, y };
      const d = (x - start.x) ** 2 + (y - start.y) ** 2;
      if (d < bestDistance && free(p)) {
        best = p;
        bestDistance = d;
      }
    }
  }
  return best ?? fallback;
}

/**
 * The bay each station shows in, in the order given: its own bay when no
 * earlier station holds it, else the nearest free bay within `columns`.
 */
export function assignBays(positions: readonly LayoutPoint[], columns: number): LayoutBay[] {
  const taken = new Set<string>();
  const key = (b: LayoutBay): string => `${String(b.col)}:${String(b.row)}`;
  return positions.map((p) => {
    const own = positionToBay(p);
    const wanted = { col: Math.min(own.col, columns - 1), row: own.row };
    if (!taken.has(key(wanted))) {
      taken.add(key(wanted));
      return wanted;
    }
    for (let radius = 1; ; radius++) {
      let best: LayoutBay | null = null;
      let bestDistance = Infinity;
      for (let row = Math.max(0, wanted.row - radius); row <= wanted.row + radius; row++) {
        for (
          let col = Math.max(0, wanted.col - radius);
          col <= Math.min(columns - 1, wanted.col + radius);
          col++
        ) {
          const bay = { col, row };
          if (taken.has(key(bay))) continue;
          const d = (col - wanted.col) ** 2 + (row - wanted.row) ** 2;
          if (d < bestDistance) {
            best = bay;
            bestDistance = d;
          }
        }
      }
      if (best != null) {
        taken.add(key(best));
        return best;
      }
    }
  });
}

/**
 * The bay a 3D drop lands in: the bay under the pointer when free, else the
 * nearest free bay inside the lot. `occupied` holds the bays of the other
 * stations. Returns null when the lot has no free bay.
 */
export function nearestFreeBay(
  target: LayoutBay,
  occupied: readonly LayoutBay[],
  columns: number,
  rows: number,
): LayoutBay | null {
  const isTaken = (b: LayoutBay): boolean =>
    occupied.some((o) => o.col === b.col && o.row === b.row);
  const clamped = {
    col: Math.min(columns - 1, Math.max(0, target.col)),
    row: Math.min(rows - 1, Math.max(0, target.row)),
  };
  if (!isTaken(clamped)) return clamped;
  let best: LayoutBay | null = null;
  let bestDistance = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const bay = { col, row };
      if (isTaken(bay)) continue;
      const d = (col - clamped.col) ** 2 + (row - clamped.row) ** 2;
      if (d < bestDistance) {
        best = bay;
        bestDistance = d;
      }
    }
  }
  return best;
}
