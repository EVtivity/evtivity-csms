// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { RecalculateElectricityCostAction } from '@/components/ElectricityCostNotices';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/search-input';
import { SessionsTable, SESSIONS_COLUMNS } from '@/components/SessionsTable';
import type { Session } from '@/components/SessionsTable';
import { ColumnVisibilityToggle } from '@/components/ColumnVisibilityToggle';
import { FilterPopover } from '@/components/FilterBar';
import { useColumnVisibility } from '@/hooks/use-column-visibility';
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
  // The filters and the search live in the URL (?siteId=, ?stationId=,
  // ?status=, ?costMissing=true, ?search=), so Back, a reload and a shared
  // link keep them. ?siteId=<id>&costMissing=true lists a site's sessions
  // without an electricity cost.
  const [searchParams, setSearchParams] = useSearchParams();
  const filterSiteId = searchParams.get('siteId') ?? '';
  const filterStationId = searchParams.get('stationId') ?? '';
  const filterStatus = searchParams.get('status') ?? '';
  const filterCostMissing = searchParams.get('costMissing') === 'true';
  const setFilters = useCallback(
    (changes: Record<string, string>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });
  // The filter lists hold the first 100 sites and stations. A selected one
  // past them (a link to a later site) is loaded by id, so the filter shows it.
  const siteListed = filterSiteId === '' || sites?.data.some((s) => s.id === filterSiteId);
  const { data: selectedSite } = useQuery({
    queryKey: ['sites', filterSiteId],
    queryFn: () => api.get<Site>(`/v1/sites/${filterSiteId}`),
    enabled: sites != null && siteListed !== true,
  });
  const siteOptions = useMemo(() => {
    const list = sites?.data ?? [];
    return selectedSite != null && !list.some((s) => s.id === selectedSite.id)
      ? [...list, selectedSite]
      : list;
  }, [sites, selectedSite]);

  const stationQueryUrl = filterSiteId
    ? `/v1/stations?limit=100&siteId=${filterSiteId}`
    : '/v1/stations?limit=100';
  const { data: stations } = useQuery({
    queryKey: ['stations', 'filter-options', filterSiteId],
    queryFn: () => api.get<{ data: Station[]; total: number }>(stationQueryUrl),
  });
  const stationListed =
    filterStationId === '' || stations?.data.some((s) => s.id === filterStationId);
  const { data: selectedStation } = useQuery({
    queryKey: ['stations', filterStationId],
    queryFn: () => api.get<Station>(`/v1/stations/${filterStationId}`),
    enabled: stations != null && stationListed !== true,
  });
  const stationOptions = useMemo(() => {
    const list = stations?.data ?? [];
    return selectedStation != null && !list.some((s) => s.id === selectedStation.id)
      ? [...list, selectedStation]
      : list;
  }, [stations, selectedStation]);

  const extraParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (filterSiteId !== '') params.siteId = filterSiteId;
    if (filterStationId !== '') params.stationId = filterStationId;
    if (filterStatus !== '') params.status = filterStatus;
    if (filterCostMissing) params.costMissing = 'true';
    return Object.keys(params).length > 0 ? params : undefined;
  }, [filterSiteId, filterStationId, filterStatus, filterCostMissing]);
  const filterSiteName = siteOptions.find((s) => s.id === filterSiteId)?.name;

  // A link can open the list already searched (`?search=`).
  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
    page,
    totalPages,
    setPage,
    search,
    setSearch: setListSearch,
  } = usePaginatedQuery<Session>(
    'sessions',
    '/v1/sessions',
    extraParams,
    searchParams.get('search') ?? '',
  );

  const setSearch = useCallback(
    (value: string) => {
      setListSearch(value);
      setFilters({ search: value });
    },
    [setListSearch, setFilters],
  );

  const { visibility, setVisibility } = useColumnVisibility('sessions', SESSIONS_COLUMNS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{t('sessions.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('sessions.subtitle')}</p>
      </div>

      {(() => {
        const searchInput = (
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('sessions.searchPlaceholder')}
            className="w-full"
          />
        );
        const filters = (
          <>
            <div className="space-y-2">
              <Label className="leading-6">{t('sites.title')}</Label>
              <Select
                aria-label={t('sites.title')}
                value={filterSiteId}
                onChange={(e) => {
                  setFilters({ siteId: e.target.value, stationId: '' });
                }}
              >
                <option value="">{t('sessions.allSites')}</option>
                {siteOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="leading-6">{t('stations.title')}</Label>
              <Select
                aria-label={t('stations.title')}
                value={filterStationId}
                onChange={(e) => {
                  setFilters({ stationId: e.target.value });
                }}
              >
                <option value="">{t('sessions.allStations')}</option>
                {stationOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.stationId}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="leading-6">{t('common.status')}</Label>
              <Select
                aria-label={t('common.status')}
                value={filterStatus}
                onChange={(e) => {
                  setFilters({ status: e.target.value });
                }}
              >
                <option value="">{t('sessions.allStatuses')}</option>
                <option value="active">{t('status.active')}</option>
                <option value="idling">{t('status.idle')}</option>
                <option value="completed">{t('status.completed')}</option>
                <option value="failed">{t('status.failed')}</option>
                <option value="faulted">{t('status.faulted')}</option>
                <option value="manual_billing">{t('sessions.manualBilling')}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="leading-6">{t('sessions.electricityCost')}</Label>
              <Select
                aria-label={t('sessions.electricityCost')}
                value={filterCostMissing ? 'missing' : ''}
                onChange={(e) => {
                  setFilters({ costMissing: e.target.value === 'missing' ? 'true' : '' });
                }}
              >
                <option value="">{t('sessions.electricityCostAll')}</option>
                <option value="missing">{t('sessions.electricityCostMissing')}</option>
              </Select>
            </div>
          </>
        );
        const activeFilterCount =
          (filterSiteId !== '' ? 1 : 0) +
          (filterStationId !== '' ? 1 : 0) +
          (filterStatus !== '' ? 1 : 0) +
          (filterCostMissing ? 1 : 0);
        const columnsToggle = (
          <ColumnVisibilityToggle
            tableKey="sessions"
            columns={SESSIONS_COLUMNS}
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
                    setFilters({ siteId: '', stationId: '', status: '', costMissing: '' });
                  }}
                >
                  {filters}
                </FilterPopover>
                {columnsToggle}
              </div>
              <div className="hidden items-end gap-4 md:flex">
                <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
                  <div className="space-y-2">
                    <Label className="leading-6">{t('sessions.search')}</Label>
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

      {filterCostMissing && (
        <Alert variant="warning" data-testid="sessions-cost-missing-notice">
          <AlertTriangle />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {filterSiteName != null
                ? t('sessions.costMissingNotice')
                : t('sessions.costMissingSelectSite')}
            </span>
            {filterSiteName != null && (
              <RecalculateElectricityCostAction siteId={filterSiteId} siteName={filterSiteName} />
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <SessionsTable
            sessions={sessions}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            timezone={timezone}
            isLoading={isLoading}
            isError={isError}
            onRetry={refetch}
            visibility={visibility}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
