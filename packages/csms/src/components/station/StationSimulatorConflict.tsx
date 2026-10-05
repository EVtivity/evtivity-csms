// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';

interface StationSimulatorConflictProps {
  stationDbId: string;
  stationId: string;
  conflictAt: string;
  timezone: string;
}

/**
 * A connection that did not come from the simulator reached a
 * simulator-flagged station, and the CSMS could not settle it on its own
 * (security profile 0, or a simulator that never sent its marker). The
 * operator confirms a real station, which clears the flag and stops the
 * simulator from connecting as this station.
 */
export function StationSimulatorConflict({
  stationDbId,
  stationId,
  conflictAt,
  timezone,
}: StationSimulatorConflictProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWriteStations = useHasPermission('stations:write');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const confirmMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationDbId}/confirm-real-station`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      toast({ variant: 'success', title: t('stations.confirmRealStationSuccess') });
      setConfirmOpen(false);
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  return (
    <>
      <Card className="border-warning">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            {t('stations.simulatorConflict', { time: formatDateTime(conflictAt, timezone) })}
          </p>
          {canWriteStations && (
            <Button
              size="sm"
              className="sm:shrink-0"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              {t('stations.confirmRealStation')}
            </Button>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('stations.confirmRealStationTitle')}
        description={t('stations.confirmRealStationDescription', { stationId })}
        confirmLabel={t('stations.confirmRealStation')}
        isPending={confirmMutation.isPending}
        onConfirm={() => {
          confirmMutation.mutate();
          return false;
        }}
      />
    </>
  );
}
