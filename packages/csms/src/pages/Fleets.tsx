// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { TableSkeleton } from '@/components/TableSkeleton';
import { formatDate, useUserTimezone } from '@/lib/timezone';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useListSort } from '@/hooks/use-list-sort';

/** The sort keys of `GET /v1/fleets` (`fleetListSort` in the API). */
const FLEET_SORT_KEYS = [
  'name',
  'description',
  'driverCount',
  'stationCount',
  'createdAt',
] as const;

interface Fleet {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  driverCount: number;
  stationCount: number;
}

export function Fleets(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const listSort = useListSort(FLEET_SORT_KEYS);

  const {
    data: fleets,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Fleet>('fleets', '/v1/fleets', listSort.params);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('fleets.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('fleets.subtitle')}</p>
        </div>
        <CreateButton
          label={t('fleets.createFleet')}
          onClick={() => {
            void navigate('/fleets/new');
          }}
        />
      </div>

      <Card>
        <CardContent className="p-4">
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('fleets.searchPlaceholder')}
            className="w-full sm:max-w-half-vw"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortKey="name" sort={listSort}>
                  {t('fleets.fleetName')}
                </SortableTableHead>
                <SortableTableHead sortKey="description" sort={listSort}>
                  {t('common.description')}
                </SortableTableHead>
                <SortableTableHead sortKey="driverCount" sort={listSort}>
                  {t('fleets.drivers')}
                </SortableTableHead>
                <SortableTableHead sortKey="stationCount" sort={listSort}>
                  {t('fleets.stations')}
                </SortableTableHead>
                <SortableTableHead sortKey="createdAt" sort={listSort}>
                  {t('common.created')}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <TableSkeleton columns={5} rows={5} />
                  </TableCell>
                </TableRow>
              )}
              {fleets?.map((fleet) => (
                <TableRow
                  key={fleet.id}
                  className="cursor-pointer"
                  data-testid={`fleet-row-${fleet.id}`}
                  onClick={() => {
                    void navigate(`/fleets/${fleet.id}`);
                  }}
                >
                  <TableCell className="font-medium text-link" data-testid="row-click-target">
                    {fleet.name}
                  </TableCell>
                  <TableCell>{fleet.description ?? '-'}</TableCell>
                  <TableCell>{fleet.driverCount}</TableCell>
                  <TableCell>{fleet.stationCount}</TableCell>
                  <TableCell>{formatDate(fleet.createdAt, timezone)}</TableCell>
                </TableRow>
              ))}
              {fleets?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {t('fleets.noFleetsFound')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
