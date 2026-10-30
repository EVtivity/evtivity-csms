// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The data a site layout view reads: the stations with their positions, the
// lot settings, the company logo and the load management state. The Layout
// tab (SiteLayout.tsx) edits it; the dashboard Site Layout widget only shows it
// (useSiteLayoutView). No three.js here, so the dashboard chunk stays small.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  effectiveLayoutSettings,
  positionToBay,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import type { LayoutStation } from './StationCard';
import type { LinkPanel } from './site-layout-links';
import { useSiteTerminals, type LayoutTerminal } from './layout-terminals';

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
  hierarchy: LinkPanel[];
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
  settings: SiteLayoutSettings;
  terminals: Map<string, LayoutTerminal[]>;
  /** The load management hierarchy while the site is load managed, else null. */
  hierarchy: LinkPanel[] | null;
  logoUrl: string | null;
  /** The site name (from the site record), once loaded. */
  siteName: string | undefined;
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
      api.get<{ name: string; layoutSettings: SiteLayoutSettings | null }>(`/v1/sites/${siteId}`),
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
  const settings = useMemo(
    () =>
      effectiveLayoutSettings(
        site.data?.layoutSettings,
        stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY })),
      ),
    [site.data, stations],
  );
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
    hierarchy: lm?.config?.isEnabled === true ? lm.hierarchy : null,
    logoUrl,
    siteName: site.data?.name,
    power,
    isLoading: layout.isLoading || site.isLoading,
    isError: layout.isError || site.isError,
    refetch: () => {
      void layout.refetch();
      void site.refetch();
    },
  };
}
