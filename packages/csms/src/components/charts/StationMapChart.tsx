// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { MapPin } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { api } from '@/lib/api';
import { useGoogleMapsSettings } from '@/hooks/use-google-maps-settings';

interface SiteLocation {
  siteId: string;
  name: string;
  latitude: string;
  longitude: string;
  stationCount: number;
}

let optionsSet = false;

export function StationMapChart({ info }: { info?: string }): React.JSX.Element {
  const { t } = useTranslation();
  const mapRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const { data: mapsSettings } = useGoogleMapsSettings();

  const { data: siteLocations } = useQuery({
    queryKey: ['dashboard', 'site-locations'],
    queryFn: () => api.get<SiteLocation[]>('/v1/dashboard/site-locations'),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (mapsSettings == null || mapsSettings.apiKey === '' || mapRef.current == null) return;
    if (mapInstance != null) return;

    if (!optionsSet) {
      setOptions({ key: mapsSettings.apiKey, v: 'weekly', libraries: ['marker'] });
      optionsSet = true;
    }

    void (async () => {
      try {
        const mapsLib = await importLibrary('maps');
        if (mapRef.current == null) return;

        const map = new mapsLib.Map(mapRef.current, {
          center: {
            lat: Number(mapsSettings.defaultLat),
            lng: Number(mapsSettings.defaultLng),
          },
          zoom: Number(mapsSettings.defaultZoom),
          mapId: 'evtivity-dashboard-map',
          gestureHandling: 'cooperative',
          streetViewControl: false,
          mapTypeControl: false,
        });

        setMapInstance(map);
      } catch (err) {
        console.error('Google Maps load error:', err);
        setMapError(err instanceof Error ? err.message : 'Failed to load Google Maps');
      }
    })();
  }, [mapsSettings, mapInstance]);

  useEffect(() => {
    const map = mapInstance;
    if (map == null || siteLocations == null || siteLocations.length === 0) return;

    void (async () => {
      try {
        const markerLib = await importLibrary('marker');

        for (const m of markersRef.current) {
          m.map = null;
        }
        markersRef.current = [];

        for (const site of siteLocations) {
          const lat = Number(site.latitude);
          const lng = Number(site.longitude);
          if (isNaN(lat) || isNaN(lng)) continue;

          const marker = new markerLib.AdvancedMarkerElement({
            map,
            position: { lat, lng },
            title: `${site.name} (${String(site.stationCount)} stations)`,
          });

          markersRef.current.push(marker);
        }
        // Map stays at the operator-configured default center/zoom from
        // Settings > Integrations > Google Maps. Auto-fitting to markers
        // would override the configured view every time a new site is added.
      } catch {
        // Markers failed but map is still usable
      }
    })();
  }, [siteLocations, mapInstance]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          {t('dashboard.siteMap')}
          {info != null && <InfoTooltip content={<div className="max-w-56">{info}</div>} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {mapsSettings == null || mapsSettings.apiKey === '' ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" />
            Configure Google Maps API key in Settings to enable the site map.
          </div>
        ) : mapError != null ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-destructive">
            <MapPin className="h-4 w-4" />
            {mapError}
          </div>
        ) : (
          <div ref={mapRef} className="h-96 w-full rounded-md border" />
        )}
      </CardContent>
    </Card>
  );
}
