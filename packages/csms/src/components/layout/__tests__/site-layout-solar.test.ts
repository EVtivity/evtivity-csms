// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYOUT_GRID,
  CHARGER_BEHIND_STALL_HEAD_M,
  STANDARD_DIMENSIONS,
  freeSpotsExtent,
  parkingChargerZ,
  solarCanopySize,
} from '@evtivity/lib/site-layout';
import { lotOf, parkingRowGaps, spotRect, type Lot } from '../site-layout-grid';
import {
  SOLAR_CARPORT,
  carportFrame,
  carportTopY,
  clearColumnXs,
  freeColumnXs,
  rowCarport,
  rowColumnLines,
  type CanopyObstacle,
} from '../site-layout-solar';

const FT = 0.3048;
const EPS = 1e-9;

function lots(): Array<{ name: string; lot: Lot }> {
  const out: Array<{ name: string; lot: Lot }> = [];
  for (const rows of [1, 2, 3, 4, 5]) {
    for (const spots of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16]) {
      for (const chargerPlacement of ['islands', 'lot_edge'] as const) {
        out.push({
          name: `${String(rows)} rows of ${String(spots)}, ${chargerPlacement}`,
          lot: lotOf({ ...DEFAULT_LAYOUT_GRID, rows, spotsPerRow: spots, chargerPlacement }),
        });
      }
    }
  }
  return out;
}

