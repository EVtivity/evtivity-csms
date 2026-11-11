// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface FirmwareUpdate {
  id: number;
  requestId: number | null;
  firmwareUrl: string;
  version: string | null;
  status: string | null;
  statusInfo: { reasonCode?: string; additionalInfo?: string } | null;
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
  Rejected: 'destructive',
  Installing: 'warning',
};

/** The sort keys of `GET /v1/stations/:id/firmware-history` (`stationFirmwareListSort in the API`). */
export const STATION_FIRMWARE_SORT_KEYS = [
  'status',
  'firmwareUrl',
  'version',
  'initiatedAt',
  'lastStatusAt',
] as const;
export type StationFirmwareSortKey = (typeof STATION_FIRMWARE_SORT_KEYS)[number];

export function StationFirmwareTab({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 25;
  const firmwareListSort = useListSort(STATION_FIRMWARE_SORT_KEYS);
  // A new sort starts again at page 1.
  const firmwareSort: ListSort<StationFirmwareSortKey> = {
    ...firmwareListSort,
    toggle: (key) => {
      setPage(1);
      firmwareListSort.toggle(key);
    },
  };
  const firmwareSortQuery = new URLSearchParams(firmwareListSort.params).toString();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['stations', stationId, 'firmware-history', page, firmwareListSort.params],
    queryFn: () =>
      api.get<{ data: FirmwareUpdate[]; total: number }>(
        `/v1/stations/${stationId}/firmware-history?page=${String(page)}&limit=${String(limit)}${firmwareSortQuery === '' ? '' : `&${firmwareSortQuery}`}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <TabPanel
      title={t('stations.firmwareUpdates')}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      isEmpty={data == null || data.data.length === 0}
      emptyMessage={t('stations.noFirmwareUpdates')}
    >
      <>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortKey="status" sort={firmwareSort}>
                  {t('common.status')}
                </SortableTableHead>
                <SortableTableHead sortKey="firmwareUrl" sort={firmwareSort}>
                  URL
                </SortableTableHead>
                <SortableTableHead sortKey="version" sort={firmwareSort}>
                  {t('firmwareCampaigns.version')}
                </SortableTableHead>
                <SortableTableHead sortKey="initiatedAt" sort={firmwareSort}>
                  {t('common.initiated')}
                </SortableTableHead>
                <SortableTableHead sortKey="lastStatusAt" sort={firmwareSort}>
                  {t('common.lastUpdate')}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.data ?? []).map((fw) => (
                <TableRow key={fw.id}>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={STATUS_VARIANT[fw.status ?? ''] ?? 'outline'}>
                        {fw.status ?? 'n/a'}
                      </Badge>
                      {fw.statusInfo?.reasonCode != null && (
                        <span
                          className="text-xs text-muted-foreground"
                          title={fw.statusInfo.additionalInfo}
                        >
                          {fw.statusInfo.reasonCode}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{fw.firmwareUrl}</TableCell>
                  <TableCell className="text-xs">{fw.version ?? 'n/a'}</TableCell>
                  <TableCell className="text-xs">
                    {formatDateTime(fw.initiatedAt, timezone)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {fw.lastStatusAt != null ? formatDateTime(fw.lastStatusAt, timezone) : 'n/a'}
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
