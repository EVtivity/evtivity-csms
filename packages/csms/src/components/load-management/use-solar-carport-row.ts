// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The lot row a solar carport covers on a parking lot (owner decision
// 2026-11-04): picked in the Load Management solar form, stored as the
// canopy's layout position through the layout route (PUT
// /v1/sites/{id}/layout), the one writer of the layout settings. The 3D
// layout places the other power equipment by drag.

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  effectiveLayoutSettings,
  energyAssetsOf,
  newSolarCanopyPlace,
  NO_POWER_EQUIPMENT,
  placePowerEquipment,
  positionToBay,
  siteTypeOf,
  type LayoutPowerEquipment,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import type { LayoutStation } from '@/components/layout/StationCard';
import { layoutStationCountsOf } from '@/components/layout/site-layout-free';

export interface SolarCarportRow {
  /** A parking lot whose layout the user may change (sites:write), loaded. */
  available: boolean;
  /** The lot's rows (row numbers 0 to rows - 1). */
  rows: number;
  /** The row the canopy covers now (its stored row, else its default one). */
  rowOf: (assetId: string | undefined) => number;
  /** Stores the canopy's row when it differs from the stored one. */
  save: (assetId: string, row: number) => Promise<void>;
}

/**
 * The settings with one canopy over `row`: its stored position keeps its
 * other fields, a canopy without one gets `{ id, row }`.
 */
export function withSolarRow(
  settings: SiteLayoutSettings,
  assetId: string,
  row: number,
): SiteLayoutSettings {
  const positions = energyAssetsOf(settings);
  return {
    ...settings,
    energyAssets: positions.some((a) => a.id === assetId)
      ? positions.map((a) => (a.id === assetId ? { ...a, row } : a))
      : [...positions, { id: assetId, row }],
  };
}

export function useSolarCarportRow(siteId: string, enabled = true): SolarCarportRow {
  const queryClient = useQueryClient();
  const canWriteLayout = useHasPermission('sites:write');
  // The same queries (keys and requests) as the Layout tab, so the two share them.
  const { data: site } = useQuery({
    queryKey: ['sites', siteId],
    queryFn: () =>
      api.get<{
        layoutSettings: SiteLayoutSettings | null;
        powerEquipment?: LayoutPowerEquipment;
      }>(`/v1/sites/${siteId}`),
    enabled,
  });
  const { data: stations } = useQuery({
    queryKey: ['sites', siteId, 'layout'],
    queryFn: () => api.get<LayoutStation[]>(`/v1/sites/${siteId}/layout`),
    enabled,
  });

  const settings = useMemo(
    () =>
      site == null || !Array.isArray(stations)
        ? null
        : effectiveLayoutSettings(
            site.layoutSettings,
            stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY })),
            layoutStationCountsOf(stations),
          ),
    [site, stations],
  );
  const placed = useMemo(
    () =>
      settings == null
        ? null
        : placePowerEquipment(settings, site?.powerEquipment ?? NO_POWER_EQUIPMENT),
    [settings, site],
  );

  const rowOf = useCallback(
    (assetId: string | undefined): number => {
      if (placed == null) return 0;
      const canopies = placed.energyAssets.flatMap((a) => (a.type === 'solar' ? [a] : []));
      const own = canopies.find((a) => a.id === assetId);
      if (own != null) return own.row;
      return newSolarCanopyPlace(placed, new Set(canopies.map((a) => a.row)), canopies.length).row;
    },
    [placed],
  );

  const save = useCallback(
    async (assetId: string, row: number): Promise<void> => {
      if (settings == null) return;
      const stored = energyAssetsOf(settings).find((a) => a.id === assetId);
      if (stored?.row === row) return;
      await api.put(`/v1/sites/${siteId}/layout`, {
        positions: [],
        settings: withSolarRow(settings, assetId, row),
      });
      await queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
    },
    [settings, siteId, queryClient],
  );

  return {
    available: canWriteLayout && settings != null && siteTypeOf(settings) === 'parking_lot',
    rows: settings?.rows ?? 0,
    rowOf,
    save,
  };
}