describe('solar carport column placement on a parking lot row', () => {
  it('never puts a column (or its pier) in a stall or a drive aisle', () => {
    const r = SOLAR_CARPORT.pierDiameterM / 2;
    for (const { name, lot } of lots()) {
      const aisles = parkingRowGaps(lot).filter((g) => g.kind === 'aisle');
      for (let row = 0; row < lot.rows; row++) {
        const c = rowCarport(row, lot);
        for (const x of c.frame.columnXs) {
          const z = c.columnZ;
          for (let rr = 0; rr < lot.rows; rr++) {
            for (let col = 0; col < lot.cols; col++) {
              const s = spotRect({ col, row: rr }, lot);
              // The column center never stands inside a stall; a pier on a stall line
              // may reach into the stall corners at the head.
              const inside = x > s.minX + EPS && x < s.maxX - EPS && z > s.minZ && z < s.maxZ;
              expect(inside, `${name} row ${String(row)} column at ${String(x)}`).toBe(false);
            }
          }
          for (const a of aisles) {
            expect(z + r <= a.minZ + 1e-6 || z - r >= a.maxZ - 1e-6, `${name} aisle`).toBe(true);
          }
        }
      }
    }
  });

  it('stands the columns on the stall lines, at the head of the stalls behind the chargers', () => {
    for (const { lot } of lots()) {
      for (let row = 0; row < lot.rows; row++) {
        const c = rowCarport(row, lot);
        for (const x of c.frame.columnXs) {
          const line = x / lot.spotW;
          expect(Math.abs(line - Math.round(line))).toBeLessThan(1e-9);
        }
        // The charger stands between the stalls and the column line (rows
        // that hold chargers; a Lot Edge inner row holds none).
        if ((lot.rowLengths[row] ?? 0) === 0) continue;
        const charger = parkingChargerZ(row, lot.rows);
        const stallMid = spotRect({ col: 0, row }, lot).minZ + lot.spotD / 2;
        expect(Math.sign(charger - c.columnZ)).toBe(Math.sign(stallMid - c.columnZ));
      }
    }
  });

  it('puts island columns on the island middle, clear of both rows of chargers', () => {
    const lot = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4, spotsPerRow: 8 });
    const island = parkingRowGaps(lot).find((g) => g.kind === 'island');
    expect(island).toBeDefined();
    if (island == null) return;
    for (const row of [1, 2]) {
      const c = rowCarport(row, lot);
      expect(c.columnZ).toBeCloseTo((island.minZ + island.maxZ) / 2, 9);
      // Chargers stand CHARGER_BEHIND_STALL_HEAD_M from each curb, at the stall middles.
      const pierToCharger = Math.hypot(
        lot.spotW / 2,
        island.maxZ - island.minZ - 2 * CHARGER_BEHIND_STALL_HEAD_M,
      );
      expect(pierToCharger).toBeGreaterThan(SOLAR_CARPORT.pierDiameterM / 2);
    }
  });

  it('spaces the columns 18 to 32 ft apart, the end cantilever at most a third of the spacing', () => {
    for (let spots = 3; spots <= 40; spots++) {
      const lines = rowColumnLines(spots);
      const xs = lines.map((l) => l * STANDARD_DIMENSIONS.spotWidthM);
      for (let i = 1; i < xs.length; i++) {
        const s = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
        expect(s).toBeGreaterThanOrEqual(18 * FT);
        expect(s).toBeLessThanOrEqual(32 * FT);
      }
      const span = (xs[1] ?? 0) - (xs[0] ?? 0);
      const length = spots * STANDARD_DIMENSIONS.spotWidthM;
      expect(xs[0] ?? 0).toBeLessThanOrEqual(span / 3 + EPS);
      expect(length - (xs[xs.length - 1] ?? 0)).toBeLessThanOrEqual(span / 3 + EPS);
    }
  });

  it('gives a row of fewer than three stalls a column at each end', () => {
    expect(rowColumnLines(1)).toEqual([0, 1]);
    expect(rowColumnLines(2)).toEqual([0, 2]);
  });

  it('covers the stalls up to their drive aisle edge, never over a drive aisle', () => {
    for (const { name, lot } of lots()) {
      const aisles = parkingRowGaps(lot).filter((g) => g.kind === 'aisle');
      for (let row = 0; row < lot.rows; row++) {
        const c = rowCarport(row, lot);
        const ends = [c.backZ, c.backZ + c.dirZ * c.frame.depthM];
        const minZ = Math.min(...ends);
        const maxZ = Math.max(...ends);
        // The canopy reaches the aisle edge of every row it covers.
        for (const r of c.rows) {
          const s = spotRect({ col: 0, row: r }, lot);
          expect(minZ, `${name} row ${String(r)}`).toBeLessThanOrEqual(s.minZ + 0.6);
          expect(maxZ, `${name} row ${String(r)}`).toBeGreaterThanOrEqual(s.maxZ - 0.6);
        }
        for (const a of aisles) {
          expect(maxZ <= a.minZ + 1e-6 || minZ >= a.maxZ - 1e-6, `${name} aisle`).toBe(true);
        }
        expect(c.frame.maxX - c.frame.minX).toBeCloseTo(lot.cols * lot.spotW, 9);
      }
    }
  });

  it('builds one double cantilever over both rows of an island, its columns on the island middle', () => {
    for (const chargerPlacement of ['islands', 'lot_edge'] as const) {
      const lot = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4, spotsPerRow: 8, chargerPlacement });
      const island = parkingRowGaps(lot).find((g) => g.kind === 'island');
      expect(island).toBeDefined();
      if (island == null) return;
      const a = rowCarport(1, lot);
      const b = rowCarport(2, lot);
      expect(a.rows).toEqual([1, 2]);
      expect(b.rows).toEqual(a.rows);
      expect([b.backZ, b.columnZ, b.dirZ, b.frame.depthM]).toEqual([
        a.backZ,
        a.columnZ,
        a.dirZ,
        a.frame.depthM,
      ]);
      expect(b.frame.columnXs).toEqual(a.frame.columnXs);
      expect(a.columnZ).toBeCloseTo((island.minZ + island.maxZ) / 2, 9);
      // Two stalls and the island: 13.4 m, the 44 to 46 ft span cover of a T frame.
      expect(a.frame.depthM).toBeCloseTo(2 * lot.spotD + (island.maxZ - island.minZ), 9);
      expect(a.frame.depthM / FT).toBeGreaterThanOrEqual(43.9);
      expect(a.frame.depthM / FT).toBeLessThanOrEqual(46);
      expect(a.backZ + a.frame.columnU).toBeCloseTo(a.columnZ, 9);
      // The girder is deepest over the column and tapers toward both tips.
      const f = a.frame;
      const depthAt = (u: number) => f.girderTopAt(u) - f.girderBottomAt(u);
      expect(depthAt(f.columnU)).toBeGreaterThan(depthAt(0));
      expect(depthAt(f.columnU)).toBeGreaterThan(depthAt(f.depthM));
      // The low edge keeps the 14 ft clearance.
      expect(f.clearanceM).toBeCloseTo(SOLAR_CARPORT.lowEdgeClearanceM, 9);
    }
  });

  it('keeps the columns off the stall lines a pedestal or an accessible space holds', () => {
    // Dual-port pedestals on the odd lines between spots 0 and 1, 2 and 3, ...
    const odd = new Set([1, 3, 5, 7]);
    const lines = rowColumnLines(8, odd);
    expect(lines.some((l) => odd.has(l))).toBe(false);
    for (let i = 1; i < lines.length; i++) {
      expect((lines[i] ?? 0) - (lines[i - 1] ?? 0)).toBeGreaterThanOrEqual(2);
      expect((lines[i] ?? 0) - (lines[i - 1] ?? 0)).toBeLessThanOrEqual(3);
    }
    expect(lines[0]).toBeLessThanOrEqual(1);
    expect(8 - (lines[lines.length - 1] ?? 0)).toBeLessThanOrEqual(1);
    // Nothing blocked: the three-stall spacing as before.
    expect(rowColumnLines(8)).toEqual([1, 4, 7]);
    // The default lines blocked: another three-stall offset first.
    expect(rowColumnLines(7, new Set([3]))).toEqual([1, 4, 7]);
  });
});

