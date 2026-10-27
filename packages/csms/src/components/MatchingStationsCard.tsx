// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
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
  /** The card title: the tab label when the card is a detail page tab. */
  title?: string;
}

type StatusFilter = 'all' | 'online' | 'offline';

export function MatchingStationsCard({
  endpoint,
  queryKey,
  showFirmwareVersion = false,
  title,
}: MatchingStationsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const limit = 10;

  const {
    data: matchingStations,
    isLoading,
    isError,
    refetch,
  } = useQuery({
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
    <TabPanel
      {...(title != null ? { title } : {})}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      isEmpty={total === 0}
      emptyMessage={t('firmwareCampaigns.noMatchingStations')}
      actionsPosition="inline"
      actions={
        <Select
          aria-label={t('common.status')}
          className="w-auto"
          value={statusFilter}
          onChange={(e) => {
            changeFilter(e.target.value as StatusFilter);
          }}
        >
          <option value="all">{t('common.all')}</option>
          <option value="online">{t('status.online')}</option>
          <option value="offline">{t('status.offline')}</option>
        </Select>
      }
    >
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
                  <TableCell>{station.siteName ?? 'n/a'}</TableCell>
                  <TableCell>{station.vendorName ?? 'n/a'}</TableCell>
                  <TableCell>{station.model ?? 'n/a'}</TableCell>
                  {showFirmwareVersion && (
                    <TableCell className="text-xs">{station.firmwareVersion ?? 'n/a'}</TableCell>
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
    </TabPanel>
  );
}
