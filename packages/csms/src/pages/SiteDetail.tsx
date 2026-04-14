// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SiteLayout } from '@/components/layout/SiteLayout';
import { LoadManagement } from '@/components/load-management/LoadManagement';
import { StationsTable } from '@/components/StationsTable';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { api } from '@/lib/api';
import { Pagination } from '@/components/ui/pagination';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { ReservationsTable } from '@/components/ReservationsTable';
import { SiteDetailsTab } from '@/components/site/SiteDetailsTab';
import { SiteMetricsTab } from '@/components/site/SiteMetricsTab';
import { SiteQrCodesTab } from '@/components/site/SiteQrCodesTab';
import { SitePricingTab } from '@/components/site/SitePricingTab';
import { SiteFreeVendTab } from '@/components/site/SiteFreeVendTab';

interface Site {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactIsPublic: boolean;
  hoursOfOperation: string | null;
  reservationsEnabled: boolean;
  freeVendEnabled: boolean;
  freeVendTemplateId21: string | null;
  freeVendTemplateId16: string | null;
  carbonRegionCode: string | null;
  stationCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Station {
  id: string;
  stationId: string;
  model: string | null;
  securityProfile: number;
  availability: string;
  status: string;
  connectorCount: number;
  connectorTypes: string[] | null;
  isOnline: boolean;
  lastHeartbeat: string | null;
}

export function SiteDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [stationsPage, setStationsPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsStatus, setSessionsStatus] = useState('');
  const [sessionsStationId, setSessionsStationId] = useState('');
  const [activeTab, setActiveTab] = useTab('details');
  const { t } = useTranslation();

  const { data: site, isLoading } = useQuery({
    queryKey: ['sites', id],
    queryFn: () => api.get<Site>(`/v1/sites/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });
  const guestChargingEnabled = settingsData?.['guest.enabled'] !== false;
  const reservationEnabled = settingsData?.['reservation.enabled'] !== false;

  const stationsLimit = 10;
  const { data: stationsResponse } = useQuery({
    queryKey: ['sites', id, 'stations', stationsPage],
    queryFn: () =>
      api.get<{ data: Station[]; total: number }>(
        `/v1/sites/${id ?? ''}/stations?page=${String(stationsPage)}&limit=${String(stationsLimit)}`,
      ),
    enabled: id != null,
  });
  const stations = stationsResponse?.data;
  const stationsTotalPages = Math.max(1, Math.ceil((stationsResponse?.total ?? 0) / stationsLimit));

  const { data: siteStationsForFilter } = useQuery({
    queryKey: ['sites', id, 'stations-filter'],
    queryFn: () =>
      api.get<{ data: { id: string; stationId: string }[]; total: number }>(
        `/v1/sites/${id ?? ''}/stations?limit=100`,
      ),
    enabled: id != null,
  });

  const sessionsLimit = 10;
  const sessionsQueryParams = new URLSearchParams({
    page: String(sessionsPage),
    limit: String(sessionsLimit),
  });
  if (sessionsStatus !== '') sessionsQueryParams.set('status', sessionsStatus);
  if (sessionsStationId !== '') sessionsQueryParams.set('stationId', sessionsStationId);
  const { data: sessionsResponse } = useQuery({
    queryKey: ['sites', id, 'sessions', sessionsPage, sessionsStatus, sessionsStationId],
    queryFn: () =>
      api.get<{ data: Session[]; total: number }>(
        `/v1/sites/${id ?? ''}/sessions?${sessionsQueryParams.toString()}`,
      ),
    enabled: id != null,
  });
  const sessionsData = sessionsResponse?.data;
  const sessionsTotalPages = Math.max(1, Math.ceil((sessionsResponse?.total ?? 0) / sessionsLimit));

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });

  const googleMapsApiKey =
    settings != null && typeof settings['googleMaps.apiKey'] === 'string'
      ? settings['googleMaps.apiKey']
      : '';

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<Site>(`/v1/sites/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      void navigate('/sites');
    },
  });

