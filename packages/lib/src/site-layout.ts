// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout grid, shared by the API placement, the migration test, the
// 2D card view and the 3D view. Positions are pixels on the 2D board; slot
// (c, r) sits at x = 20 + 200 c, y = 20 + 140 r. The 3D view shows slot (c, r)
// as parking spot (c, r) of the paved lot, so both views read and write the
// same positions. The lot size, spot size, lanes, facing and the transformers
// on the grass around it are the site's layout settings.

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

/** The facing directions of the parking spots, in degrees. */
export const LAYOUT_FACINGS = [0, 90, 180, 270] as const;
export type LayoutFacing = (typeof LAYOUT_FACINGS)[number];

/**
 * The paved parking lot of a site. Positions stay grid slots of the 2D board
 * whatever the spot size: slot (c, r) is spot (c, r). Everything outside the
 * lot is grass.
 */
export interface SiteLayoutGrid {
  /** Spots in each row. */
  spotsPerRow: number;
  /** Number of rows. */
  rows: number;
  /** Spot width in meters. */
  spotWidthM: number;
  /** Spot depth in meters. */
  spotDepthM: number;
  /** Driving lane between two rows, in meters (0: rows back to back). */
  laneWidthM: number;
  /** Direction the spots and chargers face, in degrees (0 is the default). */
  facingDeg: LayoutFacing;
}

/**
 * A pad-mounted transformer on the grass next to the lot. `x` and `z` are
 * meters in lot coordinates: spot (0, 0) has its front left corner at (0, 0),
 * columns run along x and rows along z.
 */
export interface LayoutTransformer {
  /** Stable id within the site (letters, digits, `-` and `_`). */
  id: string;
  name: string | null;
  /** Rated power in kVA. */
  ratedKva: number | null;
  x: number;
  z: number;
}

/** The layout settings of a site (sites.layout_settings): the lot and the transformers. */
export interface SiteLayoutSettings extends SiteLayoutGrid {
  transformers: LayoutTransformer[];
}

/** The lot of a site that never set one: 20 spots, 10 in each of 2 rows. */
export const DEFAULT_LAYOUT_GRID: SiteLayoutGrid = {
  spotsPerRow: 10,
  rows: 2,
  spotWidthM: 3.2,
  spotDepthM: 5.6,
  laneWidthM: 6,
  facingDeg: 0,
};

/** Allowed ranges of the settings (inclusive). */
export const LAYOUT_GRID_LIMITS = {
  spotsPerRow: { min: 1, max: 100 },
  rows: { min: 1, max: 100 },
  spotWidthM: { min: 2, max: 6 },
  spotDepthM: { min: 4, max: 10 },
  laneWidthM: { min: 0, max: 15 },
  transformers: { max: 10 },
  transformerNameLength: 60,
  ratedKva: { min: 1, max: 100000 },
  /** How far from the lot a transformer may stand, in meters. */
  transformerReachM: 200,
} as const;

/** Distance from the lot edge to a transformer's center, at least, in meters (pad and curb). */
export const TRANSFORMER_CLEARANCE_M = 2.5;

/** The lot size in meters: rows times the spot depth plus a lane between each two rows. */
export function lotExtentM(grid: SiteLayoutGrid): { width: number; depth: number } {
  return {
    width: grid.spotsPerRow * grid.spotWidthM,
    depth: grid.rows * grid.spotDepthM + (grid.rows - 1) * grid.laneWidthM,
  };
}

/** Whether a slot lies inside the lot. */
export function bayInGrid(bay: LayoutBay, grid: SiteLayoutGrid): boolean {
  return bay.col < grid.spotsPerRow && bay.row < grid.rows;
}

/** Spots in the lot. */
export function layoutGridCapacity(grid: SiteLayoutGrid): number {
  return grid.spotsPerRow * grid.rows;
}

/** Whether two lots are the same settings. */
export function sameLayoutGrid(a: SiteLayoutGrid, b: SiteLayoutGrid): boolean {
  return (
    a.spotsPerRow === b.spotsPerRow &&
    a.rows === b.rows &&
    a.spotWidthM === b.spotWidthM &&
    a.spotDepthM === b.spotDepthM &&
    a.laneWidthM === b.laneWidthM &&
    a.facingDeg === b.facingDeg
  );
}

/** Whether two layout settings are the same (lot and transformers, in order). */
export function sameLayoutSettings(a: SiteLayoutSettings, b: SiteLayoutSettings): boolean {
  return (
    sameLayoutGrid(a, b) &&
    a.transformers.length === b.transformers.length &&
    a.transformers.every((t, i) => {
      const o = b.transformers[i];
      return (
        o != null &&
        o.id === t.id &&
        o.name === t.name &&
        o.ratedKva === t.ratedKva &&
        o.x === t.x &&
        o.z === t.z
      );
    })
  );
}

/**
 * Where a transformer may stand: on the grass, at least TRANSFORMER_CLEARANCE_M
 * from the lot, and within transformerReachM of it. A point on the lot moves
 * to the nearest lot side; positions round to 10 cm.
 */
export function snapTransformerToGrass(
  x: number,
  z: number,
  grid: SiteLayoutGrid,
): { x: number; z: number } {
  const { width, depth } = lotExtentM(grid);
  const c = TRANSFORMER_CLEARANCE_M;
  const reach = LAYOUT_GRID_LIMITS.transformerReachM;
  let px = Math.min(width + reach, Math.max(-reach, x));
  let pz = Math.min(depth + reach, Math.max(-reach, z));
  if (px > -c && px < width + c && pz > -c && pz < depth + c) {
    const toLeft = px + c;
    const toRight = width + c - px;
    const toFront = pz + c;
    const toBack = depth + c - pz;
    const nearest = Math.min(toLeft, toRight, toFront, toBack);
    if (nearest === toRight) px = width + c;
    else if (nearest === toLeft) px = -c;
    else if (nearest === toBack) pz = depth + c;
    else pz = -c;
  }
  const round = (v: number): number => Math.round(v * 10) / 10;
  return { x: round(px), z: round(pz) };
}

