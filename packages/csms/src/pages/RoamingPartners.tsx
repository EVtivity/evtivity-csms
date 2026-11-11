// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useHasPermission } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/search-input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CreateButton } from '@/components/create-button';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useListSort } from '@/hooks/use-list-sort';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { roamingPartnerStatusVariant } from '@/lib/status-variants';
import { useRoamingTabAction } from './RoamingLayout';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';

interface Partner {
  id: string;
  name: string;
  countryCode: string;
  partyId: string;
  status: string;
  version: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The sort keys of `GET /v1/ocpi/partners` (`ocpiPartnerListSort` in the API). */
export const ROAMING_PARTNER_SORT_KEYS = [
  'name',
  'countryParty',
  'status',
  'version',
  'createdAt',
] as const;

export function RoamingPartners(): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('roaming:write');
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const listSort = useListSort(ROAMING_PARTNER_SORT_KEYS);

  const {
    data: partners,
    isLoading,
    isError,
    refetch,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Partner>('ocpi-partners', '/v1/ocpi/partners', listSort.params);

  useRoamingTabAction(
    useMemo(
      () =>
        canWrite ? (
          <CreateButton
            label={t('roaming.partners.addPartner')}
            onClick={() => {
              void navigate('/roaming/partners/new');
            }}
          />
        ) : null,
      [t, navigate, canWrite],
    ),
  );

  return (
    <div className="space-y-6">
      <TabPanel title={t('nav.roamingPartners')}>
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('common.search')}
          className="w-full sm:max-w-half-vw"
        />
      </TabPanel>

      <TabPanel body="flush">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortKey="name" sort={listSort}>
                  {t('roaming.partners.partnerName')}
                </SortableTableHead>
                <SortableTableHead sortKey="countryParty" sort={listSort}>
                  {t('roaming.partners.countryParty')}
                </SortableTableHead>
                <SortableTableHead sortKey="status" sort={listSort}>
                  {t('common.status')}
                </SortableTableHead>
                <SortableTableHead sortKey="version" sort={listSort}>
                  {t('roaming.partners.version')}
                </SortableTableHead>
                <SortableTableHead sortKey="createdAt" sort={listSort}>
                  {t('common.created')}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableStateRow colSpan={5}>
                  <LoadingState />
                </TableStateRow>
              ) : isError ? (
                <TableStateRow colSpan={5}>
                  <ErrorState onRetry={refetch} />
                </TableStateRow>
              ) : partners == null || partners.length === 0 ? (
                <TableStateRow colSpan={5}>
                  <EmptyState>{t('roaming.partners.noPartners')}</EmptyState>
                </TableStateRow>
              ) : (
                partners.map((partner) => (
                  <TableRow
                    key={partner.id}
                    className="cursor-pointer"
                    data-testid={`roaming-partner-row-${partner.id}`}
                    onClick={() => {
                      void navigate(`/roaming/partners/${partner.id}`);
                    }}
                  >
                    <TableCell className="font-medium" data-testid="row-click-target">
                      {partner.name}
                    </TableCell>
                    <TableCell>
                      {partner.countryCode}-{partner.partyId}
                    </TableCell>
                    <TableCell>
                      <Badge variant={roamingPartnerStatusVariant(partner.status)}>
                        {partner.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{partner.version ?? '-'}</TableCell>
                    <TableCell>{formatDateTime(partner.createdAt, timezone)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabPanel>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
