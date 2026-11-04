// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The structure of a solar carport canopy in the 3D site layout, without
// three.js so it can be unit tested. A canopy is built as commercial carport
// makers build it: a line of galvanized steel columns at the head of the
// stalls, each on a concrete pier with a base plate, a tapered girder on top
// of every column running across the stalls, purlins running along the row
// on top of the girders, and the module plane on the purlins, tilted a few
// degrees. Over one row it is a single cantilever (the columns at the head,
// the canopy over the stalls); over two rows back to back on a curbed island
// it is a double cantilever "T" (one column line on the island, the canopy
// over the stalls on both sides). Drive aisles stay open to the sky. The
// canopy frame used here: x along the row (the purlins), u across it from
// the back edge (u = 0, the low edge) to the far edge (u = depth), heights in
// meters above the paving. Sources: SOLAR_CARPORT.

import { STANDARD_DIMENSIONS, parkingHeadStrip, parkingRowGap } from '@evtivity/lib/site-layout';
import { chargersAtBack, rowFrontZ, type Lot } from './site-layout-grid';

const FT = 0.3048;
const EPS = 1e-9;
const IN = 0.0254;

/**
 * Solar carport dimensions, in meters and degrees.
 *
 * - `tiltDeg` 7: the standard pre-welded tilt of the Solar Mounts carport
 *   (Carport Spec Sheet 2023, "Tilt Angles 7° Standard | 3° & 5° options",
 *   https://solarmounts.com/wp-content/uploads/Carport-Spec-Sheet-2023.pdf),
 *   one of the Kern Solar Structures inclinations ("Canopy Inclination Angles
 *   of 2°, 5° and 7°", Single Cantilever brochure,
 *   https://www.solarcrowdsource.com/wp-content/uploads/2022/06/ParkingCanopy_SingleCantilever_Brochure.pdf);
 *   Sunmodo: "typically limited to 5 or 10-degrees" (Carport Design
 *   Guidelines D10225-V002,
 *   https://knowledgebase.sunmodo.com/wp-content/uploads/2021/01/D10225-V002-Carport-Design-Guidelines.pdf).
 * - `lowEdgeClearanceM` 14 ft: the lowest point of the structure above the
 *   paving, the Solar Mounts standard ("Ground Clearance 14' Standard", spec
 *   sheet above). Kern offers minimum clear heights up to 12 ft (brochure
 *   above). It clears the 98 in (2490 mm) a van space and its route need
 *   (2010 ADA Standards 502.5, https://www.access-board.gov/ada/#ada-502) and
 *   a 26 ft U-Haul box truck ("Clearance Height" 12 ft,
 *   https://www.uhaul.com/Trucks/26ft-Moving-Truck-Rental/RT/).
 *   Sunmodo measures clearance "from the ground to the lowest point of the
 *   carport" (guidelines above), as `carportFrame` does.
 * - `minColumnSpacingM`, `maxColumnSpacingM` 18 and 32 ft: Kern "Nominal
 *   Column Spacing from 18' to 32'" (brochure above); Solar Mounts T and L
 *   frames 26 to 29 ft post to post (spec sheet above). Carport Structures
 *   puts "one column every bay" of "two car spaces" (Solar Single Column
 *   Single, https://www.carportstructures.com/solar-single-column-single);
 *   two 2.6 m stalls (17.1 ft) fall under the Kern minimum, so a lot row uses
 *   three, and two only where every three-stall line would stand on a
 *   pedestal or an accessible space (`rowColumnLines`).
 * - `endCantileverRatio` 1/3: the canopy runs past its end column by at most
 *   a third of the column spacing (Sunmodo, guidelines above: "As a rule of
 *   thumb the cantilever distance is 1/3 the distance of the east-west span").
 * - `pierDiameterM` 36 in: Solar Mounts pier footings are drilled "Using a
 *   36” auger" and formed with a Sonotube (Solar Carport Install Manual v9.0,
 *   Q3 2025, https://solarmounts.com/wp-content/uploads/Solar-Carport-Manual-v11.0.pdf).
 * - `pierTopM` 0.9: the cast-in-place pier rises above the paving around the
 *   column as its bollard (Kern drawings label it "BOLLARD", brochure above;
 *   "Cast-in-Place Concrete Pile with Embedded Column"). No source gives its
 *   height; 0.9 m matches the visible height of the equipment bollards.
 * - Member sizes (`columnDepthM`, `columnFlangeM`, `basePlateM`, girder and
 *   purlin depths, `moduleThicknessM`): no source; a W-shape post on a base
 *   plate with anchor bolts (Solar Mounts manual, "Placing the Post on the
 *   Foundation"), a girder or truss on each post and C-channel purlins along
 *   the row (Solar Mounts manual and spec sheet: "27’-0” Purlin"; Carport
 *   Structures: "16 GA. Cold Rolled G-90 Galvanized Steel" purlins, page
 *   above).
 * - `modulesPerRowCover` 3 per 21 ft: Solar Mounts L frame, "3 High
 *   Portrait", 19 to 21 ft N/S span cover (spec sheet above): the module rows
 *   across the canopy, two purlins under each.
 * - Double cantilever over an island: Kern Solar Structures, Double
 *   Cantilever brochure (2019, Version 1,
 *   https://www.solarcrowdsource.com/wp-content/uploads/2022/06/ParkingCanopy_DoubleCantilever_Brochure.pdf):
 *   one column line, a girder cantilevered on both sides, a "single incline
 *   canopy"; Solar Mounts T frame, "7 High Portrait", 44 to 46 ft N/S span
 *   cover (spec sheet above), the width of two 5.5 m stalls and a 2.4 m
 *   island (13.4 m, 44 ft). Kern names "Nominal Canopy Width up to 40'".
 */
