// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';

interface PushStation {
  id: number;
  stationId: string;
  stationName: string;
  status: string;
  errorInfo: string | null;
  updatedAt: string;
}

interface PushDetail {
  id: string;
  templateId: string;
  status: string;
  stationCount: number;
  acceptedCount: number;
  rejectedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
  stations: PushStation[];
  stationsTotal: number;
}

const STATION_STATUS_VARIANT: Record<string, 'outline' | 'success' | 'warning' | 'destructive'> = {
  pending: 'outline',
  accepted: 'success',
  rejected: 'warning',
  failed: 'destructive',
};

export function ConfigTemplatePushDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { pushId } = useParams<{ pushId: string }>();
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data: push, isLoading } = useQuery({
    queryKey: ['config-template-pushes', pushId, page],
    queryFn: () =>
      api.get<PushDetail>(
        `/v1/config-template-pushes/${pushId ?? ''}?page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: pushId != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data == null) return 3000;
      if (data.status === 'active') return 3000;
      // Still has pending stations, keep polling
      if (data.pendingCount > 0) return 3000;
      return false;
    },
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (push == null) {
    return <p className="text-destructive">{t('configTemplates.notFound')}</p>;
  }

  const stations = push.stations;
  const total = push.stationCount;
  const accepted = push.acceptedCount;
  const rejected = push.rejectedCount;
  const failed = push.failedCount;
  const processed = accepted + rejected + failed;
  const pct = total > 0 ? (processed / total) * 100 : 0;
  const totalPages = Math.ceil(push.stationsTotal / limit);

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to={`/station-configurations/${push.templateId}`} />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('configTemplates.pushProgress')}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(push.createdAt, timezone)}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('configTemplates.pushProgress')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-6 mb-4 text-sm">
            <div>
              <span className="text-muted-foreground">
                {t('firmwareCampaigns.totalStations')}:{' '}
              </span>
              <span className="font-medium">{total}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('configTemplates.accepted')}: </span>
              <span className="font-medium">{accepted}</span>
            </div>
            {rejected > 0 && (
              <div>
                <span className="text-muted-foreground">{t('configTemplates.rejected')}: </span>
                <span className="font-medium text-warning">{rejected}</span>
              </div>
            )}
            {failed > 0 && (
              <div>
                <span className="text-muted-foreground">{t('configTemplates.failed')}: </span>
                <span className="font-medium text-destructive">{failed}</span>
              </div>
            )}
          </div>

          {total > 0 && (
            <div className="w-full bg-muted rounded-full h-2 mb-4">
              <div
                className="bg-primary rounded-full h-2 transition-all"
                style={{ width: `${String(pct)}%` }}
              />
            </div>
          )}

          {stations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('configTemplates.noPushes')}</p>
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
                        <TableCell className="text-xs">{station.errorInfo ?? '--'}</TableCell>
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
    </div>
  );
}
