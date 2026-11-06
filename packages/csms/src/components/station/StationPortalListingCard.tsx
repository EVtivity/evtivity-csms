// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

export interface StationPortalListingCardProps {
  stationId: string;
  portalListed: boolean;
}

/**
 * Station detail > QR codes: whether the driver portal lists the station in
 * its search, map and location pages. An unlisted station stays reachable by
 * its QR code, a link or a driver's favorite, RFID and app starts still work,
 * and roaming partners still see it while its site is published to them.
 */
export function StationPortalListingCard({
  stationId,
  portalListed,
}: StationPortalListingCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');

  const mutation = useMutation({
    mutationFn: (listed: boolean) =>
      api.patch(`/v1/stations/${stationId}`, { portalListed: listed }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId] });
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  return (
    <TabPanel title={t('stations.portalListing.title')}>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label>{t('stations.portalListing.label')}</Label>
          <p className="text-xs text-muted-foreground">{t('stations.portalListing.help')}</p>
        </div>
        <Toggle
          aria-label={t('stations.portalListing.label')}
          size="lg"
          checked={portalListed}
          onCheckedChange={() => {
            mutation.mutate(!portalListed);
          }}
          disabled={!canWrite || mutation.isPending}
        />
      </div>
      {mutation.isError && (
        <p className="mt-2 text-sm text-destructive">{getErrorMessage(mutation.error, t)}</p>
      )}
    </TabPanel>
  );
}