export const SOLAR_CARPORT = {
  tiltDeg: 7,
  lowEdgeClearanceM: 14 * FT,
  minColumnSpacingM: 18 * FT,
  maxColumnSpacingM: 32 * FT,
  endCantileverRatio: 1 / 3,
  pierDiameterM: 36 * IN,
  pierTopM: 0.9,
  basePlateM: 0.55,
  basePlateThickM: 0.04,
  columnDepthM: 0.36,
  columnFlangeM: 0.26,
  girderDepthAtColumnM: 0.6,
  girderDepthAtTipM: 0.25,
  girderWidthM: 0.2,
  purlinDepthM: 0.2,
  purlinWidthM: 0.075,
  moduleThicknessM: 0.04,
  moduleRowCoverM: (21 * FT) / 3,
  /** An edge row's columns stand this far past the head of the stalls, on the grass (no source). */
  edgeColumnBeyondHeadM: 0.6,
} as const;

/** A canopy in its own frame (see the file comment). */
export interface CarportFrame {
  /** Along the row: the canopy from minX to maxX. */
  minX: number;
  maxX: number;
  /** Across the row: from the back edge (0) to the far edge. */
  depthM: number;
  tiltRad: number;
  /** Column centers along x. */
  columnXs: number[];
  /** Column centers across, from the back edge. */
  columnU: number;
  /** The top of the pier and the bottom of the column. */
  pierTopY: number;
  /** The top of every column: the bottom of its girder at columnU. */
  columnTopY: number;
  /** One purlin per entry, running from minX to maxX. */
  purlins: Array<{ u: number; bottomY: number; topY: number }>;
  /** Module rows across the canopy (portrait modules, texture only). */
  moduleRows: number;
  /** The underside of the module plane at u. */
  moduleBottomAt: (u: number) => number;
  /** The top of a girder at u (where the purlins sit). */
  girderTopAt: (u: number) => number;
  /** The bottom of a girder at u. */
  girderBottomAt: (u: number) => number;
  /** The lowest point of the structure above the paving (the column and pier excluded). */
  clearanceM: number;
}

