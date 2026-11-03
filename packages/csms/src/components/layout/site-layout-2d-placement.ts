// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where the 2D board shows each charger card (owner request 2026-11-02:
// cards never collide). Every card has one fixed size, sized for its largest
// content (two EVSE rows, two status badges in the longest locale), and
// stands in one slot of a grid of card-size cells with a gap between them,
// so no two cards overlap at any zoom or screen width. Each site type keeps
// its order: a parking lot, office or retail row or street keeps its rows
// and spots; a depot lists its bus bays, then its truck lanes, wrapping to
// the board width; a custom site sorts its free positions spatially. Pure:
// no React, no DOM.

/** The one size of every 2D charger card, in px. */
export const STATION_CARD_SIZE = { width: 216, height: 128 } as const;
/** The gap between two card slots, and the board's padding, in px. */
export const CARD_GAP = 12;
export const BOARD_PADDING = 12;
/** The extra gap between a depot's bus bays and its truck lanes, in px. */
export const DEPOT_SECTION_GAP = 24;
const CELL_W = STATION_CARD_SIZE.width + CARD_GAP;
const CELL_H = STATION_CARD_SIZE.height + CARD_GAP;

/** A card slot: its cell in the board's own grid and its top left corner in px. */
export interface CardSlot {
  /** The slot's place: a layout bay (`col:row`), a depot bay or lane, or a custom cell. */
  key: string;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface CardLayout {
  width: number;
  height: number;
  /** The slot each station's card stands in. */
  cards: Map<string, CardSlot>;
  /** Every slot a card may take (a card's own included), for drops and arrow moves. */
  slots: CardSlot[];
}

/** The width two card columns need on a board, in px. */
export const TWO_COLUMN_WIDTH = 2 * BOARD_PADDING + 2 * STATION_CARD_SIZE.width + CARD_GAP;

/**
 * How much a board scales its cards (1 or less): a board narrower than two
 * card columns (a phone) shows two at a smaller scale, the card size kept.
 */
export function boardScale(boardWidth: number): number {
  return boardWidth > 0 ? Math.min(1, boardWidth / TWO_COLUMN_WIDTH) : 1;
}

export function bayKey(col: number, row: number): string {
  return `${String(col)}:${String(row)}`;
}

function extent(slots: readonly CardSlot[]): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const s of slots) {
    w = Math.max(w, s.x + STATION_CARD_SIZE.width);
    h = Math.max(h, s.y + STATION_CARD_SIZE.height);
  }
  return { width: w + BOARD_PADDING, height: h + BOARD_PADDING };
}

/**
 * A parking lot, office or retail row or street: the card of the station in
 * spot (col, row) in slot (col, row), so the rows and spots keep their order.
 * Every spot of `rowLengths` is a slot except `blocked` ones (a dual-port
 * pedestal's partner spot, a split system's dispenser spots, the accessible
 * access aisle: `bayKey` keys). A station outside the rows keeps its own slot.
 */
export function gridCardLayout(
  stations: ReadonlyArray<{ id: string; bay: { col: number; row: number } }>,
  rowLengths: readonly number[],
  blocked: ReadonlySet<string> = new Set(),
): CardLayout {
  const at = (col: number, row: number): CardSlot => ({
    key: bayKey(col, row),
    col,
    row,
    x: BOARD_PADDING + col * CELL_W,
    y: BOARD_PADDING + row * CELL_H,
  });
  const slots = new Map<string, CardSlot>();
  rowLengths.forEach((n, row) => {
    for (let col = 0; col < n; col++) {
      if (!blocked.has(bayKey(col, row))) slots.set(bayKey(col, row), at(col, row));
    }
  });
  const cards = new Map<string, CardSlot>();
  for (const s of stations) {
    const slot = slots.get(bayKey(s.bay.col, s.bay.row)) ?? at(s.bay.col, s.bay.row);
    slots.set(slot.key, slot);
    cards.set(s.id, slot);
  }
  const all = [...slots.values()];
  return { ...extent(all.length > 0 ? all : [at(0, 0)]), cards, slots: all };
}

/** How many depot slots fit side by side on a board `boardWidth` px wide (at least two). */
export function depotColumns(boardWidth: number): number {
  return Math.max(2, Math.floor((boardWidth - 2 * BOARD_PADDING + CARD_GAP) / CELL_W));
}

