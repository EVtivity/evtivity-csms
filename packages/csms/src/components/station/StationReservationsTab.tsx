// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { Card, CardContent } from '@/components/ui/card';
import { ReservationsTable } from '@/components/ReservationsTable';
import { api } from '@/lib/api';

interface Station {
  id: string;
  stationId: string;
  reservationsEnabled: boolean;
}

export interface StationReservationsTabProps {
  station: Station;
  timezone: string;
}

export function StationReservationsTab({
  station,
  timezone,
}: StationReservationsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const reservationToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch(`/v1/stations/${station.id}`, { reservationsEnabled: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', station.id] });
    },
  });

  return (
    <>
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="grid gap-1">
              <Label>{t('stations.reservationsEnabled')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('stations.reservationsEnabledHelp')}
              </p>
            </div>
            <Toggle
              aria-label={t('stations.reservationsEnabled')}
              size="lg"
              checked={station.reservationsEnabled}
              onCheckedChange={() => {
                reservationToggleMutation.mutate(!station.reservationsEnabled);
              }}
              disabled={reservationToggleMutation.isPending}
            />
          </div>
        </CardContent>
      </Card>
      <ReservationsTable stationId={station.id} timezone={timezone} hideStationName />
    </>
  );
}
