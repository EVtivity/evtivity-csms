// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { CopyableId } from '@/components/copyable-id';
import { TableSkeleton } from '@/components/TableSkeleton';
import { formatDate, useUserTimezone } from '@/lib/timezone';

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

  const {
    data: fleets,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Fleet>('fleets', '/v1/fleets');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('fleets.title')}</h1>
        <CreateButton
          label={t('fleets.createFleet')}
          onClick={() => {
            void navigate('/fleets/new');
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('fleets.searchPlaceholder')}
        />
        <InfoTooltip content={t('fleets.searchHint')} />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fleets.fleetName')}</TableHead>
              <TableHead>{t('fleets.fleetId')}</TableHead>
              <TableHead>{t('common.description')}</TableHead>
              <TableHead>{t('fleets.drivers')}</TableHead>
              <TableHead>{t('fleets.stations')}</TableHead>
              <TableHead>{t('common.created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6}>
                  <TableSkeleton columns={6} rows={5} />
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
                <TableCell className="font-medium text-primary" data-testid="row-click-target">
                  {fleet.name}
                </TableCell>
                <TableCell>
                  <CopyableId id={fleet.id} variant="table" />
                </TableCell>
                <TableCell>{fleet.description ?? '-'}</TableCell>
                <TableCell>{fleet.driverCount}</TableCell>
                <TableCell>{fleet.stationCount}</TableCell>
                <TableCell>{formatDate(fleet.createdAt, timezone)}</TableCell>
              </TableRow>
            ))}
            {fleets?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {t('fleets.noFleetsFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
