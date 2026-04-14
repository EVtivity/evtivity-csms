// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface MapConfig {
  apiKey: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
}

interface LocationMapProps {
  latitude: string;
  longitude: string;
  name: string;
}

let optionsSet = false;

export function LocationMap({
  latitude,
  longitude,
  name,
}: LocationMapProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);

  const { data: config } = useQuery({
    queryKey: ['map-config'],
    queryFn: () => api.get<MapConfig>('/v1/portal/chargers/map-config'),
    staleTime: 1000 * 60 * 30,
  });

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  useEffect(() => {
    if (config == null || config.apiKey === '' || mapRef.current == null) return;
    if (isNaN(lat) || isNaN(lng)) return;
    if (mapInstanceRef.current != null) return;

    if (!optionsSet) {
      setOptions({ key: config.apiKey, v: 'weekly', libraries: ['marker'] });
      optionsSet = true;
    }

    void (async () => {
      try {
        const mapsLib = await importLibrary('maps');
        if (mapRef.current == null) return;

        const position = { lat, lng };
        const map = new mapsLib.Map(mapRef.current, {
          center: position,
          zoom: 15,
          disableDefaultUI: true,
          zoomControl: true,
          mapId: 'location-detail-map',
        });

        mapInstanceRef.current = map;

        const markerLib = await importLibrary('marker');
        new markerLib.AdvancedMarkerElement({
          map,
          position,
          title: name,
        });
      } catch {
        // Google Maps failed to load, fallback is handled by hiding the map
      }
    })();
  }, [config, lat, lng, name]);

  if (config == null || config.apiKey === '') {
    return null;
  }

  if (isNaN(lat) || isNaN(lng)) {
    return null;
  }

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${String(lat)},${String(lng)}`;

  return (
    <div className="space-y-3">
      <div
        ref={mapRef}
        className="h-[300px] w-full rounded-lg bg-muted"
        style={{ minHeight: '300px' }}
      />
      <Button
        variant="outline"
        size="lg"
        className="w-full gap-2"
        onClick={() => {
          window.open(directionsUrl, '_blank', 'noopener,noreferrer');
        }}
      >
        <Navigation className="h-4 w-4" />
        {t('location.getDirections')}
      </Button>
    </div>
  );
}