describe('solar carport structure', () => {
  const frames = [
    carportFrame(0, 20.8, 6.1, [0, 7.8, 15.6]),
    carportFrame(-10, 10, 8, freeColumnXs(20)),
    ...lots().flatMap(({ lot }) =>
      Array.from({ length: lot.rows }, (_, row) => rowCarport(row, lot).frame),
    ),
  ];

  it('tilts the module plane 5 to 10 degrees, rising from the column line', () => {
    for (const f of frames) {
      const deg = (f.tiltRad * 180) / Math.PI;
      expect(deg).toBeGreaterThanOrEqual(5);
      expect(deg).toBeLessThanOrEqual(10);
      expect(f.moduleBottomAt(f.depthM)).toBeGreaterThan(f.moduleBottomAt(0));
    }
  });

  it('keeps the lowest member 10 to 14 ft above the paving, over a van (98 in) and a 12 ft box truck', () => {
    for (const f of frames) {
      expect(f.clearanceM).toBeGreaterThanOrEqual(10 * FT - EPS);
      expect(f.clearanceM).toBeLessThanOrEqual(14 * FT + EPS);
      expect(f.clearanceM).toBeGreaterThanOrEqual(98 * 0.0254);
      expect(f.clearanceM).toBeGreaterThanOrEqual(12 * FT);
      for (let i = 0; i <= 20; i++) {
        const u = (i * f.depthM) / 20;
        expect(f.girderBottomAt(u)).toBeGreaterThanOrEqual(f.clearanceM - EPS);
      }
    }
  });

  it('connects every member: pier, column, girder, purlins and modules', () => {
    for (const f of frames) {
      // The column stands on the pier (base plate between) and carries its girder.
      expect(f.columnTopY).toBeCloseTo(f.girderBottomAt(f.columnU), 9);
      expect(f.columnTopY).toBeGreaterThan(f.pierTopY);
      expect(f.columnU).toBeGreaterThanOrEqual(0);
      expect(f.columnU).toBeLessThan(f.depthM);
      // The girder spans the full depth, so it holds every purlin.
      expect(f.purlins.length).toBe(2 * f.moduleRows);
      for (const p of f.purlins) {
        expect(p.u).toBeGreaterThan(0);
        expect(p.u).toBeLessThan(f.depthM);
        expect(p.bottomY).toBeCloseTo(f.girderTopAt(p.u), 9);
        expect(p.topY).toBeCloseTo(f.moduleBottomAt(p.u), 9);
      }
      // Purlins run the canopy length, over every column (so every girder carries them).
      expect(f.columnXs.length).toBeGreaterThanOrEqual(2);
      for (const x of f.columnXs) {
        expect(x).toBeGreaterThanOrEqual(f.minX - EPS);
        expect(x).toBeLessThanOrEqual(f.maxX + EPS);
      }
      expect(carportTopY(f)).toBeGreaterThan(f.moduleBottomAt(f.depthM));
    }
  });
});

