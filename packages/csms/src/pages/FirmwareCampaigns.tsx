// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useListSort } from '@/hooks/use-list-sort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

/** The sort keys of `GET /v1/firmware-campaigns` (the API list sort definition in `lib/sorts/`). */
const FIRMWARE_CAMPAIGN_SORT_KEYS = ['name', 'version', 'status', 'createdAt'] as const;

interface Campaign {
  id: string;
  name: string;
  firmwareUrl: string;
  version: string | null;
  status: string;
  createdAt: string;
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  draft: 'outline',
  active: 'warning',
  completed: 'success',
  cancelled: 'secondary',
};

export function FirmwareCampaigns({ embedded }: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const listSort = useListSort(FIRMWARE_CAMPAIGN_SORT_KEYS);
  // A new sort starts again at page 1.
  const sort = {
    ...listSort,
    toggle: (key: (typeof FIRMWARE_CAMPAIGN_SORT_KEYS)[number]) => {
      setPage(1);
      listSort.toggle(key);
    },
  };
  const sortQuery = new URLSearchParams(listSort.params).toString();
  const limit = 10;

  const { data, isLoading } = useQuery({
    queryKey: ['firmware-campaigns', page, listSort.params],
    queryFn: () =>
      api.get<{ data: Campaign[]; total: number }>(
        `/v1/firmware-campaigns?page=${String(page)}&limit=${String(limit)}${sortQuery ? `&${sortQuery}` : ''}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  const createBtn = (
    <CreateButton
      label={t('common.create')}
      onClick={() => {
        void navigate('/firmware-campaigns/new');
      }}
    />
  );

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">{t('nav.firmwareCampaigns')}</h1>
          {createBtn}
        </div>
      )}

      <Card>
        {embedded && (
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle>{t('nav.firmwareCampaigns')}</CardTitle>
              <CardDescription>{t('firmwareCampaigns.subtitle')}</CardDescription>
            </div>
            {createBtn}
          </CardHeader>
        )}
        <CardContent className={embedded ? '' : 'pt-6'}>
          {isLoading ? (
            <LoadingLogo size="inline" />
          ) : data == null || data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('firmwareCampaigns.noCampaigns')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTableHead sortKey="name" sort={sort}>
                        {t('common.name')}
                      </SortableTableHead>
                      <SortableTableHead sortKey="version" sort={sort}>
                        {t('firmwareCampaigns.version')}
                      </SortableTableHead>
                      <SortableTableHead sortKey="status" sort={sort}>
                        {t('common.status')}
                      </SortableTableHead>
                      <SortableTableHead sortKey="createdAt" sort={sort}>
                        {t('common.created')}
                      </SortableTableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.map((campaign) => (
                      <TableRow
                        key={campaign.id}
                        className="cursor-pointer hover:bg-muted/50"
                        data-testid={`firmware-campaign-row-${campaign.id}`}
                        onClick={() => {
                          void navigate(`/firmware-campaigns/${campaign.id}`);
                        }}
                      >
                        <TableCell className="font-medium" data-testid="row-click-target">
                          {campaign.name}
                        </TableCell>
                        <TableCell className="text-xs">
                          {campaign.version ?? t('common.na')}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[campaign.status] ?? 'outline'}>
                            {t(`firmwareCampaigns.statuses.${campaign.status}`, {
                              defaultValue: campaign.status,
                            })}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(campaign.createdAt, timezone)}
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
    </>
  );

  if (embedded) return content;

  return <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">{content}</div>;
}
