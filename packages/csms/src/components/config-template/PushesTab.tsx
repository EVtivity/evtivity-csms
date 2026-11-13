// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useListSort } from '@/hooks/use-list-sort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
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

/** The sort keys of `GET /v1/config-templates/:id/pushes` (the API list sort definition in `lib/sorts/`). */
const CONFIG_PUSH_SORT_KEYS = ['createdAt', 'status'] as const;

interface PushRecord {
  id: string;
  status: string;
  stationCount: number;
  acceptedCount: number;
  rejectedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
}

const PUSH_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'outline'> = {
  active: 'default',
  completed: 'secondary',
};

interface Props {
  templateId: string;
}

export function ConfigTemplatePushesTab({ templateId }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const listSort = useListSort(CONFIG_PUSH_SORT_KEYS);
  // A new sort starts again at page 1.
  const sort = {
    ...listSort,
    toggle: (key: (typeof CONFIG_PUSH_SORT_KEYS)[number]) => {
      setPage(1);
      listSort.toggle(key);
    },
  };
  const sortQuery = new URLSearchParams(listSort.params).toString();
  const limit = 10;

  const {
    data: pushes,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['config-templates', templateId, 'pushes', page, listSort.params],
    queryFn: () =>
      api.get<{ data: PushRecord[]; total: number }>(
        `/v1/config-templates/${templateId}/pushes?page=${String(page)}&limit=${String(limit)}${sortQuery ? `&${sortQuery}` : ''}`,
      ),
    refetchInterval: 5000,
  });

  const total = pushes?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <TabPanel
      title={t('configTemplates.pushes')}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      isEmpty={total === 0}
      emptyMessage={t('configTemplates.noPushes')}
    >
      <>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortKey="createdAt" sort={sort}>
                  {t('common.timestamp')}
                </SortableTableHead>
                <SortableTableHead sortKey="status" sort={sort}>
                  {t('common.status')}
                </SortableTableHead>
                <TableHead>{t('nav.stations')}</TableHead>
                <TableHead>{t('configTemplates.accepted')}</TableHead>
                <TableHead>{t('configTemplates.rejected')}</TableHead>
                <TableHead>{t('configTemplates.failed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pushes?.data.map((push) => (
                <TableRow
                  key={push.id}
                  className="cursor-pointer"
                  data-testid={`config-push-row-${push.id}`}
                  onClick={() => {
                    void navigate(`/station-configuration-pushes/${push.id}`);
                  }}
                >
                  <TableCell className="text-xs" data-testid="row-click-target">
                    {formatDateTime(push.createdAt, timezone)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={PUSH_STATUS_VARIANT[push.status] ?? 'outline'}>
                      {push.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{push.stationCount}</TableCell>
                  <TableCell>{push.acceptedCount}</TableCell>
                  <TableCell>
                    {push.rejectedCount > 0 ? (
                      <span className="text-warning-text">{push.rejectedCount}</span>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell>
                    {push.failedCount > 0 ? (
                      <span className="text-destructive">{push.failedCount}</span>
                    ) : (
                      0
                    )}
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
