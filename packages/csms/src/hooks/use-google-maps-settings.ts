// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface GoogleMapsSettings {
  apiKey: string;
  defaultLat: string;
  defaultLng: string;
  defaultZoom: string;
}

export function useGoogleMapsSettings(): UseQueryResult<GoogleMapsSettings> {
  return useQuery({
    // Google Maps key + defaults change rarely. Cache for an hour so multiple
    // map components mounted in the same session share one settings fetch.
    staleTime: 60 * 60 * 1000,
    queryKey: ['google-maps-settings'],
    queryFn: async () => {
      const allSettings = await api.get<Record<string, unknown>>('/v1/settings');
      return {
        apiKey:
          typeof allSettings['googleMaps.apiKeyEnc'] === 'string'
            ? allSettings['googleMaps.apiKeyEnc']
            : '',
        defaultLat:
          typeof allSettings['googleMaps.defaultLat'] === 'string'
            ? allSettings['googleMaps.defaultLat']
            : '39.8283',
        defaultLng:
          typeof allSettings['googleMaps.defaultLng'] === 'string'
            ? allSettings['googleMaps.defaultLng']
            : '-98.5795',
        defaultZoom:
          typeof allSettings['googleMaps.defaultZoom'] === 'string'
            ? allSettings['googleMaps.defaultZoom']
            : '4',
      } satisfies GoogleMapsSettings;
    },
  });
}
