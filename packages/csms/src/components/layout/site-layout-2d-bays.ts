// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The layout bay each station's 2D card shows in on a grid site and a depot
// (a spot of a parking lot, office or retail row or street; a depot's bus bay
// or truck lane): its own bay, else the nearest one no earlier station holds.

import {
  assignBays,
  layoutRowLengths,
  positionToBay,
  type LayoutBay,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';

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
