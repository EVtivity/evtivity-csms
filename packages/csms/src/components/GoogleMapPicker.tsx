// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { MapPin } from 'lucide-react';
import { api } from '@/lib/api';

interface GoogleMapPickerProps {
  latitude: string;
  longitude: string;
  onLocationChange: (lat: string, lng: string) => void;
}

interface MapsSettings {
  apiKey: string;
  defaultLat: string;
  defaultLng: string;
  defaultZoom: string;
}

let optionsSet = false;

export function GoogleMapPicker({
  latitude,
  longitude,
  onLocationChange,
}: GoogleMapPickerProps): React.JSX.Element {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['google-maps-settings'],
    queryFn: async () => {
      const allSettings = await api.get<Record<string, unknown>>('/v1/settings');
      return {
        apiKey:
          typeof allSettings['googleMaps.apiKey'] === 'string'
            ? allSettings['googleMaps.apiKey']
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
      } satisfies MapsSettings;
    },
  });

  useEffect(() => {
    if (settings == null || settings.apiKey === '' || mapRef.current == null) return;
    if (mapInstanceRef.current != null) return;

    if (!optionsSet) {
      setOptions({ key: settings.apiKey, v: 'weekly', libraries: ['places', 'marker'] });
      optionsSet = true;
    }

    void (async () => {
      try {
        const mapsLib = await importLibrary('maps');
        if (mapRef.current == null) return;

        const lat = latitude !== '' ? Number(latitude) : Number(settings.defaultLat);
        const lng = longitude !== '' ? Number(longitude) : Number(settings.defaultLng);
        const zoom = latitude !== '' && longitude !== '' ? 15 : Number(settings.defaultZoom);

        const map = new mapsLib.Map(mapRef.current, {
          center: { lat, lng },
          zoom,
          mapId: 'evtivity-site-picker',
          gestureHandling: 'greedy',
        });

        mapInstanceRef.current = map;

        const markerLib = await importLibrary('marker');
        const marker = new markerLib.AdvancedMarkerElement({
          map,
          position: { lat, lng },
          gmpDraggable: true,
          title: 'Site location',
        });

        marker.addListener('dragend', () => {
          const pos = marker.position;
          if (pos != null) {
            const newLat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
            const newLng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
            onLocationChange(newLat.toFixed(6), newLng.toFixed(6));
          }
        });

        markerRef.current = marker;

        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (e.latLng == null) return;
          const newLat = e.latLng.lat();
          const newLng = e.latLng.lng();
          onLocationChange(newLat.toFixed(6), newLng.toFixed(6));
          if (markerRef.current != null) {
            markerRef.current.position = { lat: newLat, lng: newLng };
          }
        });
      } catch (err) {
        console.error('Google Maps load error:', err);
        setMapError(err instanceof Error ? err.message : 'Failed to load Google Maps');
      }
    })();
  }, [settings, latitude, longitude, onLocationChange]);

  // Update marker when lat/lng props change externally
  useEffect(() => {
    if (markerRef.current == null || mapInstanceRef.current == null) return;
    if (latitude === '' || longitude === '') return;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    markerRef.current.position = { lat, lng };
    mapInstanceRef.current.panTo({ lat, lng });
  }, [latitude, longitude]);

  if (settings == null || settings.apiKey === '') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        <MapPin className="h-4 w-4" />
        Configure Google Maps API key in Settings to enable the map picker.
      </div>
    );
  }

  if (mapError != null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-destructive">
        <MapPin className="h-4 w-4" />
        {mapError}
      </div>
    );
  }

  return <div ref={mapRef} className="h-64 w-full rounded-md border" />;
}