/**
 * The girder depth at u: deepest over the column, tapered to the tip of each
 * cantilever. A stub no longer than the column depth (the back of a single
 * cantilever) keeps the full depth.
 */
function girderDepthAt(u: number, depthM: number, columnU: number): number {
  const c = SOLAR_CARPORT;
  const reach = u >= columnU ? depthM - columnU : columnU;
  if (reach <= c.columnDepthM) return c.girderDepthAtColumnM;
  const t = Math.min(1, Math.abs(u - columnU) / reach);
  return c.girderDepthAtColumnM + (c.girderDepthAtTipM - c.girderDepthAtColumnM) * t;
}

/**
 * The frame of a canopy `depthM` deep from its back edge, over x from `minX`
 * to `maxX`, on columns at `columnXs`, their centers `columnU` from the back
 * edge (default half a column depth: a single cantilever; the island middle
 * for a double cantilever). The module plane rises from the back edge (the
 * low edge) at `SOLAR_CARPORT.tiltDeg`, and sits high enough that the lowest
 * member is `lowEdgeClearanceM` above the paving. Each girder runs the full
 * depth on top of its column.
 */
export function carportFrame(
  minX: number,
  maxX: number,
  depthM: number,
  columnXs: number[],
  columnU: number = SOLAR_CARPORT.columnDepthM / 2,
): CarportFrame {
  const c = SOLAR_CARPORT;
  const tiltRad = (c.tiltDeg * Math.PI) / 180;
  const slope = Math.tan(tiltRad);
  // Module bottom at u: m0 + slope * u. Purlins under it, girders under them.
  const below = (u: number) => c.purlinDepthM + girderDepthAt(u, depthM, columnU);
  // The girder bottom is linear between the back tip, the column and the far
  // tip, so its lowest point is one of them. Set the plane so it clears
  // lowEdgeClearanceM there.
  const keyUs = [0, columnU, depthM];
  const m0 = c.lowEdgeClearanceM + Math.max(...keyUs.map((u) => below(u) - slope * u));
  const moduleBottomAt = (u: number) => m0 + slope * u;
  const girderTopAt = (u: number) => moduleBottomAt(u) - c.purlinDepthM;
  const girderBottomAt = (u: number) => girderTopAt(u) - girderDepthAt(u, depthM, columnU);
  const moduleRows = Math.max(1, Math.round(depthM / c.moduleRowCoverM));
  const purlins: CarportFrame['purlins'] = [];
  for (let i = 0; i < moduleRows; i++) {
    for (const f of [0.25, 0.75]) {
      const u = ((i + f) * depthM) / moduleRows;
      purlins.push({ u, bottomY: girderTopAt(u), topY: moduleBottomAt(u) });
    }
  }
  return {
    minX,
    maxX,
    depthM,
    tiltRad,
    columnXs,
    columnU,
    pierTopY: c.pierTopM,
    columnTopY: girderBottomAt(columnU),
    purlins,
    moduleRows,
    moduleBottomAt,
    girderTopAt,
    girderBottomAt,
    clearanceM: Math.min(...keyUs.map(girderBottomAt)),
  };
}

/** The top of the module plane at its high edge. */
export function carportTopY(frame: CarportFrame): number {
  return frame.moduleBottomAt(frame.depthM) + SOLAR_CARPORT.moduleThicknessM;
}

/**
 * Column positions along a row of `spots` stalls, as stall line numbers: on
 * the stall lines (never inside a stall), every third line (7.8 m, 25.6 ft
 * for 2.6 m stalls, inside the 18 to 32 ft range), neither end running past
 * its column by more than one stall (a third of the spacing). `blocked`
 * lists the lines a column may not stand on (a dual-port pedestal on the line
 * between its two spots, an accessible charging space): the other offsets of
 * the three-stall spacing come next, then one column every two stalls
 * (Carport Structures). A row of fewer than three stalls has a column at each
 * end.
 */
