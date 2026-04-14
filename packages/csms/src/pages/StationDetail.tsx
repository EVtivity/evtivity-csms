// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ConnectorStatus } from '@/components/charts/ConnectorStatus';
import { StationCommands } from '@/components/StationCommands';
import { OcppMessageLog } from '@/components/OcppMessageLog';
import { StationSecurity } from '@/components/StationSecurity';
import { StationDisplayMessages } from '@/components/StationDisplayMessages';
import { StationCertificates } from '@/components/StationCertificates';
import { StationLocalAuthList } from '@/components/StationLocalAuthList';
import { MeterValuesTable } from '@/components/MeterValuesTable';
import { StationEventsTab } from '@/components/StationEventsTab';
import { StationConfigurationsTab } from '@/components/StationConfigurationsTab';
import { StationFirmwareTab } from '@/components/StationFirmwareTab';
import { StationChargingProfilesTab } from '@/components/StationChargingProfilesTab';
import { StationImages } from '@/components/StationImages';
import { StationSimulate } from '@/components/StationSimulate';
import { StationInfoTab } from '@/components/station/StationInfoTab';
import { StationMetricsTab } from '@/components/station/StationMetricsTab';
import { StationSessionsTab } from '@/components/station/StationSessionsTab';
import { StationQrTab } from '@/components/station/StationQrTab';
import { StationPricingTab } from '@/components/station/StationPricingTab';
import { StationReservationsTab } from '@/components/station/StationReservationsTab';
import { api } from '@/lib/api';

interface Site {
  id: string;
  name: string;
  timezone: string;
}

interface Station {
  id: string;
  stationId: string;
  siteId: string | null;
  vendorName: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  iccid: string | null;
  imsi: string | null;
  availability: string;
  onboardingStatus: string;
  status: string;
  isOnline: boolean;
  isSimulator: boolean;
  lastHeartbeat: string | null;
  ocppProtocol: string | null;
  securityProfile: number;
  hasPassword: boolean;
  latitude: string | null;
  longitude: string | null;
  reservationsEnabled: boolean;
  siteHoursOfOperation: string | null;
  siteFreeVendEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Connector {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
  isIdling?: boolean;
}

interface Evse {
  evseId: number;
  status: string;
  connectors: Connector[];
}

export function StationDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [detailsTab, setDetailsTab] = useTab('info');
  const { t } = useTranslation();

