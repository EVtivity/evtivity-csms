// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
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
            <button
              type="button"
              role="switch"
              aria-checked={station.reservationsEnabled}
              onClick={() => {
                reservationToggleMutation.mutate(!station.reservationsEnabled);
              }}
              disabled={reservationToggleMutation.isPending}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${station.reservationsEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${station.reservationsEnabled ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </button>
          </div>
        </CardContent>
      </Card>
      <ReservationsTable stationId={station.id} timezone={timezone} hideStationName />
    </>
  );
}
