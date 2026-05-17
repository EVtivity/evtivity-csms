// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, OctagonX } from 'lucide-react';
import { AbortButton } from '@/components/abort-button';
import { BackButton } from '@/components/back-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface CampaignStation {
  id: number;
  stationId: string;
  stationName: string;
  status: string;
  errorInfo: string | null;
  updatedAt: string;
}

interface CampaignProgressData {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stations: CampaignStation[];
  stationsTotal: number;
  installedCount: number;
  failedCount: number;
}

const STATION_STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  pending: 'outline',
  downloading: 'warning',
  downloaded: 'default',
  installing: 'warning',
  installed: 'success',
  failed: 'destructive',
};

export function FirmwareCampaignProgressDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const campaignId = id ?? '';
  const [page, setPage] = useState(1);
  const [cancelOpen, setCancelOpen] = useState(false);
  const limit = 10;

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/v1/firmware-campaigns/${campaignId}/cancel`, {}),
    onSuccess: () => {
      // Invalidate by parent key so the campaigns list (queryKey
      // ['firmware-campaigns', page]) also refetches. The cancel route does
      // not publish an SSE event, so without this the list view shows the
      // stale 'active' status until manual refresh.
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns'] });
      setCancelOpen(false);
    },
  });

  // No refetchInterval: SSE invalidates this query when stations report status.
  const { data: campaign, isLoading } = useQuery({
    queryKey: ['firmware-campaigns', campaignId, 'progress', page],
    queryFn: () =>
      api.get<CampaignProgressData>(
        `/v1/firmware-campaigns/${campaignId}?page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: campaignId !== '',
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (campaign == null) {
    return <p className="text-destructive">{t('firmwareCampaigns.notFound')}</p>;
  }

  const stations = campaign.stations;
  const totalStations = campaign.stationsTotal;
  const installedCount = campaign.installedCount;
  const failedCount = campaign.failedCount;
  const completedStations = installedCount + failedCount;
  const totalPages = Math.ceil(totalStations / limit);
  const pct = totalStations > 0 ? (completedStations / totalStations) * 100 : 0;

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton forceTo={`/firmware-campaigns/${campaignId}?tab=history`} />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('firmwareCampaigns.progress')}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(campaign.updatedAt, timezone)}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('firmwareCampaigns.progress')}</CardTitle>
        </CardHeader>
        <CardContent>
          {campaign.status === 'active' && (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-warning/50 bg-warning/10 p-4">
              <div className="flex items-center gap-3 text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <p className="text-sm">{t('firmwareCampaigns.cancelWarning')}</p>
              </div>
              <div className="shrink-0">
                <AbortButton
                  onClick={() => {
                    setCancelOpen(true);
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex gap-6 mb-4 text-sm">
            <div>
              <span className="text-muted-foreground">
                {t('firmwareCampaigns.totalStations')}:{' '}
              </span>
              <span className="font-medium">{totalStations}</span>
            </div>
            <div>
              <span className="text-muted-foreground">
                {t('firmwareCampaigns.completedStations')}:{' '}
              </span>
              <span className="font-medium">{completedStations}</span>
            </div>
            {failedCount > 0 && (
              <div>
                <span className="text-muted-foreground">
                  {t('firmwareCampaigns.failedStations')}:{' '}
                </span>
                <span className="font-medium text-destructive">{failedCount}</span>
              </div>
            )}
          </div>

          {totalStations > 0 && (
            <div className="w-full bg-muted rounded-full h-2 mb-4">
              <div
                className="bg-primary rounded-full h-2 transition-all"
                style={{ width: `${String(pct)}%` }}
              />
            </div>
          )}

          {stations.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('firmwareCampaigns.noStationsTargeted')}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('nav.stations')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('firmwareCampaigns.error')}</TableHead>
                      <TableHead>{t('common.lastUpdated')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stations.map((station) => (
                      <TableRow key={station.id}>
                        <TableCell className="font-medium">{station.stationName}</TableCell>
                        <TableCell>
                          <Badge variant={STATION_STATUS_VARIANT[station.status] ?? 'outline'}>
                            {station.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{station.errorInfo ?? 'n/a'}</TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(station.updatedAt, timezone)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('firmwareCampaigns.confirmCancel')}
        description={t('firmwareCampaigns.confirmCancelDescription')}
        confirmLabel={t('common.abort')}
        confirmIcon={<OctagonX className="h-4 w-4" />}
        variant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          cancelMutation.mutate();
        }}
      />
    </div>
  );
}