describe('free-standing canopy columns', () => {
  it('spaces columns within 32 ft with third-span end cantilevers', () => {
    for (const length of [8, 12, 20, 30, 45, 60, 100]) {
      const xs = freeColumnXs(length);
      expect(xs.length).toBeGreaterThanOrEqual(2);
      const s = (xs[1] ?? 0) - (xs[0] ?? 0);
      expect(s).toBeLessThanOrEqual(32 * FT + EPS);
      expect((xs[0] ?? 0) + length / 2).toBeCloseTo(s / 3, 9);
      expect(length / 2 - (xs[xs.length - 1] ?? 0)).toBeCloseTo(s / 3, 9);
      if (length >= (18 * FT * 5) / 3) expect(s).toBeGreaterThanOrEqual(18 * FT - EPS);
    }
  });

  /** A station's charger and spots in a canopy frame, unturned: spots lie toward +u. */
  const stationAt = (x: number, u: number, spots = 1): CanopyObstacle => {
    const e = freeSpotsExtent(spots);
    return [
      { x: x + e.minX, u: u + e.front },
      { x: x + e.maxX, u: u + e.front },
      { x: x + e.maxX, u: u + e.back },
      { x: x + e.minX, u: u + e.back },
    ];
  };
  const r = SOLAR_CARPORT.pierDiameterM / 2;
  const clearOf = (xs: number[], columnU: number, obstacles: CanopyObstacle[]) =>
    xs.every((x) =>
      obstacles.every((o) => {
        const minX = Math.min(...o.map((p) => p.x));
        const maxX = Math.max(...o.map((p) => p.x));
        const minU = Math.min(...o.map((p) => p.u));
        const maxU = Math.max(...o.map((p) => p.u));
        const dx = Math.max(minX - x, 0, x - maxX);
        const du = Math.max(minU - columnU, 0, columnU - maxU);
        return Math.hypot(dx, du) >= r - 1e-9;
      }),
    );

  it('slides a column off a station under the canopy, keeping the spacing rules', () => {
    const length = 20;
    const base = freeColumnXs(length);
    const u = SOLAR_CARPORT.columnDepthM / 2;
    // A station whose charger and spots cover the middle column.
    const obstacles = [stationAt(base[1] ?? 0, u + 0.5)];
    expect(clearOf(base, u, obstacles)).toBe(false);
    const xs = clearColumnXs(base, u, -length / 2, length / 2, obstacles);
    expect(clearOf(xs, u, obstacles)).toBe(true);
    for (let i = 1; i < xs.length; i++) {
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeLessThanOrEqual(32 * FT + EPS);
    }
    expect((xs[0] ?? 0) + length / 2).toBeLessThanOrEqual((32 * FT) / 3 + EPS);
    expect(length / 2 - (xs[xs.length - 1] ?? 0)).toBeLessThanOrEqual((32 * FT) / 3 + EPS);
    // Nothing under the canopy: the columns stay.
    expect(clearColumnXs(base, u, -length / 2, length / 2, [])).toEqual(base);
  });

  it('keeps the Willow Creek demo canopy piers clear of its three pedestals', () => {
    // seed-demo-layout-plan.ts: canopy pv-1 at (4.5, -23), 10 kWp, unturned;
    // pedestals CS-3038 to CS-3040 at x 1.5, 4.5 and 7.5, z -24, unturned.
    const size = solarCanopySize(10);
    const backZ = -23 - size.depthM / 2;
    const u = SOLAR_CARPORT.columnDepthM / 2;
    const obstacles = [1.5, 4.5, 7.5].map((x) => stationAt(x - 4.5, -24 - backZ));
    const xs = clearColumnXs(
      freeColumnXs(size.lengthM),
      u,
      -size.lengthM / 2,
      size.lengthM / 2,
      obstacles,
    );
    expect(xs.length).toBeGreaterThanOrEqual(2);
    expect(clearOf(xs, u, obstacles)).toBe(true);
  });
});
