// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router';
import { useTab } from '@/hooks/use-tab';
import { stationAvailabilityActions } from '@/lib/station-availability-actions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { ConnectorStatus } from '@/components/charts/ConnectorStatus';
import { StationCommands } from '@/components/StationCommands';
import { OcppMessageLog } from '@/components/OcppMessageLog';
import { StationSecurity } from '@/components/StationSecurity';
import { StationDisplayMessages } from '@/components/StationDisplayMessages';
import { StationCertificates } from '@/components/StationCertificates';
import { StationLocalAuthList } from '@/components/StationLocalAuthList';
import { AuthorizeLogView } from '@/components/AuthorizeLogView';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { RecordInsight } from '@/components/ai/insights/RecordInsight';
import { RecordInsightsTab } from '@/components/ai/insights/RecordInsightsTab';
import { MeterValuesTable } from '@/components/MeterValuesTable';
import { StationEventsTab } from '@/components/StationEventsTab';
import { StationConfigurationsTab } from '@/components/StationConfigurationsTab';
import { StationFirmwareTab } from '@/components/StationFirmwareTab';
import { StationChargingProfilesTab } from '@/components/StationChargingProfilesTab';
import { StationImages } from '@/components/StationImages';
import { StationSimulate } from '@/components/StationSimulate';
import { StationInfoTab } from '@/components/station/StationInfoTab';
import { StationConnectivityTab } from '@/components/station/StationConnectivityTab';
import { StationMetricsTab } from '@/components/station/StationMetricsTab';
import { StationSessionsTab } from '@/components/station/StationSessionsTab';
import { StationQrTab } from '@/components/station/StationQrTab';
import { StationPricingTab } from '@/components/station/StationPricingTab';
import { StationReservationsTab } from '@/components/station/StationReservationsTab';
import { StationSimulatorConflict } from '@/components/station/StationSimulatorConflict';
import { api } from '@/lib/api';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DisableButton } from '@/components/disable-button';
import { EnableButton } from '@/components/enable-button';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationChargingNeedsTab } from '@/components/StationChargingNeedsTab';
import { useHasPermission } from '@/lib/auth';
import { LoadingLogo } from '@/components/loading-logo';
import { isOcpp2x } from '@evtivity/lib/ocpp-version';

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
  statusReason: string | null;
  disabledReason: string | null;
  firmwareState: string | null;
  reportedStatus: string | null;
  isOnline: boolean;
  isSimulator: boolean;
  simulatorConflictAt: string | null;
  lastHeartbeat: string | null;
  ocppProtocol: string | null;
  securityProfile: number;
  pendingSecurityProfile: number | null;
  hasPassword: boolean;
  latitude: string | null;
  longitude: string | null;
  reservationsEnabled: boolean;
  siteHoursOfOperation: string | null;
  siteTimezone: string | null;
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
  const canReadAuthorizeLog = useHasPermission('drivers:read');
  const canReadAudit = useHasPermission('audit:read');
  const canWriteStations = useHasPermission('stations:write');
  const { toast } = useToast();
  const [availabilityConfirm, setAvailabilityConfirm] = useState<
    'available' | 'unavailable' | null
  >(null);
  const [rejectConfirmOpen, setRejectConfirmOpen] = useState(false);

  const {
    flags: {
      guestChargingEnabled,
      reservationEnabled,
      aiInsightsEnabled,
      simEnabled,
      simStationSignalEnabled,
    },
  } = useFeatureFlags();
  const showInsightsTab = useHasPermission('aiInsights:read') && aiInsightsEnabled;

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

  // Approve, reject and unblock: a refused change (another operator acted
  // first) is shown, and the station reloads either way.
  function onboardingMutationOptions(
    successKey:
      | 'stations.approvedSuccess'
      | 'stations.rejectedSuccess'
      | 'stations.unblockedSuccess',
  ) {
    return {
      onSuccess: () => {
        toast({ variant: 'success', title: t(successKey) });
      },
      onError: (err: unknown) => {
        toast({ variant: 'destructive', title: getErrorMessage(err, t) });
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: ['stations'] });
      },
    };
  }

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${id ?? ''}/approve`, {}),
    ...onboardingMutationOptions('stations.approvedSuccess'),
  });

  const rejectMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${id ?? ''}/reject`, {}),
    ...onboardingMutationOptions('stations.rejectedSuccess'),
  });

  const availabilityMutation = useMutation({
    mutationFn: (availability: 'available' | 'unavailable') =>
      api.patch(`/v1/stations/${id ?? ''}`, { availability }),
    onSuccess: (_data, availability) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      toast({
        variant: 'success',
        title: t(
          availability === 'unavailable' ? 'stations.disabledSuccess' : 'stations.enabledSuccess',
        ),
      });
      setAvailabilityConfirm(null);
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const unblockMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${id ?? ''}/unblock`, {}),
    ...onboardingMutationOptions('stations.unblockedSuccess'),
  });

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (station == null) {
    return <p className="text-destructive">{t('stations.stationNotFound')}</p>;
  }

  const siteTimezone = station.siteTimezone ?? 'America/New_York';
  const availabilityActions = stationAvailabilityActions(station);
  const explainContext = { kind: 'station' as const, id: station.id, label: station.stationId };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <BackButton to="/stations" />
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{station.stationId}</h1>
            <CopyableId id={station.id} />
          </div>
          <Badge variant={station.isOnline ? 'success' : 'destructive'}>
            {station.isOnline ? t('status.online') : t('status.offline')}
          </Badge>
          <StationStatusBadge status={station.status} statusReason={station.statusReason} />
          {station.isSimulator && <Badge variant="info">{t('stations.simulator')}</Badge>}
          {station.siteFreeVendEnabled && <Badge variant="info">{t('stations.freeVend')}</Badge>}
          {station.onboardingStatus === 'pending' && (
            <Badge variant="warning">{t('status.pending')}</Badge>
          )}
          {station.onboardingStatus === 'blocked' && (
            <Badge variant="destructive">{t('status.blocked')}</Badge>
          )}
        </div>
        {/* items-start: the buttons line up with the Prev and Next buttons, not their labels. */}
        <div className="flex flex-wrap items-start gap-2" data-testid="station-header-actions">
          {(!station.isOnline || station.status === 'faulted') && (
            <ExplainButton context={explainContext} size="header" />
          )}
          {canWriteStations && availabilityActions.enable && (
            <EnableButton
              label={t('stations.enableStation')}
              size="header"
              onClick={() => {
                setAvailabilityConfirm('available');
              }}
            />
          )}
          {canWriteStations && availabilityActions.disable && (
            <DisableButton
              label={t('stations.disableStation')}
              size="header"
              onClick={() => {
                setAvailabilityConfirm('unavailable');
              }}
            />
          )}
          <EntityNavButtons resource="stations" basePath="/stations" currentId={id} />
        </div>
      </div>

      <ConfirmDialog
        open={availabilityConfirm != null}
        onOpenChange={(open) => {
          if (!open) setAvailabilityConfirm(null);
        }}
        title={
          availabilityConfirm === 'available'
            ? t('stations.enableStationTitle')
            : t('stations.disableStationTitle')
        }
        description={
          availabilityConfirm === 'available'
            ? t('stations.enableStationDescription')
            : t('stations.disableStationDescription')
        }
        confirmLabel={
          availabilityConfirm === 'available'
            ? t('stations.enableStation')
            : t('stations.disableStation')
        }
        variant={availabilityConfirm === 'available' ? 'default' : 'destructive'}
        isPending={availabilityMutation.isPending}
        onConfirm={() => {
          if (availabilityConfirm != null) availabilityMutation.mutate(availabilityConfirm);
          return false;
        }}
      />

      <ConfirmDialog
        open={rejectConfirmOpen}
        onOpenChange={setRejectConfirmOpen}
        title={t('stations.rejectStationTitle')}
        description={t('stations.rejectStationDescription')}
        confirmLabel={t('stations.reject')}
        variant="destructive"
        isPending={rejectMutation.isPending}
        onConfirm={() => {
          rejectMutation.mutate(undefined, {
            onSettled: () => {
              setRejectConfirmOpen(false);
            },
          });
          return false;
        }}
      />

      {station.isSimulator && station.simulatorConflictAt != null && (
        <StationSimulatorConflict
          stationDbId={station.id}
          stationId={station.stationId}
          conflictAt={station.simulatorConflictAt}
          timezone={siteTimezone}
        />
      )}

      {station.onboardingStatus === 'pending' && (
        <Card className="border-warning">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">{t('stations.pendingApproval')}</p>
            {canWriteStations && (
              <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex sm:shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRejectConfirmOpen(true);
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
            )}
          </CardContent>
        </Card>
      )}
      {station.onboardingStatus === 'blocked' && (
        <Card className="border-destructive">
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-sm">{t('stations.blockedInfo')}</p>
            {canWriteStations && (
              <Button
                size="sm"
                onClick={() => {
                  unblockMutation.mutate();
                }}
                disabled={unblockMutation.isPending}
              >
                {t('stations.unblock')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {showInsightsTab && (
        <RecordInsight
          filter={{ stationId: station.id }}
          onOpen={() => {
            setDetailsTab('ai-insights');
          }}
        />
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
          {simEnabled && <TabsTrigger value="connectivity">{t('stations.sim.tab')}</TabsTrigger>}
          {isOcpp2x(station.ocppProtocol) && (
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
          <TabsTrigger value="firmware-history">{t('stations.firmwareUpdates')}</TabsTrigger>
          <TabsTrigger value="charging-profiles">{t('stations.chargingProfiles')}</TabsTrigger>
          {station.ocppProtocol !== 'ocpp1.6' && (
            <TabsTrigger value="charging-needs">{t('stations.chargingNeedsTab')}</TabsTrigger>
          )}
          <TabsTrigger value="qr">{t('stations.qrCodes')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('stations.pricing')}</TabsTrigger>
          <TabsTrigger value="local-auth">{t('stations.localAuthList')}</TabsTrigger>
          {canReadAuthorizeLog && (
            <TabsTrigger value="authorize-log">{t('tokens.authorizeLog')}</TabsTrigger>
          )}
          {reservationEnabled && (
            <TabsTrigger value="reservations">{t('reservations.title')}</TabsTrigger>
          )}
          {showInsightsTab && (
            <TabsTrigger value="ai-insights">{t('aiInsights.list.title')}</TabsTrigger>
          )}
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="info" className="space-y-6">
          <StationInfoTab
            station={station}
            stationId={id ?? ''}
            siteTimezone={siteTimezone}
            simEnabled={simEnabled}
          />
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
            <ConnectorStatus
              data={connectorsData}
              stationId={station.id}
              stationOcppId={station.stationId}
              ocppProtocol={station.ocppProtocol}
              isOnline={station.isOnline}
              isSimulator={station.isSimulator}
            />
          )}
        </TabsContent>

        <TabsContent value="commands" className="space-y-6">
          <StationCommands stationId={station.stationId} ocppProtocol={station.ocppProtocol} />
          <OcppMessageLog stationDbId={station.id} timezone={siteTimezone} />
        </TabsContent>

        {simEnabled && (
          <TabsContent value="connectivity">
            <StationConnectivityTab
              stationId={id ?? ''}
              iccid={station.iccid}
              timezone={siteTimezone}
              stationSignalEnabled={simStationSignalEnabled}
            />
          </TabsContent>
        )}

        <TabsContent value="security">
          <StationSecurity
            stationId={station.stationId}
            stationDbId={station.id}
            securityProfile={station.securityProfile}
            pendingSecurityProfile={station.pendingSecurityProfile}
            hasPassword={station.hasPassword}
            isOnline={station.isOnline}
            timezone={siteTimezone}
            ocppProtocol={station.ocppProtocol}
          />
        </TabsContent>

        {isOcpp2x(station.ocppProtocol) && (
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
              ocppProtocol={station.ocppProtocol}
            />
          </TabsContent>
        )}

        <TabsContent value="meter-values">
          <MeterValuesTable
            queryKey={['stations', station.id, 'meter-values']}
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
            stationOcppId={station.stationId}
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

        {station.ocppProtocol !== 'ocpp1.6' && (
          <TabsContent value="charging-needs" className="space-y-6">
            <StationChargingNeedsTab
              stationId={station.id}
              isOnline={station.isOnline}
              timezone={siteTimezone}
              ocppProtocol={station.ocppProtocol}
            />
          </TabsContent>
        )}

        <TabsContent value="qr">
          <StationQrTab
            stationId={id ?? ''}
            stationOcppId={station.stationId}
            guestChargingEnabled={guestChargingEnabled}
            ocppProtocol={station.ocppProtocol}
            isOnline={station.isOnline}
          />
        </TabsContent>

        <TabsContent value="pricing" className="space-y-6">
          <StationPricingTab
            stationId={id ?? ''}
            siteTimezone={station.siteTimezone ?? undefined}
          />
        </TabsContent>

        <TabsContent value="local-auth">
          <StationLocalAuthList
            stationId={station.id}
            isOnline={station.isOnline}
            timezone={siteTimezone}
          />
        </TabsContent>

        {canReadAuthorizeLog && (
          <TabsContent value="authorize-log">
            <AuthorizeLogView
              fixedFilters={{ stationId: station.stationId }}
              hideStationColumn
              queryKey={`authorize-attempts-station-${station.id}`}
            />
          </TabsContent>
        )}

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
              evses={connectorsData}
              isOnline={station.isOnline}
            />
          </TabsContent>
        )}

        {showInsightsTab && (
          <TabsContent value="ai-insights">
            <RecordInsightsTab filter={{ stationId: station.id }} />
          </TabsContent>
        )}
        <TabsContent value="history">
          <EntityHistoryTab entityType="station" entityId={station.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
