// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, Zap, Globe, MapPin, Plug } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

interface ConnectorSummary {
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface SearchResult {
  stationId: string;
  model: string | null;
  isOnline: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  evseCount: number;
  availableCount: number;
  connectors: ConnectorSummary[];
}

interface NearbyStation {
  stationId: string;
  model: string | null;
  isOnline: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  distanceKm: number;
  evseCount: number;
  availableCount: number;
  connectors: ConnectorSummary[];
}

interface RoamingLocation {
  id: string;
  partnerId: string;
  countryCode: string;
  partyId: string;
  locationId: string;
  name: string | null;
  address: string | null;
  city: string | null;
  latitude: string | null;
  longitude: string | null;
  evseCount: number;
}

interface PublicConfig {
  roamingEnabled: boolean;
}

interface StoredLocation {
  lat: number;
  lng: number;
  timestamp: number;
}

const LOCATION_KEY = 'evtivity-driver-location';
const LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getStoredLocation(): StoredLocation | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    if (raw == null) return null;
    const loc = JSON.parse(raw) as StoredLocation;
    if (Date.now() - loc.timestamp > LOCATION_MAX_AGE_MS) return null;
    return loc;
  } catch {
    return null;
  }
}

function storeLocation(lat: number, lng: number): void {
  const roundedLat = Math.round(lat * 100) / 100;
  const roundedLng = Math.round(lng * 100) / 100;
  localStorage.setItem(
    LOCATION_KEY,
    JSON.stringify({ lat: roundedLat, lng: roundedLng, timestamp: Date.now() }),
  );
}

function summarizeConnectors(conns: ConnectorSummary[]): string {
  const typeCounts = new Map<string, number>();
  for (const c of conns) {
    const label = c.connectorType ?? 'Unknown';
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
  }
  return Array.from(typeCounts.entries())
    .map(([type, count]) => (count > 1 ? `${String(count)}x ${type}` : type))
    .join(', ');
}

function maxPowerLabel(conns: ConnectorSummary[]): string | null {
  let max = 0;
  for (const c of conns) {
    if (c.maxPowerKw != null && c.maxPowerKw > max) max = c.maxPowerKw;
  }
  if (max === 0) return null;
  return `${String(max)} kW`;
}

function maxCurrentLabel(conns: ConnectorSummary[]): string | null {
  let max = 0;
  for (const c of conns) {
    if (c.maxCurrentAmps != null && c.maxCurrentAmps > max) max = c.maxCurrentAmps;
  }
  if (max === 0) return null;
  return `${String(max)}A`;
}

// Connector-summary row reused by both the nearby and search station cards.
// Renders the plug-type list, max power badge, optional max current, and an
// available/total chip.
function ConnectorsRow({
  connectors,
  availableCount,
  showCurrent,
  availableLabel,
}: {
  connectors: ConnectorSummary[];
  availableCount: number;
  showCurrent: boolean;
  availableLabel: string;
}): React.JSX.Element | null {
  if (connectors.length === 0) return null;
  const power = maxPowerLabel(connectors);
  const current = maxCurrentLabel(connectors);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs flex items-center gap-1">
        <Plug className="h-3 w-3 text-muted-foreground" />
        {summarizeConnectors(connectors)}
      </span>
      {power != null && (
        <Badge variant="secondary" className="text-xs px-1.5 py-0">
          {power}
        </Badge>
      )}
      {showCurrent && current != null && (
        <span className="text-xs text-muted-foreground">{current}</span>
      )}
      <Badge variant={availableCount > 0 ? 'success' : 'outline'} className="text-xs px-1.5 py-0">
        {String(availableCount)}/{String(connectors.length)} {availableLabel}
      </Badge>
    </div>
  );
}

type SearchTab = 'local' | 'roaming';

interface StationSearchListProps {
  /** Called with the selected station's OCPP station ID when a station is picked. */
  onSelect: (stationId: string) => void;
  /**
   * When true, the partner-network ("roaming") tab is hidden even if the
   * platform has roaming enabled. Reservation flows aren't supported on
   * roaming partners (no reservation endpoint over OCPI), so callers can
   * suppress that tab to avoid leading users into a dead end.
   */
  hideRoamingTab?: boolean;
  /** Heading rendered above the search input. Defaults to "Find a charger". */
  title?: string;
  /** Placeholder for the local-network search input. */
  searchPlaceholder?: string;
}