/**
 * A depot: its bus bays (row 0) in order, wrapping to the board width, then
 * its truck lanes (row 1) below them the same way. A station past its row's
 * last bay or lane keeps a slot of its own.
 */
export function depotCardLayout(
  stations: ReadonlyArray<{ id: string; bay: { col: number; row: number } }>,
  rowLengths: readonly number[],
  boardWidth: number,
): CardLayout {
  const perLine = depotColumns(boardWidth);
  const slots: CardSlot[] = [];
  const byKey = new Map<string, CardSlot>();
  let top = BOARD_PADDING;
  const rows = Math.max(rowLengths.length, ...stations.map((s) => s.bay.row + 1));
  for (let row = 0; row < rows; row++) {
    const n = Math.max(
      rowLengths[row] ?? 0,
      ...stations.filter((s) => s.bay.row === row).map((s) => s.bay.col + 1),
    );
    if (n === 0) continue;
    for (let col = 0; col < n; col++) {
      const slot: CardSlot = {
        key: bayKey(col, row),
        col,
        row,
        x: BOARD_PADDING + (col % perLine) * CELL_W,
        y: top + Math.floor(col / perLine) * CELL_H,
      };
      slots.push(slot);
      byKey.set(slot.key, slot);
    }
    top += Math.ceil(n / perLine) * CELL_H + DEPOT_SECTION_GAP;
  }
  const cards = new Map<string, CardSlot>();
  for (const s of stations) {
    const slot = byKey.get(bayKey(s.bay.col, s.bay.row));
    if (slot != null) cards.set(s.id, slot);
  }
  return {
    ...extent(slots.length > 0 ? slots : [{ key: '', col: 0, row: 0, x: 0, y: 0 }]),
    cards,
    slots,
  };
}

/** How many meters of a custom site one card cell stands for, across and along. */
export const CUSTOM_CELL_M = { x: 3, z: 6 } as const;

export interface CustomCardLayout extends CardLayout {
  /** The site point (meters) a station dropped into a slot stands at. */
  slotPoint: (slot: Pick<CardSlot, 'col' | 'row'>) => { x: number; z: number };
}

/**
 * A custom site: each station's charger point (`x`, `z` in meters) to a cell
 * of `CUSTOM_CELL_M`, in spatial order (front to back, then left to right);
 * a station whose cell an earlier one took takes the nearest free cell. Empty
 * columns and rows are then left out, so the cards keep their arrangement
 * without the site's gaps. `ring` adds a slot ring around the cards (a drop
 * or arrow move past the outermost stations, while editing).
 */
export function customCardLayout(
  stations: ReadonlyArray<{ id: string; x: number; z: number }>,
  ring = false,
): CustomCardLayout {
  const sorted = [...stations].sort((a, b) => a.z - b.z || a.x - b.x || a.id.localeCompare(b.id));
  const minX = Math.min(0, ...sorted.map((s) => s.x));
  const minZ = Math.min(0, ...sorted.map((s) => s.z));
  const taken = new Map<string, string>();
  const raw = new Map<string, { c: number; r: number }>();
  for (const s of sorted) {
    const want = {
      c: Math.round((s.x - minX) / CUSTOM_CELL_M.x),
      r: Math.round((s.z - minZ) / CUSTOM_CELL_M.z),
    };
    let best = want;
    if (taken.has(`${String(want.c)}:${String(want.r)}`)) {
      // The nearest free cell, nearer rows first (rows are 2x as tall as columns are wide).
      let bestD = Infinity;
      for (let d = 1; d < 400 && bestD === Infinity; d++) {
        for (let dr = -d; dr <= d; dr++) {
          for (let dc = -d; dc <= d; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
            const c = want.c + dc;
            const r = want.r + dr;
            if (c < 0 || r < 0 || taken.has(`${String(c)}:${String(r)}`)) continue;
            const dist = dc * dc + 4 * dr * dr + (dr < 0 ? 0.5 : 0) + (dc < 0 ? 0.25 : 0);
            if (dist < bestD) {
              bestD = dist;
              best = { c, r };
            }
          }
        }
      }
    }
    taken.set(`${String(best.c)}:${String(best.r)}`, s.id);
    raw.set(s.id, best);
  }
  const cols = [...new Set([...raw.values()].map((p) => p.c))].sort((a, b) => a - b);
  const rows = [...new Set([...raw.values()].map((p) => p.r))].sort((a, b) => a - b);
  const colOf = new Map(cols.map((c, i) => [c, i]));
  const rowOf = new Map(rows.map((r, i) => [r, i]));
  // The site point of each kept column and row: the mean of its stations.
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const colX = cols.map((c) => mean(sorted.filter((s) => raw.get(s.id)?.c === c).map((s) => s.x)));
  const rowZ = rows.map((r) => mean(sorted.filter((s) => raw.get(s.id)?.r === r).map((s) => s.z)));
  const shift = ring ? 1 : 0;
  const at = (col: number, row: number): CardSlot => ({
    key: bayKey(col, row),
    col,
    row,
    x: BOARD_PADDING + (col + shift) * CELL_W,
    y: BOARD_PADDING + (row + shift) * CELL_H,
  });
  const cards = new Map<string, CardSlot>();
  for (const s of sorted) {
    const p = raw.get(s.id);
    if (p != null) cards.set(s.id, at(colOf.get(p.c) ?? 0, rowOf.get(p.r) ?? 0));
  }
  const nCols = Math.max(1, cols.length);
  const nRows = Math.max(1, rows.length);
  const slots: CardSlot[] = [];
  for (let row = -shift; row < nRows + shift; row++) {
    for (let col = -shift; col < nCols + shift; col++) slots.push(at(col, row));
  }
  const pointOf = (i: number, values: number[], step: number): number => {
    if (values.length === 0) return i * step;
    if (i < 0) return (values[0] ?? 0) + i * step;
    if (i >= values.length)
      return (values[values.length - 1] ?? 0) + (i - values.length + 1) * step;
    return values[i] ?? 0;
  };
  return {
    ...extent(slots),
    cards,
    slots,
    slotPoint: (slot) => ({
      x: pointOf(slot.col, colX, CUSTOM_CELL_M.x),
      z: pointOf(slot.row, rowZ, CUSTOM_CELL_M.z),
    }),
  };
}

