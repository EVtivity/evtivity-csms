// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The data a site layout view reads: the stations with their positions, the
// lot settings, the company logo and the load management state. The Layout
// tab (SiteLayout.tsx) edits it; the dashboard Site Layout widget only shows it
// (useSiteLayoutView). No three.js here, so the dashboard chunk stays small.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  NO_POWER_EQUIPMENT,
  effectiveLayoutSettings,
  placePowerEquipment,
  layoutStationPlaces,
  positionToBay,
  type LayoutPowerEquipment,
  type PlacedLayoutSettings,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import type { LayoutStation } from './StationCard';
import { isCaliforniaSite } from './site-layout-signs';
import { layoutStationCountsOf } from './site-layout-free';
import type { HierarchyLinkNode } from './site-layout-links';
import { useSiteTerminals, type LayoutTerminal } from './layout-terminals';
import {
  LIVE_INSIGHT_STATUS_FILTER,
  useInsights,
  type AiInsightView,
} from '@/components/ai/insights/insight-api';
import { insightHeadline, insightPath } from '@/components/ai/insights/insight-display';

export interface LoadManagementStation {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

export interface LoadManagementResponse {
  config: {
    strategy: string;
    isEnabled: boolean;
  } | null;
  hierarchy: HierarchyLinkNode[];
  stations: LoadManagementStation[];
}

const COLUMN_COUNT = 5;
const SPACING_X = 200;
const SPACING_Y = 140;
const PADDING = 20;

/** Positions for a site whose stations were never placed (all at 0, 0): rows of five. */
export function autoLayout(stations: LayoutStation[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  stations.forEach((station, i) => {
    const col = i % COLUMN_COUNT;
    const row = Math.floor(i / COLUMN_COUNT);
    positions.set(station.id, {
      x: PADDING + col * SPACING_X,
      y: PADDING + row * SPACING_Y,
    });
  });
  return positions;
}

/** The stored positions, or rows of five when none was ever placed. */
export function placedLayoutStations(stations: readonly LayoutStation[]): LayoutStation[] {
  const allZero = stations.every((s) => s.positionX === 0 && s.positionY === 0);
  if (!allZero) return [...stations];
  const auto = autoLayout([...stations]);
  return stations.map((s) => {
    const p = auto.get(s.id);
    return p == null ? s : { ...s, positionX: p.x, positionY: p.y };
  });
}

/** The company logo of the public branding, or null. */
export function useBrandingLogo(): string | null {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  return typeof branding?.['logo'] === 'string' && branding['logo'] !== ''
    ? branding['logo']
    : null;
}

export interface SiteLayoutView {
  stations: LayoutStation[];
  /** The effective settings with the site's power equipment at its positions. */
  settings: PlacedLayoutSettings;
  terminals: Map<string, LayoutTerminal[]>;
  /** The site's panels and circuits, null without loadManagement:read (equipment shows either way). */
  hierarchy: HierarchyLinkNode[] | null;
  /** The site's transformers and energy assets (names and ratings). */
  equipment: LayoutPowerEquipment;
  /** Load management is on: the cable runs and the live power show only then. */
  loadManaged: boolean;
  logoUrl: string | null;
  /** The site name (from the site record), once loaded. */
  siteName: string | undefined;
  /** The site is in California (its state and country): the stalls add the tow-away sign. */
  california: boolean;
  power: Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * The saved layout of a site, read only (the dashboard widget). `live`
 * polls the load management state every 5 s while the view is on screen;
 * without `loadManagement:read` it is not requested.
 */
export function useSiteLayoutView(siteId: string, live: boolean): SiteLayoutView {
  const canReadLoad = useHasPermission('loadManagement:read');
  const terminals = useSiteTerminals(siteId);
  const logoUrl = useBrandingLogo();
  const enabled = siteId !== '';

  const site = useQuery({
    queryKey: ['sites', siteId],
    queryFn: () =>
      api.get<{
        name: string;
        state?: string | null;
        country?: string | null;
        layoutSettings: SiteLayoutSettings | null;
        powerEquipment?: LayoutPowerEquipment;
      }>(`/v1/sites/${siteId}`),
    enabled,
  });
  const layout = useQuery({
    queryKey: ['sites', siteId, 'layout'],
    queryFn: () => api.get<LayoutStation[]>(`/v1/sites/${siteId}/layout`),
    enabled,
    refetchInterval: live ? 30_000 : false,
  });
  const loadManagement = useQuery({
    queryKey: ['sites', siteId, 'load-management'],
    queryFn: () => api.get<LoadManagementResponse>(`/v1/sites/${siteId}/load-management`),
    enabled: enabled && canReadLoad,
    refetchInterval: live ? 5000 : false,
  });

  const stations = useMemo(() => placedLayoutStations(layout.data ?? []), [layout.data]);
  const settings = useMemo(() => {
    const effective = effectiveLayoutSettings(
      site.data?.layoutSettings,
      stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY })),
      layoutStationCountsOf(stations),
    );
    return placePowerEquipment(
      effective,
      site.data?.powerEquipment ?? NO_POWER_EQUIPMENT,
      layoutStationPlaces(stations, effective),
    );
  }, [site.data, stations]);
  const power = useMemo(() => {
    const map = new Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>();
    for (const s of loadManagement.data?.stations ?? []) {
      map.set(s.id, { currentDrawKw: s.currentDrawKw, allocatedLimitKw: s.allocatedLimitKw });
    }
    return map;
  }, [loadManagement.data]);

  const lm = loadManagement.data;
  return {
    stations,
    settings,
    terminals,
    hierarchy: lm?.hierarchy ?? null,
    equipment: site.data?.powerEquipment ?? NO_POWER_EQUIPMENT,
    loadManaged: lm?.config?.isEnabled === true,
    logoUrl,
    siteName: site.data?.name,
    california: site.data != null && isCaliforniaSite(site.data),
    power,
    isLoading: layout.isLoading || site.isLoading,
    isError: layout.isError || site.isError,
    refetch: () => {
      void layout.refetch();
      void site.refetch();
    },
  };
}

/** An open AI insight marker on a station of the 3D layout. */
export interface LayoutInsight {
  id: string;
  headline: string;
  path: string;
}

/** The open insights by station (newest first), from an insight list. */
export function insightsByStation(
  insights: readonly AiInsightView[],
  headline: (insight: AiInsightView) => string,
): Map<string, LayoutInsight[]> {
  const map = new Map<string, LayoutInsight[]>();
  for (const insight of insights) {
    if (insight.stationId == null) continue;
    const list = map.get(insight.stationId) ?? [];
    list.push({ id: insight.id, headline: headline(insight), path: insightPath(insight) });
    map.set(insight.stationId, list);
  }
  return map;
}

/**
 * The open AI insights of a site's stations (open or with an action waiting),
 * for the insight markers of the 3D layout. Not requested without
 * aiInsights:read. The ai.insight.updated event refreshes it (['ai', 'insights']).
 */
export function useLayoutInsights(siteId: string, enabled: boolean): Map<string, LayoutInsight[]> {
  const { t } = useTranslation();
  const { insights } = useInsights(
    { siteId, status: LIVE_INSIGHT_STATUS_FILTER, limit: 100 },
    enabled && siteId !== '',
  );
  return useMemo(
    () => insightsByStation(insights, (insight) => insightHeadline(t, insight)),
    [insights, t],
  );
}
