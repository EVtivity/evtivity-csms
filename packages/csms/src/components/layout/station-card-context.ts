// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// What a 2D charger card reads from its board beyond the station: the 3D
// model its picture shows (by the site type's rules), the charger plate
// colors it is painted in and the payment terminals paired to it. The layout provides it once for every board.

import { createContext, useContext } from 'react';
import { DEFAULT_THEME_COLOR } from '@evtivity/lib/charger-plate-colors';
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';
import type { LayoutTerminal } from './layout-terminals';
import { stationThumbnailModel, type ThumbnailModel } from './site-layout-station-thumbnail';

export interface StationCardExtras {
  thumbnailModel: (station: LayoutStation) => ThumbnailModel;
  terminals: (stationId: string) => readonly LayoutTerminal[];
  /** The AC and DC charger plate colors the pictures are painted in (the company branding). */
  plateColors: { ac: string; dc: string };
}

const DEFAULT_EXTRAS: StationCardExtras = {
  thumbnailModel: (station) => stationThumbnailModel(station, DEFAULT_LAYOUT_GRID),
  terminals: () => [],
  plateColors: { ac: DEFAULT_THEME_COLOR, dc: DEFAULT_THEME_COLOR },
};

export const StationCardContext = createContext<StationCardExtras>(DEFAULT_EXTRAS);

export function useStationCardExtras(): StationCardExtras {
  return useContext(StationCardContext);
}
