// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { DriversTable, DRIVERS_COLUMNS, type Driver } from '@/components/DriversTable';
import { ColumnVisibilityToggle } from '@/components/ColumnVisibilityToggle';
import { FilterPopover } from '@/components/FilterBar';
import { useColumnVisibility } from '@/hooks/use-column-visibility';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { useUserTimezone } from '@/lib/timezone';

export function Drivers(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const [filterStatus, setFilterStatus] = useState('');

  const {
    data: drivers,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Driver>('drivers', '/v1/drivers', {
    status: filterStatus,
  });

  const { visibility, setVisibility } = useColumnVisibility('drivers', DRIVERS_COLUMNS);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 [&>*]:w-full sm:flex-row sm:items-start sm:justify-between sm:[&>*]:w-auto">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('drivers.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('drivers.subtitle')}</p>
        </div>
        <CreateButton
          label={t('drivers.addDriver')}
          onClick={() => {
            void navigate('/drivers/new');
          }}
        />
      </div>

      {(() => {
        const searchInput = (
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('drivers.searchPlaceholder')}
            className="h-10 w-full"
          />
        );
        const filters = (
          <div className="space-y-2">
            <Label>{t('common.status')}</Label>
            <Select
              aria-label={t('common.status')}
              className="h-10"
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
              }}
            >
              <option value="">{t('drivers.allStatuses')}</option>
              <option value="active">{t('common.active')}</option>
              <option value="inactive">{t('common.inactive')}</option>
            </Select>
          </div>
        );
        const activeFilterCount = filterStatus !== '' ? 1 : 0;
        const columnsToggle = (
          <ColumnVisibilityToggle
            tableKey="drivers"
            columns={DRIVERS_COLUMNS}
            visibility={visibility}
            onChange={setVisibility}
          />
        );
        return (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 md:hidden">
                <div className="flex-1">{searchInput}</div>
                <FilterPopover
                  activeCount={activeFilterCount}
                  onClearAll={() => {
                    setFilterStatus('');
                  }}
                >
                  {filters}
                </FilterPopover>
                {columnsToggle}
              </div>
              <div className="hidden items-end gap-4 md:flex">
                <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t('drivers.search')}</Label>
                    {searchInput}
                  </div>
                  {filters}
                </div>
                {columnsToggle}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardContent className="p-0">
          <DriversTable
            drivers={drivers}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            timezone={timezone}
            isLoading={isLoading}
            visibility={visibility}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
