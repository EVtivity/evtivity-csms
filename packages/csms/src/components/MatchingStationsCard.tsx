// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import type { ListSortOrder } from '@/hooks/use-list-sort';
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

/**
 * The sort keys of the matching stations previews of firmware campaigns, configuration
 * templates and smart charging templates (`matchingStationListSort` in the API).
 */
export const MATCHING_STATION_SORT_KEYS = [
  'station',
  'site',
  'vendor',
  'model',
  'firmwareVersion',
  'status',
] as const;

type MatchingStationSortKey = (typeof MATCHING_STATION_SORT_KEYS)[number];

interface CardSort {
  sort: MatchingStationSortKey | null;
  order: ListSortOrder;
}

export function MatchingStationsCard({
  endpoint,
  queryKey,
  showFirmwareVersion = false,
  title,
}: MatchingStationsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // The card sits on detail pages next to other sorted lists, so its sort is its own
  // state, not the page URL: ascending, then descending, then the default order.
  const [cardSort, setCardSort] = useState<CardSort>({ sort: null, order: 'asc' });
  const sort = {
    ...cardSort,
    toggle: (key: MatchingStationSortKey) => {
      setPage(1);
      setCardSort((prev) => {
        if (prev.sort !== key) return { sort: key, order: 'asc' };
        if (prev.order === 'asc') return { sort: key, order: 'desc' };
        return { sort: null, order: 'asc' };
      });
    },
  };
  const limit = 10;

  const {
    data: matchingStations,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [...queryKey, page, statusFilter, cardSort],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (cardSort.sort != null) {
        params.set('sort', cardSort.sort);
        params.set('order', cardSort.order);
      }
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
                <SortableTableHead sortKey="station" sort={sort}>
                  {t('nav.stations')}
                </SortableTableHead>
                <SortableTableHead sortKey="site" sort={sort}>
                  {t('firmwareCampaigns.site')}
                </SortableTableHead>
                <SortableTableHead sortKey="vendor" sort={sort}>
                  {t('firmwareCampaigns.vendor')}
                </SortableTableHead>
                <SortableTableHead sortKey="model" sort={sort}>
                  {t('firmwareCampaigns.model')}
                </SortableTableHead>
                {showFirmwareVersion && (
                  <SortableTableHead sortKey="firmwareVersion" sort={sort}>
                    {t('firmwareCampaigns.currentFirmware')}
                  </SortableTableHead>
                )}
                <SortableTableHead sortKey="status" sort={sort}>
                  {t('common.status')}
                </SortableTableHead>
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
