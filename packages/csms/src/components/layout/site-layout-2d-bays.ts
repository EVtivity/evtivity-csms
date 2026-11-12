// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The layout bay each station's 2D card shows in on a grid site and a depot
// (a spot of a parking lot, office or retail row or street; a depot's bus bay
// or truck lane): its own bay, else the nearest one no earlier station holds.
// The unit cards of a station stand close together: side by side on a depot
// (`packUnitCardBays`), in a block of lines of four on a grid site
// (`packUnitCardGrid`).

import {
  assignBays,
  layoutRowLengths,
  positionToBay,
  type LayoutBay,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';
import { bayKey } from './site-layout-2d-placement';

export function stationBays(
  stations: ReadonlyArray<Pick<LayoutStation, 'id' | 'positionX' | 'positionY'>>,
  settings: SiteLayoutSettings,
): Map<string, LayoutBay> {
  const cols = Math.max(
    1,
    ...layoutRowLengths(settings),
    ...stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY }).col + 1),
  );
  const assigned = assignBays(
    stations.map((s) => ({ x: s.positionX, y: s.positionY })),
    cols,
  );
  const bays = new Map<string, LayoutBay>();
  stations.forEach((s, i) => {
    const bay = assigned[i];
    if (bay != null) bays.set(s.id, bay);
  });
  return bays;
}

/**
 * The 2D bays of a station's unit chargers, packed (owner decision
 * 2026-11-12): in 3D a dual-port unit holds two spots, so its bay is every
 * other spot of the run and the cards stood a card apart. On the board unit
 * n (0-based) takes bay `first.col + n` of the first unit's row, the normal
 * card pitch. The packed bays stay inside the station's own run (a run holds
 * at least one spot per unit charger), so they meet no other station. Every
 * other station keeps its bay. Used on a depot, whose board wraps the bays to
 * its width already.
 */
export function packUnitCardBays(
  stations: ReadonlyArray<Pick<LayoutStation, 'id' | 'unitCharger'>>,
  bays: ReadonlyMap<string, LayoutBay>,
): Map<string, LayoutBay> {
  const packed = new Map(bays);
  const first = new Map<string, LayoutBay>();
  for (const s of stations) {
    const unit = s.unitCharger;
    const bay = bays.get(s.id);
    if (unit?.index === 0 && bay != null) first.set(unit.stationUuid, bay);
  }
  for (const s of stations) {
    const unit = s.unitCharger;
    if (unit == null) continue;
    const start = first.get(unit.stationUuid);
    if (start == null) continue;
    packed.set(s.id, { col: start.col + unit.index, row: start.row });
  }
  return packed;
}

/** How many unit cards of one station stand in one line of a grid site's board. */
export const UNIT_CARDS_PER_LINE = 4;

/**
 * A grid site's board (a parking lot, office or retail row or street) with
 * each station's unit cards in a compact block (owner decision 2026-11-12):
 * unit n stands in column `first.col + n % UNIT_CARDS_PER_LINE`, line
 * `floor(n / UNIT_CARDS_PER_LINE)` below the first unit's row. The extra lines
 * are board rows inserted under that row, so the rows below move down by them
 * and no other station's card meets the block. Returns the board bays, row
 * lengths and blocked spots in those board rows; a site without unit chargers
 * comes back unchanged.
 */
export function packUnitCardGrid(
  stations: ReadonlyArray<Pick<LayoutStation, 'id' | 'unitCharger'>>,
  bays: ReadonlyMap<string, LayoutBay>,
  rowLengths: readonly number[],
  blocked: ReadonlySet<string>,
): { bays: Map<string, LayoutBay>; rowLengths: number[]; blocked: Set<string> } {
  const first = new Map<string, LayoutBay>();
  for (const s of stations) {
    const unit = s.unitCharger;
    const bay = bays.get(s.id);
    if (unit?.index === 0 && bay != null) first.set(unit.stationUuid, bay);
  }
  if (first.size === 0) {
    return { bays: new Map(bays), rowLengths: [...rowLengths], blocked: new Set(blocked) };
  }
  // The extra lines each lot row needs for the unit blocks that start in it.
  const extra = new Map<number, number>();
  for (const s of stations) {
    const unit = s.unitCharger;
    const start = unit == null ? undefined : first.get(unit.stationUuid);
    if (unit == null || start == null) continue;
    const line = Math.floor(unit.index / UNIT_CARDS_PER_LINE);
    extra.set(start.row, Math.max(extra.get(start.row) ?? 0, line));
  }
  const blockedRows = [...blocked].map((k) => Number(k.split(':')[1] ?? 0));
  const rowCount = Math.max(
    rowLengths.length,
    ...[...bays.values()].map((b) => b.row + 1),
    ...blockedRows.map((r) => r + 1),
  );
  const boardRow: number[] = [];
  let next = 0;
  for (let row = 0; row < rowCount; row++) {
    boardRow.push(next);
    next += 1 + (extra.get(row) ?? 0);
  }
  const rowOf = (row: number): number => boardRow[row] ?? row;
  const packed = new Map<string, LayoutBay>();
  for (const s of stations) {
    const bay = bays.get(s.id);
    if (bay == null) continue;
    const unit = s.unitCharger;
    const start = unit == null ? undefined : first.get(unit.stationUuid);
    packed.set(
      s.id,
      unit != null && start != null
        ? {
            col: start.col + (unit.index % UNIT_CARDS_PER_LINE),
            row: rowOf(start.row) + Math.floor(unit.index / UNIT_CARDS_PER_LINE),
          }
        : { col: bay.col, row: rowOf(bay.row) },
    );
  }
  const lengths = Array.from({ length: next }, () => 0);
  rowLengths.forEach((n, row) => {
    lengths[rowOf(row)] = n;
  });
  const moved = new Set<string>();
  for (const key of blocked) {
    const [col = 0, row = 0] = key.split(':').map(Number);
    moved.add(bayKey(col, rowOf(row)));
  }
  return { bays: packed, rowLengths: lengths, blocked: moved };
}