export function StationSearchList({
  onSelect,
  hideRoamingTab,
  title,
  searchPlaceholder,
}: StationSearchListProps): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SearchTab>('local');
  const [query, setQuery] = useState('');
  // Debounced copy of `query` so the input feels responsive locally but we
  // only hit /chargers/search after the user stops typing for 250ms.
  // Without this every keystroke past 2 chars (e.g. "Tesl" -> "Tesla") fires
  // a fresh request because the queryKey changes.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(getStoredLocation);
  const [locationDenied, setLocationDenied] = useState(false);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (location != null) return;
    if (!('geolocation' in navigator)) {
      setLocationDenied(true);
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        storeLocation(lat, lng);
        setLocation({ lat, lng });
      },
      () => {
        setLocationDenied(true);
      },
      { timeout: 10000, maximumAge: LOCATION_MAX_AGE_MS, enableHighAccuracy: false },
    );
    return () => {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [location]);

  const { data: publicConfig } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<PublicConfig>('/v1/security/public'),
  });

  const roamingEnabled = !hideRoamingTab && publicConfig?.roamingEnabled === true;

  const { data: nearbyStations, isError: nearbyError } = useQuery({
    queryKey: ['charger-nearby', location?.lat, location?.lng],
    queryFn: () => {
      if (location == null) return Promise.resolve([]);
      return api.get<NearbyStation[]>(
        `/v1/portal/chargers/nearby?lat=${String(location.lat)}&lng=${String(location.lng)}&radius=16&limit=10`,
      );
    },
    enabled: location != null,
    staleTime: 5 * 60 * 1000,
  });

  const { data: results } = useQuery({
    queryKey: ['charger-search', debouncedQuery],
    queryFn: () =>
      api.get<SearchResult[]>(`/v1/portal/chargers/search?q=${encodeURIComponent(debouncedQuery)}`),
    enabled: tab === 'local' && debouncedQuery.length >= 2,
  });

  const { data: roamingResults } = useQuery({
    queryKey: ['roaming-search', debouncedQuery],
    queryFn: () =>
      api.get<RoamingLocation[]>(
        `/v1/portal/chargers/roaming?q=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: roamingEnabled && tab === 'roaming' && debouncedQuery.length >= 2,
  });

  function handleEnableLocation(): void {
    setLocationDenied(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        storeLocation(pos.coords.latitude, pos.coords.longitude);
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocationDenied(true);
      },
      { timeout: 10000 },
    );
  }

  function handleTabChange(newTab: SearchTab): void {
    setTab(newTab);
    setQuery('');
  }

  const showNearby =
    tab === 'local' && query.length < 2 && nearbyStations != null && nearbyStations.length > 0;

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      <h1 className="text-xl font-bold">{title ?? t('chargerSearch.title')}</h1>

      {roamingEnabled && (
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === 'local'
                ? 'bg-background shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              handleTabChange('local');
            }}
          >
            <Zap className="mr-1.5 inline-block h-3.5 w-3.5" />
            {t('chargerSearch.ourNetwork')}
          </button>
          <button
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === 'roaming'
                ? 'bg-background shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              handleTabChange('roaming');
            }}
          >
            <Globe className="mr-1.5 inline-block h-3.5 w-3.5" />
            {t('chargerSearch.partnerNetworks')}
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder={
            tab === 'local'
              ? (searchPlaceholder ?? t('chargerSearch.searchPlaceholder'))
              : t('chargerSearch.roamingSearchPlaceholder')
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </div>

      {location == null && locationDenied && (
        <div className="flex items-center justify-between rounded-lg border border-dashed p-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 shrink-0" />
            {t('chargerSearch.enableLocation')}
          </div>
          <button
            onClick={handleEnableLocation}
            className="text-sm font-medium text-primary hover:underline shrink-0"
          >
            {t('chargerSearch.enableLocationButton')}
          </button>
        </div>
      )}

      {nearbyError && (
        <p className="text-sm text-destructive px-4">{t('chargerSearch.nearbyError')}</p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
        {showNearby && (
          <>
            <p className="text-sm font-medium text-muted-foreground">
              {t('chargerSearch.nearbyStations')}
            </p>
            {nearbyStations.map((station) => (
              <Card
                key={station.stationId}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => {
                  onSelect(station.stationId);
                }}
              >
                <CardContent className="p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{station.stationId}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {String(station.distanceKm)} {t('chargerSearch.km')}
                      </span>
                      <div
                        className={`h-2 w-2 rounded-full ${station.isOnline ? 'bg-success' : 'bg-destructive'}`}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3 shrink-0" />
                    {station.siteName ?? ''}
                    {station.siteCity != null ? `, ${station.siteCity}` : ''}
                  </p>
                  <ConnectorsRow
                    connectors={station.connectors}
                    availableCount={station.availableCount}
                    showCurrent
                    availableLabel={t('chargerSearch.available')}
                  />
                </CardContent>
              </Card>
            ))}
          </>
        )}

        {tab === 'local' &&
          results != null &&
          results.length > 0 &&
          results.map((station) => (
            <Card
              key={station.stationId}
              className="cursor-pointer transition-colors hover:bg-accent/50"
              onClick={() => {
                onSelect(station.stationId);
              }}
            >
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{station.stationId}</p>
                    {station.siteName != null && (
                      <p className="text-xs text-muted-foreground">{station.siteName}</p>
                    )}
                  </div>
                  <div
                    className={`h-2 w-2 rounded-full ${station.isOnline ? 'bg-success' : 'bg-destructive'}`}
                  />
                </div>
                {(station.siteAddress != null || station.siteCity != null) && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3 shrink-0" />
                    {[station.siteAddress, station.siteCity].filter(Boolean).join(', ')}
                  </p>
                )}
                <ConnectorsRow
                  connectors={station.connectors}
                  availableCount={station.availableCount}
                  showCurrent={false}
                  availableLabel={t('chargerSearch.available')}
                />
              </CardContent>
            </Card>
          ))}

        {tab === 'roaming' &&
          roamingResults != null &&
          roamingResults.length > 0 &&
          roamingResults.map((location) => (
            <Card key={location.id} className="hover:bg-accent/50">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{location.name ?? location.locationId}</p>
                    {location.address != null && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {location.address}
                        {location.city != null ? `, ${location.city}` : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {location.countryCode}-{location.partyId}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {String(location.evseCount)} EVSE
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

        {tab === 'roaming' &&
          roamingResults != null &&
          roamingResults.length === 0 &&
          query.length >= 2 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('chargerSearch.noRoamingResults')}
            </p>
          )}
      </div>
    </div>
  );
}
