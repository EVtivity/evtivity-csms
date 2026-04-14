// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ReservationDetailsTab } from '@/components/reservation/ReservationDetailsTab';
import { ReservationSessionTab } from '@/components/reservation/ReservationSessionTab';
import { ReservationCommandsTab } from '@/components/reservation/ReservationCommandsTab';
import { useTab } from '@/hooks/use-tab';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';
import { reservationStatusVariant } from '@/lib/status-variants';

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
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
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
  const { id } = useParams<{ id: string }>();

  const [tab, setTab] = useTab('details');

  const { data: reservation, isLoading } = useQuery({
    queryKey: ['reservations', id],
    queryFn: () => api.get<ReservationDetail>(`/v1/reservations/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (reservation == null) {
    return <p className="text-destructive">{t('reservations.notFound')}</p>;
  }

  const hasSession =
    reservation.sessionId != null &&
    (reservation.status === 'in_use' || reservation.status === 'used');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/reservations" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            {t('reservations.detail')} #{reservation.reservationId}
          </h1>
          <CopyableId id={reservation.id} />
        </div>
        <Badge variant={reservationStatusVariant(reservation.status)}>
          {getStatusLabel(reservation.status, t as (key: string) => string)}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('reservations.detailsTab')}</TabsTrigger>
          {hasSession && <TabsTrigger value="session">{t('reservations.sessionTab')}</TabsTrigger>}
          <TabsTrigger value="commands">{t('reservations.commands')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <ReservationDetailsTab reservation={reservation} timezone={timezone} />
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

        <TabsContent value="commands">
          <ReservationCommandsTab reservationId={id ?? ''} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
