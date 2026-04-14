// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface FirmwareUpdate {
  id: number;
  requestId: number | null;
  firmwareUrl: string;
  status: string | null;
  initiatedAt: string;
  lastStatusAt: string | null;
}

interface Props {
  stationId: string;
  timezone: string;
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'destructive' | 'warning' | 'success' | 'outline'
> = {
  Installed: 'success',
  Downloaded: 'default',
  Downloading: 'warning',
  DownloadFailed: 'destructive',
  InstallationFailed: 'destructive',
  InvalidSignature: 'destructive',
  InstallVerificationFailed: 'destructive',
  Installing: 'warning',
};

export function StationFirmwareTab({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['stations', stationId, 'firmware-history', page],
    queryFn: () =>
      api.get<{ data: FirmwareUpdate[]; total: number }>(
        `/v1/stations/${stationId}/firmware-history?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stations.firmwareHistory')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data == null || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noFirmwareUpdates')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>URL</TableHead>
                    <TableHead>{t('common.initiated')}</TableHead>
                    <TableHead>{t('common.lastUpdate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((fw) => (
                    <TableRow key={fw.id}>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[fw.status ?? ''] ?? 'outline'}>
                          {fw.status ?? '--'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-xs truncate">{fw.firmwareUrl}</TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(fw.initiatedAt, timezone)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fw.lastStatusAt != null ? formatDateTime(fw.lastStatusAt, timezone) : '--'}
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
  );
}
