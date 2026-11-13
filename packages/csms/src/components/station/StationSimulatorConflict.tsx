// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
      <Alert variant="warning" className="flex-col items-stretch sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <AlertDescription>
            {t('stations.simulatorConflict', { time: formatDateTime(conflictAt, timezone) })}
          </AlertDescription>
        </div>
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
      </Alert>
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
