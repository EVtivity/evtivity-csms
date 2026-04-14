// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/search-input';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { SessionsTable } from '@/components/SessionsTable';
import type { Session } from '@/components/SessionsTable';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { useUserTimezone } from '@/lib/timezone';
import { api } from '@/lib/api';

interface Site {
  id: string;
  name: string;
}

interface Station {
  id: string;
  stationId: string;
}

export function Sessions(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterStationId, setFilterStationId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const activeFilterCount =
    (filterSiteId !== '' ? 1 : 0) +
    (filterStationId !== '' ? 1 : 0) +
    (filterStatus !== '' ? 1 : 0);

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const stationQueryUrl = filterSiteId
    ? `/v1/stations?limit=100&siteId=${filterSiteId}`
    : '/v1/stations?limit=100';
  const { data: stations } = useQuery({
    queryKey: ['stations', filterSiteId],
    queryFn: () => api.get<{ data: Station[]; total: number }>(stationQueryUrl),
  });

  const extraParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (filterSiteId !== '') params.siteId = filterSiteId;
    if (filterStationId !== '') params.stationId = filterStationId;
    if (filterStatus !== '') params.status = filterStatus;
    return Object.keys(params).length > 0 ? params : undefined;
  }, [filterSiteId, filterStationId, filterStatus]);

  const {
    data: sessions,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Session>('sessions', '/v1/sessions', extraParams);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('sessions.title')}</h1>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('sessions.searchPlaceholder')}
        />
        <InfoTooltip content={t('sessions.searchHint')} />
        <ResponsiveFilters activeCount={activeFilterCount}>
          <Select
            aria-label="Filter by site"
            value={filterSiteId}
            onChange={(e) => {
              setFilterSiteId(e.target.value);
              setFilterStationId('');
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('sessions.allSites')}</option>
            {sites?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by station"
            value={filterStationId}
            onChange={(e) => {
              setFilterStationId(e.target.value);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('sessions.allStations')}</option>
            {stations?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.stationId}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('sessions.allStatuses')}</option>
            <option value="active">{t('status.active')}</option>
            <option value="idling">{t('status.idle')}</option>
            <option value="completed">{t('status.completed')}</option>
            <option value="faulted">{t('status.faulted')}</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <SessionsTable
        sessions={sessions}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        timezone={timezone}
        isLoading={isLoading}
      />
    </div>
  );
}