  const reservationToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<Site>(`/v1/sites/${id ?? ''}`, { reservationsEnabled: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', id] });
    },
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (site == null) {
    return <p className="text-destructive">{t('sites.siteNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/sites" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{site.name}</h1>
          <CopyableId id={site.id} />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="metrics">{t('sites.metrics')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          <TabsTrigger value="stations">{t('nav.stations')}</TabsTrigger>
          <TabsTrigger value="layout">{t('sites.layout')}</TabsTrigger>
          <TabsTrigger value="load-management">{t('sites.loadManagement')}</TabsTrigger>
          <TabsTrigger value="qr-codes">{t('stations.qrCodes')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('sites.pricing')}</TabsTrigger>
          {reservationEnabled && (
            <TabsTrigger value="reservations">{t('reservations.title')}</TabsTrigger>
          )}
          <TabsTrigger value="free-vend">{t('sites.freeVend')}</TabsTrigger>
        </TabsList>

        <SiteDetailsTab
          site={site}
          siteId={id ?? ''}
          googleMapsApiKey={googleMapsApiKey}
          onDelete={() => {
            deleteMutation.mutate();
          }}
          deleteIsPending={deleteMutation.isPending}
        />

        <TabsContent value="stations">
          <Card>
            <CardHeader>
              <CardTitle>{t('nav.stations')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="overflow-x-auto">
                <StationsTable
                  stations={stations}
                  timezone={site.timezone}
                  emptyMessage={t('sites.noStationsAtSite')}
                />
              </div>
              <Pagination
                page={stationsPage}
                totalPages={stationsTotalPages}
                onPageChange={setStationsPage}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <SiteMetricsTab siteId={id ?? ''} />

        <TabsContent value="sessions">
          <Card>
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <CardTitle>{t('sessions.title')}</CardTitle>
              <ResponsiveFilters
                activeCount={[sessionsStationId, sessionsStatus].filter(Boolean).length}
              >
                <Select
                  aria-label="Filter by station"
                  value={sessionsStationId}
                  onChange={(e) => {
                    setSessionsStationId(e.target.value);
                    setSessionsPage(1);
                  }}
                  className="h-9 sm:w-44"
                >
                  <option value="">{t('sessions.allStations')}</option>
                  {siteStationsForFilter?.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.stationId}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter by status"
                  value={sessionsStatus}
                  onChange={(e) => {
                    setSessionsStatus(e.target.value);
                    setSessionsPage(1);
                  }}
                  className="h-9 sm:w-44"
                >
                  <option value="">{t('sessions.allStatuses')}</option>
                  <option value="active">{t('status.active')}</option>
                  <option value="idling">{t('status.idle')}</option>
                  <option value="completed">{t('status.completed')}</option>
                  <option value="faulted">{t('status.faulted')}</option>
                </Select>
              </ResponsiveFilters>
            </CardHeader>
            <CardContent>
              <SessionsTable
                sessions={sessionsData}
                page={sessionsPage}
                totalPages={sessionsTotalPages}
                onPageChange={setSessionsPage}
                timezone={site.timezone}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="layout">
          <SiteLayout siteId={id ?? ''} />
        </TabsContent>

        <TabsContent value="load-management">
          <LoadManagement siteId={id ?? ''} />
        </TabsContent>

        <SiteQrCodesTab stations={stations} guestChargingEnabled={guestChargingEnabled} />

        <SitePricingTab siteId={id ?? ''} />

        {reservationEnabled && (
          <TabsContent value="reservations" className="space-y-6">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div className="grid gap-1">
                    <Label>{t('sites.reservationsEnabled')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('sites.reservationsEnabledHelp')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={site.reservationsEnabled}
                    onClick={() => {
                      reservationToggleMutation.mutate(!site.reservationsEnabled);
                    }}
                    disabled={reservationToggleMutation.isPending}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${site.reservationsEnabled ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${site.reservationsEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              </CardContent>
            </Card>
            <ReservationsTable siteId={id} timezone={site.timezone} />
          </TabsContent>
        )}

        <SiteFreeVendTab site={site} siteId={id ?? ''} />
      </Tabs>
    </div>
  );
}