function center(s: Pick<CardSlot, 'x' | 'y'>): { x: number; y: number } {
  return { x: s.x + STATION_CARD_SIZE.width / 2, y: s.y + STATION_CARD_SIZE.height / 2 };
}

function freeSlots(layout: CardLayout, stationId: string): CardSlot[] {
  const used = new Set<string>();
  for (const [id, slot] of layout.cards) if (id !== stationId) used.add(slot.key);
  return layout.slots.filter((s) => !used.has(s.key));
}

/**
 * The free slot nearest a point on the board (a dragged card's middle): the
 * slot a drop lands in, highlighted while dragging. The station's own slot
 * counts as free. Null when no slot is free.
 */
export function nearestFreeSlot(
  layout: CardLayout,
  stationId: string,
  point: { x: number; y: number },
): CardSlot | null {
  let best: CardSlot | null = null;
  let bestD = Infinity;
  for (const s of freeSlots(layout, stationId)) {
    const c = center(s);
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * The free slot an arrow key moves a card to: the nearest free slot in that
 * direction (the next one along a row first). Null when none lies that way.
 */
export function stepSlot(
  layout: CardLayout,
  stationId: string,
  dir: 'left' | 'right' | 'up' | 'down',
): CardSlot | null {
  const own = layout.cards.get(stationId);
  if (own == null) return null;
  const o = center(own);
  let best: CardSlot | null = null;
  let bestD = Infinity;
  for (const s of freeSlots(layout, stationId)) {
    if (s.key === own.key) continue;
    const c = center(s);
    const along =
      dir === 'left'
        ? o.x - c.x
        : dir === 'right'
          ? c.x - o.x
          : dir === 'up'
            ? o.y - c.y
            : c.y - o.y;
    const across = dir === 'left' || dir === 'right' ? Math.abs(c.y - o.y) : Math.abs(c.x - o.x);
    if (along <= 0) continue;
    // Along the direction first: a slot in the same row or column wins over a nearer diagonal one.
    const d = along + 10 * across;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Whether two card rectangles at these corners overlap (touching edges do not). */
export function cardRectsOverlap(
  a: Pick<CardSlot, 'x' | 'y'>,
  b: Pick<CardSlot, 'x' | 'y'>,
): boolean {
  return (
    a.x < b.x + STATION_CARD_SIZE.width &&
    b.x < a.x + STATION_CARD_SIZE.width &&
    a.y < b.y + STATION_CARD_SIZE.height &&
    b.y < a.y + STATION_CARD_SIZE.height
  );
}