export function rowColumnLines(spots: number, blocked: ReadonlySet<number> = new Set()): number[] {
  if (spots < 3) return [0, Math.max(1, spots)];
  const linesFrom = (first: number, step: number): number[] | null => {
    const lines: number[] = [];
    for (let l = first; l <= spots; l += step) lines.push(l);
    const last = lines[lines.length - 1] ?? first;
    return first <= 1 && spots - last <= 1 && lines.length >= 2 ? lines : null;
  };
  const preferred = spots % 3 === 2 ? 1 : 0;
  const candidates = [
    linesFrom(preferred, 3),
    linesFrom(1 - preferred, 3),
    linesFrom(0, 2),
    linesFrom(1, 2),
  ].filter((c): c is number[] => c != null);
  const fallback = candidates[0] ?? [0, spots];
  return candidates.find((c) => c.every((l) => !blocked.has(l))) ?? fallback;
}

/**
 * Column positions along a free-standing canopy `lengthM` long, centered on
 * 0: the fewest columns whose spacing stays at or under the maximum, with
 * each end running a third of the spacing past its end column.
 */
export function freeColumnXs(lengthM: number): number[] {
  const c = SOLAR_CARPORT;
  let spans = 1;
  while (lengthM / (spans + 2 * c.endCantileverRatio) > c.maxColumnSpacingM) spans++;
  const s = lengthM / (spans + 2 * c.endCantileverRatio);
  const start = -lengthM / 2 + s * c.endCantileverRatio;
  return Array.from({ length: spans + 1 }, (_, i) => start + i * s);
}

/** A row canopy in lot coordinates: its frame, and where u = 0 lies and which way u grows across the rows. */
export interface RowCarport {
  frame: CarportFrame;
  /** Lot z of the back edge (u = 0). */
  backZ: number;
  /** Lot z of the column centers. */
  columnZ: number;
  /** +1 when u grows with lot z, -1 when it shrinks. */
  dirZ: 1 | -1;
  /** The rows it covers: one, or both rows of an island. */
  rows: number[];
}

/**
 * The canopy over a parking lot row. A row back to back with another on a
 * curbed island gets a double cantilever over both rows: one column line on
 * the island middle (clear of both rows' chargers, which stand
 * `CHARGER_BEHIND_STALL_HEAD_M` from each curb), the canopy over both rows of
 * stalls up to their drive aisles. Any other row gets a single cantilever:
 * its columns past the lot edge on the grass (an edge row), or on the stall
 * lines just inside the head where the head faces a drive aisle (the middle
 * row of an odd lot), the canopy from the column line over the stalls to
 * their aisle edge. Neither runs over a drive aisle. `blocked` lists the
 * stall lines no column may stand on (`rowColumnLines`).
 */
export function rowCarport(
  row: number,
  lot: Lot,
  blocked: ReadonlySet<number> = new Set(),
): RowCarport {
  const d = STANDARD_DIMENSIONS;
  // Every parking lot row is painted the full lot width, also an inner row
  // with no charger slots (Lot Edge), so the canopy covers all of it.
  const spots = lot.cols;
  const columnXs = rowColumnLines(spots, blocked).map((line) => line * lot.spotW);
  const half = SOLAR_CARPORT.columnDepthM / 2;
  const islandAfter = row + 1 < lot.rows && parkingRowGap(row, lot.rows) === 'island';
  const islandBefore = row > 0 && parkingRowGap(row - 1, lot.rows) === 'island';
  if (lot.siteType === 'parking_lot' && (islandAfter || islandBefore)) {
    const first = islandAfter ? row : row - 1;
    const minZ = rowFrontZ(first, lot);
    const maxZ = rowFrontZ(first + 1, lot) + lot.spotD;
    const columnZ = minZ + lot.spotD + d.islandWidthM / 2;
    const frame = carportFrame(0, spots * lot.spotW, maxZ - minZ, columnXs, columnZ - minZ);
    return { frame, backZ: minZ, columnZ, dirZ: 1, rows: [first, first + 1] };
  }
  const front = rowFrontZ(row, lot);
  const atBack = chargersAtBack(row, lot);
  const head = atBack ? front + lot.spotD : front;
  const dirZ: 1 | -1 = atBack ? -1 : 1;
  // Past the head on the grass past the lot edge, or on the charger strip at
  // the head of the next to last row of an odd lot.
  const atLotEdge =
    head <= EPS || head >= lot.depth - EPS || (atBack && parkingHeadStrip(row, lot.rows));
  const beyond = atLotEdge ? SOLAR_CARPORT.edgeColumnBeyondHeadM : -SOLAR_CARPORT.pierDiameterM / 2;
  const columnZ = head - dirZ * beyond;
  const frame = carportFrame(0, spots * lot.spotW, half + beyond + lot.spotD, columnXs);
  return { frame, backZ: columnZ - dirZ * half, columnZ, dirZ, rows: [row] };
}

