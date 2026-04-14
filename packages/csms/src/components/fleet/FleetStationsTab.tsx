// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { AddButton } from '@/components/add-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StationsTable } from '@/components/StationsTable';
import type { Station } from '@/components/StationsTable';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

interface FleetStationsTabProps {
  fleetId: string;
}

export function FleetStationsTab({ fleetId }: FleetStationsTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [removeStationId, setRemoveStationId] = useState<string | null>(null);

  const { data: stations } = useQuery({
    queryKey: ['fleets', fleetId, 'stations'],
    queryFn: () => api.get<Station[]>(`/v1/fleets/${fleetId}/stations`),
  });

  const removeStationMutation = useMutation({
    mutationFn: (stationId: string) => api.delete(`/v1/fleets/${fleetId}/stations/${stationId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'stations'] });
    },
  });

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('fleets.stations')}</CardTitle>
          <AddButton
            label={t('fleets.addStation')}
            onClick={() => {
              void navigate(`/fleets/${fleetId}/stations/add`);
            }}
          />
        </CardHeader>
        <CardContent>
          <StationsTable
            stations={stations}
            timezone={timezone}
            emptyMessage={t('fleets.noStations')}
            onRemove={(station) => {
              setRemoveStationId(station.id);
            }}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeStationId != null}
        onOpenChange={(open) => {
          if (!open) setRemoveStationId(null);
        }}
        title={t('fleets.removeStation')}
        description={t('fleets.confirmRemoveStation')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={removeStationMutation.isPending}
        onConfirm={() => {
          if (removeStationId != null) {
            removeStationMutation.mutate(removeStationId);
            setRemoveStationId(null);
          }
        }}
      />
    </>
  );
}