/** The transformer a site gets by default: one, on the grass right of the first row. */
export function defaultTransformer(grid: SiteLayoutGrid): LayoutTransformer {
  const spot = snapTransformerToGrass(
    lotExtentM(grid).width + TRANSFORMER_CLEARANCE_M + 1.5,
    Math.min(grid.spotDepthM / 2, lotExtentM(grid).depth / 2),
    grid,
  );
  return { id: 'tx-1', name: null, ratedKva: null, ...spot };
}

/**
 * The layout settings the views and the placement use. Stored settings as
 * stored (transformers moved onto the grass); a site that never saved any gets
 * the default 10 by 2 lot, grown to hold the stations it already has (`bays`),
 * and one transformer next to it.
 */
export function effectiveLayoutSettings(
  stored: SiteLayoutSettings | null | undefined,
  bays: Iterable<LayoutBay> = [],
): SiteLayoutSettings {
  if (stored != null) {
    return {
      ...stored,
      transformers: stored.transformers.map((t) => ({
        ...t,
        ...snapTransformerToGrass(t.x, t.z, stored),
      })),
    };
  }
  let spotsPerRow = DEFAULT_LAYOUT_GRID.spotsPerRow;
  let rows = DEFAULT_LAYOUT_GRID.rows;
  for (const b of bays) {
    spotsPerRow = Math.min(LAYOUT_GRID_LIMITS.spotsPerRow.max, Math.max(spotsPerRow, b.col + 1));
    rows = Math.min(LAYOUT_GRID_LIMITS.rows.max, Math.max(rows, b.row + 1));
  }
  const grid = { ...DEFAULT_LAYOUT_GRID, spotsPerRow, rows };
  return { ...grid, transformers: [defaultTransformer(grid)] };
}

/** The lot fields of the settings. */
export function layoutGridOf(settings: SiteLayoutGrid): SiteLayoutGrid {
  return {
    spotsPerRow: settings.spotsPerRow,
    rows: settings.rows,
    spotWidthM: settings.spotWidthM,
    spotDepthM: settings.spotDepthM,
    laneWidthM: settings.laneWidthM,
    facingDeg: settings.facingDeg,
  };
}

/**
 * The first slot whose card overlaps none of `placed`: row by row inside the
 * lot, then the rows below it (a station placed there stands on the grass
 * until it moves or the lot grows).
 */
export function firstFreeSlot(
  placed: readonly LayoutPoint[],
  grid: SiteLayoutGrid = DEFAULT_LAYOUT_GRID,
): LayoutPoint {
  for (let row = 0; ; row++) {
    for (let col = 0; col < grid.spotsPerRow; col++) {
      const slot = bayToPosition({ col, row });
      if (!placed.some((p) => cardsOverlap(p, slot))) return slot;
    }
  }
}

/**
 * Free slots for stations without a stored position, in the order given: each
 * takes the first slot free of `placed` and of the slots handed out before it.
 */
export function freeSlotsFor(
  count: number,
  placed: readonly LayoutPoint[],
  grid?: SiteLayoutGrid,
): LayoutPoint[] {
  const taken = [...placed];
  const out: LayoutPoint[] = [];
  for (let i = 0; i < count; i++) {
    const slot = firstFreeSlot(taken, grid);
    taken.push(slot);
    out.push(slot);
  }
  return out;
}

export interface GridFit<K> {
  /** Stations that move into the lot, with their new position. */
  moved: Map<K, LayoutPoint>;
  /** Stations outside the lot with no free spot left inside it. */
  unfit: K[];
}

/**
 * Fits stations into the lot: a station whose slot lies inside keeps its
 * position; one outside moves to the nearest free spot inside (in the order
 * given), or is listed in `unfit` when no spot is free. Positions are the px
 * positions of the 2D board.
 */
export function fitPositionsToGrid<K>(
  stations: ReadonlyArray<{ key: K; position: LayoutPoint }>,
  grid: SiteLayoutGrid,
): GridFit<K> {
  const moved = new Map<K, LayoutPoint>();
  const unfit: K[] = [];
  const bays = stations.map((s) => ({ key: s.key, bay: positionToBay(s.position) }));
  const occupied = bays.filter((b) => bayInGrid(b.bay, grid)).map((b) => b.bay);
  for (const { key, bay } of bays) {
    if (bayInGrid(bay, grid)) continue;
    const target = nearestFreeBay(bay, occupied, grid.spotsPerRow, grid.rows);
    if (target == null) {
      unfit.push(key);
      continue;
    }
    occupied.push(target);
    moved.set(key, bayToPosition(target));
  }
  return { moved, unfit };
}

/** The 2D board area of the lot: the last spot's card ends inside it. */
export function gridBoardExtent(grid: SiteLayoutGrid): { width: number; height: number } {
  return {
    width: LAYOUT_PADDING + (grid.spotsPerRow - 1) * LAYOUT_SPACING_X + LAYOUT_CARD_WIDTH,
    height: LAYOUT_PADDING + (grid.rows - 1) * LAYOUT_SPACING_Y + LAYOUT_CARD_HEIGHT,
  };
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
