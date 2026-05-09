// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';

interface MatchingStation {
  id: string;
  stationId: string;
  model: string | null;
  firmwareVersion?: string | null;
  isOnline?: boolean;
  siteName: string | null;
  vendorName: string | null;
}

interface MatchingStationsCardProps {
  endpoint: string;
  queryKey: string[];
  showFirmwareVersion?: boolean;
}

type StatusFilter = 'all' | 'online' | 'offline';

export function MatchingStationsCard({
  endpoint,
  queryKey,
  showFirmwareVersion = false,
}: MatchingStationsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const limit = 10;

  const { data: matchingStations } = useQuery({
    queryKey: [...queryKey, page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return api.get<{ data: MatchingStation[]; total: number }>(
        `${endpoint}?${params.toString()}`,
      );
    },
  });

  const total = matchingStations?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  function changeFilter(next: StatusFilter): void {
    setStatusFilter(next);
    setPage(1);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-end">
          <Select
            aria-label={t('common.status')}
            className="h-9 w-auto"
            value={statusFilter}
            onChange={(e) => {
              changeFilter(e.target.value as StatusFilter);
            }}
          >
            <option value="all">{t('common.all')}</option>
            <option value="online">{t('status.online')}</option>
            <option value="offline">{t('status.offline')}</option>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('firmwareCampaigns.noMatchingStations')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('nav.stations')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.site')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.vendor')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.model')}</TableHead>
                    {showFirmwareVersion && (
                      <TableHead>{t('firmwareCampaigns.currentFirmware')}</TableHead>
                    )}
                    <TableHead>{t('common.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matchingStations?.data.map((station) => (
                    <TableRow key={station.id}>
                      <TableCell className="font-medium">{station.stationId}</TableCell>
                      <TableCell>{station.siteName ?? '--'}</TableCell>
                      <TableCell>{station.vendorName ?? '--'}</TableCell>
                      <TableCell>{station.model ?? '--'}</TableCell>
                      {showFirmwareVersion && (
                        <TableCell className="text-xs">{station.firmwareVersion ?? '--'}</TableCell>
                      )}
                      <TableCell>
                        <Badge variant={station.isOnline ? 'success' : 'destructive'}>
                          {station.isOnline ? t('status.online') : t('status.offline')}
                        </Badge>
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
