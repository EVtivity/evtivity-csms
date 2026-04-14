// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { DriversTable, type Driver } from '@/components/DriversTable';
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('drivers.title')}</h1>
        <CreateButton
          label={t('drivers.addDriver')}
          onClick={() => {
            void navigate('/drivers/new');
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('drivers.searchPlaceholder')}
        />
        <InfoTooltip content={t('drivers.searchHint')} />
        <ResponsiveFilters activeCount={[filterStatus].filter((v) => v !== '').length}>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
            }}
            className="h-9 w-full sm:w-auto"
          >
            <option value="">{t('drivers.allStatuses')}</option>
            <option value="active">{t('common.active')}</option>
            <option value="inactive">{t('common.inactive')}</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <DriversTable
        drivers={drivers}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        timezone={timezone}
        isLoading={isLoading}
      />
    </div>
  );
}
