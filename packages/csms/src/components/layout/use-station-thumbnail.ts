// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 2D card's station picture for a model: the AC or DC charger plate color
// of the company branding, the page theme, and the shared thumbnail cache.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDarkTheme } from '@/hooks/use-dark-theme';
import { DEFAULT_THEME_COLOR } from '@evtivity/lib/charger-plate-colors';
import {
  stationThumbnails,
  type StationThumbnailCache,
  type ThumbnailModel,
} from './site-layout-station-thumbnail';

const HEX = /^#[0-9a-f]{6}$/i;

/** The AC and DC charger plate colors of the branding, else the default brand color. */
export function useChargerPlateColors(): { ac: string; dc: string } {
  const { data } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
    staleTime: 5 * 60_000,
  });
  const ac = data?.['chargerColorAc'];
  const dc = data?.['chargerColorDc'];
  const acColor = ac != null && HEX.test(ac) ? ac : DEFAULT_THEME_COLOR;
  const dcColor = dc != null && HEX.test(dc) ? dc : DEFAULT_THEME_COLOR;
  return useMemo(() => ({ ac: acColor, dc: dcColor }), [acColor, dcColor]);
}

/**
 * The picture of `model` in `plateColor`: a data URL once rendered, null
 * when none can be made (no WebGL: the card keeps its plain drawing),
 * undefined while it renders.
 */
export function useStationThumbnail(
  model: ThumbnailModel,
  plateColor: string,
  cache: StationThumbnailCache = stationThumbnails,
): string | null | undefined {
  const dark = useDarkTheme();
  const request = { model, plateColor, dark };
  const image = useSyncExternalStore(
    (listener) => cache.subscribe(listener),
    () => cache.peek(request),
  );
  useEffect(() => {
    if (cache.peek({ model, plateColor, dark }) === undefined) {
      void cache.get({ model, plateColor, dark });
    }
  }, [cache, model, plateColor, dark]);
  return image;
}
