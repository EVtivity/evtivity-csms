// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ReservationDetailsTab } from '@/components/reservation/ReservationDetailsTab';
import {
  ReservationFeePayments,
  useReservationFeePayments,
} from '@/components/reservation/ReservationFeePayments';
import { reservationExplainable } from '@/components/reservation/reservation-explain';
import { ReservationSessionTab } from '@/components/reservation/ReservationSessionTab';
import { ReservationCommandsTab } from '@/components/reservation/ReservationCommandsTab';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { ExplainButton } from '@/components/ai/ExplainButton';
import { RecordInsight } from '@/components/ai/insights/RecordInsight';
import { RecordInsightsTab } from '@/components/ai/insights/RecordInsightsTab';
import { useInsights } from '@/components/ai/insights/insight-api';
import { useTab } from '@/hooks/use-tab';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { api } from '@/lib/api';
import type { ReservationCancellationFee } from '@/lib/reservation-fee';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';
import { reservationStatusVariant } from '@/lib/status-variants';
import { LoadingLogo } from '@/components/loading-logo';

interface ReservationDetail {
  id: string;
  reservationId: number;
  stationId: string;
  stationOcppId: string;
  siteId: string | null;
  siteName: string | null;
  evseId: string | null;
  evseOcppId: number | null;
  connectorType: string | null;
  connectorMaxPowerKw: string | null;
  driverId: string | null;
  driverFirstName: string | null;
  driverLastName: string | null;
  tokenId: string | null;
  tokenIdToken: string | null;
  tokenType: string | null;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancelNote: string | null;
  cancellationFeeCents: number;
  /** The fee cancelling now would charge, tax included; null when not open or no fee. */
  cancellationFee: ReservationCancellationFee | null;
  sessionId: string | null;
  sessionStatus: string | null;
  sessionEnergyWh: string | null;
  sessionCostCents: number | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
}

function getStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'active':
      return t('reservations.active');
    case 'scheduled':
      return t('reservations.scheduled');
    case 'in_use':
      return t('reservations.in_use');
    case 'used':
      return t('reservations.used');
    case 'cancelled':
      return t('reservations.cancelled');
    case 'expired':
      return t('reservations.expired');
    default:
      return status;
  }
}

export function ReservationDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canReadAudit = useHasPermission('audit:read');
  const { id } = useParams<{ id: string }>();

  const [tab, setTab] = useTab('details');

  const { data: reservation, isLoading } = useQuery({
    queryKey: ['reservations', id],
    queryFn: () => api.get<ReservationDetail>(`/v1/reservations/${id ?? ''}`),
    enabled: id != null,
  });
  // The same queries the fee list and the insight card read (cached once).
  const feePayments = useReservationFeePayments(id ?? '');
  // Reservation insights and Explain exist only while reservations are on (owner rule v0.1.45).
  const { flags, isLoaded: flagsLoaded } = useFeatureFlags();
  const aiOn = id != null && flagsLoaded && flags.reservationEnabled;
  const canReadInsights = useHasPermission('aiInsights:read');
  const showInsightsTab = aiOn && canReadInsights && flags.aiInsightsEnabled;
  const { insights } = useInsights({ reservationId: id ?? '' }, aiOn);

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (reservation == null) {
    return <p className="text-destructive">{t('reservations.notFound')}</p>;
  }

  const hasSession =
    reservation.sessionId != null &&
    (reservation.status === 'in_use' || reservation.status === 'used');
  const explainContext = {
    kind: 'reservation' as const,
    id: reservation.id,
    label: `#${String(reservation.reservationId)}`,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/reservations" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">
            {t('reservations.detail')} #{reservation.reservationId}
          </h1>
          <CopyableId id={reservation.id} />
        </div>
        <Badge variant={reservationStatusVariant(reservation.status)}>
          {getStatusLabel(reservation.status, t as (key: string) => string)}
        </Badge>
        {aiOn && reservationExplainable(reservation, feePayments, insights) && (
          <ExplainButton context={explainContext} />
        )}
        <EntityNavButtons resource="reservations" basePath="/reservations" currentId={id} />
      </div>

      {showInsightsTab && (
        <RecordInsight
          filter={{ reservationId: id }}
          onOpen={() => {
            setTab('ai-insights');
          }}
        />
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('reservations.detailsTab')}</TabsTrigger>
          {hasSession && <TabsTrigger value="session">{t('reservations.sessionTab')}</TabsTrigger>}
          {canReadAudit && (
            <TabsTrigger value="history">{t('reservations.historyTab')}</TabsTrigger>
          )}
          <TabsTrigger value="commands">{t('reservations.commands')}</TabsTrigger>
          {showInsightsTab && (
            <TabsTrigger value="ai-insights">{t('aiInsights.list.title')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <ReservationDetailsTab reservation={reservation} timezone={timezone} />
          <ReservationFeePayments reservationId={reservation.id} timezone={timezone} />
        </TabsContent>

        {hasSession && (
          <TabsContent value="session">
            <ReservationSessionTab
              sessionId={reservation.sessionId ?? ''}
              sessionStatus={reservation.sessionStatus}
              sessionEnergyWh={reservation.sessionEnergyWh}
              sessionCostCents={reservation.sessionCostCents}
              sessionStartedAt={reservation.sessionStartedAt}
              sessionEndedAt={reservation.sessionEndedAt}
            />
          </TabsContent>
        )}

        {showInsightsTab && (
          <TabsContent value="ai-insights">
            <RecordInsightsTab filter={{ reservationId: id }} />
          </TabsContent>
        )}
        <TabsContent value="history">
          <EntityHistoryTab entityType="reservation" entityId={id ?? ''} />
        </TabsContent>

        <TabsContent value="commands">
          <ReservationCommandsTab reservationId={id ?? ''} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
