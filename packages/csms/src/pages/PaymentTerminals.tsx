// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/search-input';
import { FilterPopover } from '@/components/FilterBar';
import { CreateButton } from '@/components/create-button';
import { ExportButton } from '@/components/export-button';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';
import { PaymentTerminalsTable } from '@/components/payment-terminals/PaymentTerminalsTable';
import {
  usePaymentTerminalFeature,
  type PaymentTerminal,
} from '@/components/payment-terminals/payment-terminal-types';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api, ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { getErrorMessage } from '@/lib/error-message';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';

interface SiteOption {
  id: string;
  name: string;
}

/** The list filters kept in the URL. */
const FILTER_KEYS = ['status', 'online', 'siteId'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

function listFilters(params: URLSearchParams): Partial<Record<FilterKey, string>> {
  const filters: Partial<Record<FilterKey, string>> = {};
  const status = params.get('status');
  if (status === 'active' || status === 'inactive') filters.status = status;
  const online = params.get('online');
  if (online === 'true' || online === 'false') filters.online = online;
  const siteId = params.get('siteId');
  if (siteId != null && siteId !== '') filters.siteId = siteId;
  return filters;
}

/** The query of Export CSV: the search and the filters on screen. */
export function paymentTerminalExportQuery(
  search: string,
  filters: Partial<Record<FilterKey, string>>,
): string {
  const params = new URLSearchParams();
  if (search !== '') params.set('search', search);
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value != null && value !== '') params.set(key, value);
  }
  return params.toString();
}

/**
 * The payment terminals of the user's sites. While no terminal provider is
 * configured and no terminal exists the page says so instead of listing.
 */
export function PaymentTerminals(): React.JSX.Element {
  const { t } = useTranslation();
  const { available, isLoading } = usePaymentTerminalFeature();
  if (isLoading) return <LoadingLogo />;
  if (!available) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('paymentTerminals.title')}</h1>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            {t('paymentTerminals.featureOff')}
          </CardContent>
        </Card>
      </div>
    );
  }
  return <PaymentTerminalsList />;
}

function PaymentTerminalsList(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('paymentTerminals:write');
  const { toast } = useToast();

  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => listFilters(searchParams), [searchParams]);
  const setFilters = useCallback(
    (changes: Record<string, string>) => {
      setSearchParams(
        () => {
          // From the URL as it is now, not `prev` (a debounced search, then a filter).
          const next = new URLSearchParams(window.location.search);
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
    queryKey: ['sites', 'filter-options'],
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
  });

  const extraParams = useMemo(
    () => (Object.keys(filters).length > 0 ? (filters as Record<string, string>) : undefined),
    [filters],
  );
  const {
    data: terminals,
    isLoading,
    isError,
    refetch,
    page,
    totalPages,
    setPage,
    search,
    setSearch: setListSearch,
  } = usePaginatedQuery<PaymentTerminal>(
    ['payment-terminals', 'list'],
    '/v1/payment-terminals',
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

  const activeFilterCount = FILTER_KEYS.filter((key) => filters[key] != null).length;
  const clearFilters = (): void => {
    setFilters(Object.fromEntries(FILTER_KEYS.map((key) => [key, ''])));
  };

  function handleExport(): void {
    // Export CSV exports the list with the search and the filters on screen.
    const query = paymentTerminalExportQuery(search, filters);
    void fetch(`${API_BASE_URL}/v1/payment-terminals/export${query ? `?${query}` : ''}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
        return res.blob();
      })
      .then((blob) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'payment-terminals.csv';
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch((err: unknown) => {
        toast({ title: getErrorMessage(err, t), variant: 'destructive' });
      });
  }

  const searchInput = (
    <SearchInput
      value={search}
      onDebouncedChange={setSearch}
      placeholder={t('paymentTerminals.searchPlaceholder')}
      className="w-full"
    />
  );
  const filterControls = (
    <>
      <div className="space-y-2">
        <Label className="leading-6">{t('paymentTerminals.filters.status')}</Label>
        <Select
          aria-label={t('paymentTerminals.filters.status')}
          value={filters.status ?? ''}
          onChange={(e) => {
            setFilters({ status: e.target.value });
          }}
        >
          <option value="">{t('paymentTerminals.filters.allStatuses')}</option>
          <option value="active">{t('paymentTerminals.status.active')}</option>
          <option value="inactive">{t('paymentTerminals.status.inactive')}</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('paymentTerminals.filters.online')}</Label>
        <Select
          aria-label={t('paymentTerminals.filters.online')}
          value={filters.online ?? ''}
          onChange={(e) => {
            setFilters({ online: e.target.value });
          }}
        >
          <option value="">{t('paymentTerminals.filters.allOnline')}</option>
          <option value="true">{t('paymentTerminals.online')}</option>
          <option value="false">{t('paymentTerminals.offline')}</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('paymentTerminals.filters.site')}</Label>
        <Select
          aria-label={t('paymentTerminals.filters.site')}
          value={filters.siteId ?? ''}
          onChange={(e) => {
            setFilters({ siteId: e.target.value });
          }}
        >
          <option value="">{t('paymentTerminals.filters.allSites')}</option>
          {(sites?.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold">{t('paymentTerminals.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('paymentTerminals.subtitle')}</p>
        </div>
        <div className="flex flex-col gap-2 *:w-full sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:*:w-auto">
          <ExportButton label={t('paymentTerminals.exportCsv')} onClick={handleExport} />
          {canWrite && (
            <CreateButton
              label={t('paymentTerminals.create')}
              onClick={() => {
                void navigate('/payment-terminals/new');
              }}
            />
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 md:hidden">
            <div className="min-w-0 flex-1">{searchInput}</div>
            <FilterPopover activeCount={activeFilterCount} onClearAll={clearFilters}>
              {filterControls}
            </FilterPopover>
          </div>
          <div className="hidden grid-cols-4 gap-4 md:grid">
            <div className="space-y-2">
              <Label className="leading-6">{t('paymentTerminals.search')}</Label>
              {searchInput}
            </div>
            {filterControls}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <PaymentTerminalsTable
            terminals={terminals}
            timezone={timezone}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => {
              refetch();
            }}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
