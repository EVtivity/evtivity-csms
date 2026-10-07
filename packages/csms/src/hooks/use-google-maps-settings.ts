// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface GoogleMapsSettings {
  /** Browser key for the Maps JavaScript API. Empty when not configured. */
  apiKey: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
}

/**
 * The Google Maps browser key and default view. Read from the public map
 * config endpoint the portal uses, so map components work without settings
 * permissions. The key is a referrer-restricted browser key that every map
 * page publishes anyway.
 */
export function useGoogleMapsSettings(): UseQueryResult<GoogleMapsSettings> {
  return useQuery({
    // The key and defaults change rarely. Cache for an hour so multiple map
    // components mounted in the same session share one fetch. The key sits
    // under ['settings'] so saving the Google Maps settings refreshes it.
    staleTime: 60 * 60 * 1000,
    queryKey: ['settings', 'google-maps'],
    queryFn: () => api.get<GoogleMapsSettings>('/v1/portal/chargers/map-config'),
  });
}
