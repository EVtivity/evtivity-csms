// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { SearchInput } from '@/components/search-input';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Pagination } from '@/components/ui/pagination';
import { StationsTable } from '@/components/StationsTable';
import type { Station } from '@/components/StationsTable';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

interface Site {
  id: string;
  name: string;
}

export function Stations(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterOnboardingStatus, setFilterOnboardingStatus] = useState('');
  const [filterOnline, setFilterOnline] = useState('');
  const [filterSimulator, setFilterSimulator] = useState('');
  const totalFilterCount =
    (filterSiteId !== '' ? 1 : 0) +
    (filterStatus !== '' ? 1 : 0) +
    (filterOnline !== '' ? 1 : 0) +
    (filterOnboardingStatus !== '' ? 1 : 0) +
    (filterSimulator !== '' ? 1 : 0);

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const siteList = sites?.data;

  const extraParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (filterSiteId !== '') params.siteId = filterSiteId;
    if (filterStatus !== '') params.status = filterStatus;
    if (filterOnboardingStatus !== '') params.onboardingStatus = filterOnboardingStatus;
    if (filterOnline !== '') params.isOnline = filterOnline;
    if (filterSimulator !== '') params.isSimulator = filterSimulator;
    return Object.keys(params).length > 0 ? params : undefined;
  }, [filterSiteId, filterStatus, filterOnboardingStatus, filterOnline, filterSimulator]);

  const {
    data: stations,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Station>('stations', '/v1/stations', extraParams);

  const siteMap = new Map<string, string>();
  if (siteList != null) {
    for (const s of siteList) {
      siteMap.set(s.id, s.name);
    }
  }

  const primaryFilters = (
    <>
      <Select
        aria-label="Filter by site"
        value={filterSiteId}
        onChange={(e) => {
          setFilterSiteId(e.target.value);
        }}
        className="h-9 w-auto"
      >
        <option value="">{t('stations.allSites')}</option>
        {siteList?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Filter by status"
        value={filterStatus}
        onChange={(e) => {
          setFilterStatus(e.target.value);
        }}
        className="h-9 w-auto"
      >
        <option value="">{t('stations.allStatuses')}</option>
        <option value="charging">{t('status.charging')}</option>
        <option value="reserved">{t('status.reserved')}</option>
        <option value="available">{t('status.available')}</option>
        <option value="faulted">{t('status.faulted')}</option>
        <option value="unavailable">{t('status.unavailable')}</option>
      </Select>
      <Select
        aria-label="Filter by connectivity"
        value={filterOnline}
        onChange={(e) => {
          setFilterOnline(e.target.value);
        }}
        className="h-9 w-auto"
      >
        <option value="">{t('stations.allOnline')}</option>
        <option value="true">{t('status.online')}</option>
        <option value="false">{t('status.offline')}</option>
      </Select>
    </>
  );

  const secondaryFilters = (
    <>
      <Select
        aria-label="Filter by onboarding status"
        value={filterOnboardingStatus}
        onChange={(e) => {
          setFilterOnboardingStatus(e.target.value);
        }}
        className="h-9 w-auto"
      >
        <option value="">{t('stations.onboardingStatusFilter')}</option>
        <option value="pending">{t('status.pending')}</option>
        <option value="accepted">{t('status.accepted')}</option>
        <option value="blocked">{t('status.blocked')}</option>
      </Select>
      <Select
        aria-label="Filter by type"
        value={filterSimulator}
        onChange={(e) => {
          setFilterSimulator(e.target.value);
        }}
        className="h-9 w-auto"
      >
        <option value="">{t('stations.allTypes')}</option>
        <option value="true">{t('stations.simulatorOnly')}</option>
        <option value="false">{t('stations.realOnly')}</option>
      </Select>
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('stations.title')}</h1>
        <CreateButton
          label={t('stations.addStation')}
          onClick={() => {
            void navigate('/stations/new');
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('stations.searchPlaceholder')}
        />
        <InfoTooltip content={t('stations.searchHint')} />
        <ResponsiveFilters activeCount={totalFilterCount} moreFilters={secondaryFilters}>
          {primaryFilters}
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <StationsTable
          stations={stations}
          timezone={timezone}
          siteMap={siteMap}
          isLoading={isLoading}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
