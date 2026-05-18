// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SearchInput } from '@/components/search-input';
import { Pagination } from '@/components/ui/pagination';
import { StationsTable, STATIONS_COLUMNS } from '@/components/StationsTable';
import type { Station } from '@/components/StationsTable';
import { ColumnVisibilityToggle } from '@/components/ColumnVisibilityToggle';
import { FilterPopover } from '@/components/FilterBar';
import { useColumnVisibility } from '@/hooks/use-column-visibility';
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

  const { visibility, setVisibility } = useColumnVisibility('stations', STATIONS_COLUMNS);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 [&>*]:w-full sm:flex-row sm:items-start sm:justify-between sm:[&>*]:w-auto">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('stations.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('stations.subtitle')}</p>
        </div>
        <CreateButton
          label={t('stations.addStation')}
          onClick={() => {
            void navigate('/stations/new');
          }}
        />
      </div>

      {(() => {
        const searchInput = (
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('stations.searchPlaceholder')}
            className="h-10 w-full"
          />
        );
        const filters = (
          <>
            <div className="space-y-2">
              <Label>{t('sites.title')}</Label>
              <Select
                aria-label={t('sites.title')}
                className="h-10"
                value={filterSiteId}
                onChange={(e) => {
                  setFilterSiteId(e.target.value);
                }}
              >
                <option value="">{t('stations.allSites')}</option>
                {siteList?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
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
                <option value="">{t('stations.allStatuses')}</option>
                <option value="charging">{t('status.charging')}</option>
                <option value="reserved">{t('status.reserved')}</option>
                <option value="available">{t('status.available')}</option>
                <option value="faulted">{t('status.faulted')}</option>
                <option value="unavailable">{t('status.unavailable')}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('stations.connectivity')}</Label>
              <Select
                aria-label={t('stations.connectivity')}
                className="h-10"
                value={filterOnline}
                onChange={(e) => {
                  setFilterOnline(e.target.value);
                }}
              >
                <option value="">{t('stations.allOnline')}</option>
                <option value="true">{t('status.online')}</option>
                <option value="false">{t('status.offline')}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('stations.onboardingStatus')}</Label>
              <Select
                aria-label={t('stations.onboardingStatus')}
                className="h-10"
                value={filterOnboardingStatus}
                onChange={(e) => {
                  setFilterOnboardingStatus(e.target.value);
                }}
              >
                <option value="">{t('stations.onboardingStatusFilter')}</option>
                <option value="pending">{t('status.pending')}</option>
                <option value="accepted">{t('status.accepted')}</option>
                <option value="blocked">{t('status.blocked')}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('stations.type')}</Label>
              <Select
                aria-label={t('stations.type')}
                className="h-10"
                value={filterSimulator}
                onChange={(e) => {
                  setFilterSimulator(e.target.value);
                }}
              >
                <option value="">{t('stations.allTypes')}</option>
                <option value="true">{t('stations.simulatorOnly')}</option>
                <option value="false">{t('stations.realOnly')}</option>
              </Select>
            </div>
          </>
        );
        const activeFilterCount =
          (filterSiteId !== '' ? 1 : 0) +
          (filterStatus !== '' ? 1 : 0) +
          (filterOnline !== '' ? 1 : 0) +
          (filterOnboardingStatus !== '' ? 1 : 0) +
          (filterSimulator !== '' ? 1 : 0);
        const columnsToggle = (
          <ColumnVisibilityToggle
            tableKey="stations"
            columns={STATIONS_COLUMNS}
            visibility={visibility}
            onChange={setVisibility}
          />
        );
        return (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 lg:hidden">
                <div className="flex-1">{searchInput}</div>
                <FilterPopover
                  activeCount={activeFilterCount}
                  onClearAll={() => {
                    setFilterSiteId('');
                    setFilterStatus('');
                    setFilterOnline('');
                    setFilterOnboardingStatus('');
                    setFilterSimulator('');
                  }}
                >
                  {filters}
                </FilterPopover>
                {columnsToggle}
              </div>
              <div className="hidden items-end gap-4 lg:flex">
                <div className="grid flex-1 grid-cols-6 gap-4">
                  <div className="space-y-2">
                    <Label>{t('stations.search')}</Label>
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
        <CardContent className="overflow-x-auto p-0">
          <StationsTable
            stations={stations}
            timezone={timezone}
            siteMap={siteMap}
            isLoading={isLoading}
            visibility={visibility}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