  const { data: sitesResponse } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });
  const guestChargingEnabled = settingsData?.['guest.enabled'] !== false;
  const reservationEnabled = settingsData?.['reservation.enabled'] !== false;
  const sites = sitesResponse?.data;

  const { data: station, isLoading } = useQuery({
    queryKey: ['stations', id],
    queryFn: () => api.get<Station>(`/v1/stations/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: connectorsData } = useQuery({
    queryKey: ['stations', id, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${id ?? ''}/connectors`),
    enabled: id != null,
  });

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${id ?? ''}/approve`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', id] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${id ?? ''}/reject`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', id] });
    },
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (station == null) {
    return <p className="text-destructive">{t('stations.stationNotFound')}</p>;
  }

  const siteTimezone = sites?.find((s) => s.id === station.siteId)?.timezone ?? 'America/New_York';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <BackButton to="/stations" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{station.stationId}</h1>
            <CopyableId id={station.id} />
          </div>
          <Badge variant={station.isOnline ? 'success' : 'destructive'}>
            {station.isOnline ? t('status.online') : t('status.offline')}
          </Badge>
          {station.isSimulator && <Badge variant="info">{t('stations.simulator')}</Badge>}
          {station.siteFreeVendEnabled && <Badge variant="info">{t('stations.freeVend')}</Badge>}
          {station.onboardingStatus === 'pending' && (
            <Badge variant="warning">{t('status.pending')}</Badge>
          )}
          {station.onboardingStatus === 'blocked' && (
            <Badge variant="destructive">{t('status.blocked')}</Badge>
          )}
        </div>
      </div>

      {station.onboardingStatus === 'pending' && (
        <Card className="border-warning">
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-sm">{t('stations.pendingApproval')}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  rejectMutation.mutate();
                }}
                disabled={rejectMutation.isPending}
              >
                {t('stations.reject')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  approveMutation.mutate();
                }}
                disabled={approveMutation.isPending}
              >
                {t('stations.approve')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {station.onboardingStatus === 'blocked' && (
        <Card className="border-destructive">
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-sm">{t('stations.blockedInfo')}</p>
            <Button
              size="sm"
              onClick={() => {
                approveMutation.mutate();
              }}
              disabled={approveMutation.isPending}
            >
              {t('stations.unblock')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Tabs value={detailsTab} onValueChange={setDetailsTab}>
        <TabsList>
          <TabsTrigger value="info">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="images">{t('stations.images')}</TabsTrigger>
          <TabsTrigger value="metrics">{t('stations.metrics')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          <TabsTrigger value="connectors">{t('stations.connectors')}</TabsTrigger>
          <TabsTrigger value="commands">{t('stations.ocppCommands')}</TabsTrigger>
          {station.isSimulator && <TabsTrigger value="simulate">{t('simulate.tab')}</TabsTrigger>}
          <TabsTrigger value="security">{t('stations.security')}</TabsTrigger>
          {station.ocppProtocol === 'ocpp2.1' && (
            <TabsTrigger value="certificates">{t('pnc.certificates')}</TabsTrigger>
          )}
          {station.ocppProtocol !== 'ocpp1.6' && (
            <TabsTrigger value="messages">{t('stations.displayMessages')}</TabsTrigger>
          )}
          <TabsTrigger value="meter-values">{t('sessions.meterValuesTab')}</TabsTrigger>
          {station.ocppProtocol !== 'ocpp1.6' && (
            <TabsTrigger value="events">{t('stations.events')}</TabsTrigger>
          )}
          <TabsTrigger value="configurations">{t('stations.configurations')}</TabsTrigger>
          <TabsTrigger value="firmware-history">{t('stations.firmwareHistory')}</TabsTrigger>
          <TabsTrigger value="charging-profiles">{t('stations.chargingProfiles')}</TabsTrigger>
          <TabsTrigger value="qr">{t('stations.qrCodes')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('stations.pricing')}</TabsTrigger>
          <TabsTrigger value="local-auth">{t('stations.localAuthList')}</TabsTrigger>
          {reservationEnabled && (
            <TabsTrigger value="reservations">{t('reservations.title')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="info" className="space-y-6">
          <StationInfoTab station={station} stationId={id ?? ''} siteTimezone={siteTimezone} />
        </TabsContent>

        <TabsContent value="images">
          <StationImages stationId={id ?? ''} />
        </TabsContent>

        <TabsContent value="metrics" className="space-y-6">
          <StationMetricsTab stationId={id ?? ''} />
        </TabsContent>

        <TabsContent value="sessions">
          <StationSessionsTab stationId={id ?? ''} timezone={siteTimezone} />
        </TabsContent>

        <TabsContent value="connectors" className="space-y-6">
          {connectorsData != null && (
            <ConnectorStatus data={connectorsData} stationId={station.id} />
          )}
        </TabsContent>

        <TabsContent value="commands" className="space-y-6">
          <StationCommands stationId={station.stationId} ocppProtocol={station.ocppProtocol} />
          <OcppMessageLog stationDbId={station.id} timezone={siteTimezone} />
        </TabsContent>

        <TabsContent value="security">
          <StationSecurity
            stationId={station.stationId}
            stationDbId={station.id}
            securityProfile={station.securityProfile}
            hasPassword={station.hasPassword}
            isOnline={station.isOnline}
            timezone={siteTimezone}
            ocppProtocol={station.ocppProtocol}
          />
        </TabsContent>

        {station.ocppProtocol === 'ocpp2.1' && (
          <TabsContent value="certificates">
            <StationCertificates stationId={station.id} />
          </TabsContent>
        )}

        {station.ocppProtocol !== 'ocpp1.6' && (
          <TabsContent value="messages">
            <StationDisplayMessages
              stationId={station.id}
              isOnline={station.isOnline}
              timezone={siteTimezone}
            />
          </TabsContent>
        )}

        <TabsContent value="meter-values">
          <MeterValuesTable
            queryKey="station-meter-values"
            url={`/v1/stations/${station.id}/standalone-meter-values`}
            description={t('stations.meterValuesDescription')}
          />
        </TabsContent>

        <TabsContent value="events" className="space-y-6">
          <StationEventsTab stationId={station.id} timezone={siteTimezone} />
        </TabsContent>

        <TabsContent value="configurations" className="space-y-6">
          <StationConfigurationsTab
            stationId={station.id}
            isOnline={station.isOnline}
            ocppProtocol={station.ocppProtocol}
          />
        </TabsContent>

        <TabsContent value="firmware-history" className="space-y-6">
          <StationFirmwareTab stationId={station.id} timezone={siteTimezone} />
        </TabsContent>

        <TabsContent value="charging-profiles" className="space-y-6">
          <StationChargingProfilesTab
            stationId={station.id}
            timezone={siteTimezone}
            isOnline={station.isOnline}
            ocppProtocol={station.ocppProtocol}
          />
        </TabsContent>

        <TabsContent value="qr">
          <StationQrTab
            stationId={id ?? ''}
            stationOcppId={station.stationId}
            guestChargingEnabled={guestChargingEnabled}
          />
        </TabsContent>

        <TabsContent value="pricing" className="space-y-6">
          <StationPricingTab stationId={id ?? ''} />
        </TabsContent>

        <TabsContent value="local-auth">
          <StationLocalAuthList
            stationId={station.id}
            isOnline={station.isOnline}
            timezone={siteTimezone}
          />
        </TabsContent>

        {reservationEnabled && (
          <TabsContent value="reservations" className="space-y-6">
            <StationReservationsTab station={station} timezone={siteTimezone} />
          </TabsContent>
        )}

        {station.isSimulator && (
          <TabsContent value="simulate">
            <StationSimulate
              stationId={station.stationId}
              evseIds={connectorsData?.map((e) => e.evseId) ?? [1]}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