/** A convex obstacle (a station and its spots) in a canopy frame: x along it, u across. */
export type CanopyObstacle = ReadonlyArray<{ x: number; u: number }>;

/** The distance from a point to a convex polygon of either winding (0 inside). */
function distanceToPolygon(x: number, u: number, poly: CanopyObstacle): number {
  let left = true;
  let right = true;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a == null || b == null) continue;
    const ex = b.x - a.x;
    const eu = b.u - a.u;
    const cross = ex * (u - a.u) - eu * (x - a.x);
    if (cross < 0) left = false;
    if (cross > 0) right = false;
    const len2 = ex * ex + eu * eu;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (u - a.u) * eu) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * ex), u - (a.u + t * eu)));
  }
  return left || right ? 0 : best;
}

/**
 * The columns of a free-standing canopy kept clear of the stations under it
 * (their chargers and spots, `obstacles` in the canopy frame): a column whose
 * pier would stand on one slides along the column line to the nearest clear
 * point, keeping every spacing at most `maxColumnSpacingM` and each end
 * cantilever at most a third of it. When no point is clear, a column whose
 * neighbors stay within that spacing without it is left out; a column with
 * neither keeps its place (no point of the column line is clear there).
 */
export function clearColumnXs(
  columnXs: readonly number[],
  columnU: number,
  minX: number,
  maxX: number,
  obstacles: readonly CanopyObstacle[],
): number[] {
  const c = SOLAR_CARPORT;
  const r = c.pierDiameterM / 2;
  const maxEnd = c.maxColumnSpacingM * c.endCantileverRatio;
  const blocked = (x: number) => obstacles.some((o) => distanceToPolygon(x, columnU, o) < r);
  const fits = (xs: readonly number[]): boolean => {
    if (xs.length < 2) return false;
    const first = xs[0] ?? minX;
    const last = xs[xs.length - 1] ?? maxX;
    if (first - minX > maxEnd + EPS || maxX - last > maxEnd + EPS) return false;
    for (let i = 1; i < xs.length; i++) {
      const s = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
      if (s > c.maxColumnSpacingM + EPS || s < 2 * r) return false;
    }
    return true;
  };
  let xs = [...columnXs];
  for (let i = 0; i < xs.length; i++) {
    const x0 = xs[i] ?? 0;
    if (!blocked(x0)) continue;
    let moved = false;
    for (let k = 1; k <= 60 && !moved; k++) {
      for (const sign of [1, -1]) {
        const x = x0 + sign * k * 0.1;
        if (x < minX || x > maxX || blocked(x)) continue;
        const next = xs.map((v, j) => (j === i ? x : v));
        if (fits(next)) {
          xs = next;
          moved = true;
          break;
        }
      }
    }
    if (moved) continue;
    const without = xs.filter((_, j) => j !== i);
    if (fits(without)) {
      xs = without;
      i--;
    }
  }
  return xs;
}
