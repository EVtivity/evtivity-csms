// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import { SearchInput } from '@/components/search-input';
import { FilterPopover } from '@/components/FilterBar';
import { ColumnVisibilityToggle } from '@/components/ColumnVisibilityToggle';
import { TemplateButton } from '@/components/template-button';
import { ImportButton } from '@/components/import-button';
import { ExportButton } from '@/components/export-button';
import { CsvImportDialog, CsvImportResultCard } from '@/components/csv-import-dialog';
import { SimsTable, SIMS_COLUMNS, type SimListItem } from '@/components/sims/SimsTable';
import {
  SIM_ATTACHMENT_FILTERS,
  SIM_CSMS_STATUSES,
  SIM_FILTER_KEYS,
  SIM_PROVIDER_STATES,
  simExportQuery,
  simListParams,
} from '@/components/sims/sim-filters';
import { PROVIDER_NAMES } from '@/components/sim/sim-connectivity';
import { useColumnVisibility } from '@/hooks/use-column-visibility';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { LoadingLogo } from '@/components/loading-logo';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api, ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { parseCsvLine, readCsvText } from '@/lib/csv-parse';
import { getErrorMessage } from '@/lib/error-message';
import { useHasCompanyWidePermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';

interface Station {
  id: string;
  stationId: string;
}

/** The reply of `POST /v1/sims/import`. */
interface SimImportResult {
  created: number;
  updated: number;
  attached: number;
  errors: string[];
}

/** The columns the import reads; the export-only columns are ignored. */
const IMPORT_COLUMNS = ['iccid', 'imsi', 'label', 'notes', 'stationId'] as const;

function download(url: string, filename: string): Promise<void> {
  return fetch(url, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      return res.blob();
    })
    .then((blob) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    });
}

/**
 * The SIM inventory. The page follows the SIM features (a SIM provider or
 * station signal reads): while both are off the API refuses every SIM route,
 * so the page says so instead of listing.
 */
export function Sims(): React.JSX.Element {
  const { t } = useTranslation();
  const { flags, isLoading } = useFeatureFlags();
  if (isLoading) return <LoadingLogo />;
  if (!flags.simEnabled) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('sims.title')}</h1>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            {t('sims.featureOff')}
          </CardContent>
        </Card>
      </div>
    );
  }
  return <SimsList />;
}

function SimsList(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The import and the template add SIMs that belong to no site yet: access to
  // every site and sims:write (the import route answers 404 otherwise).
  const canImport = useHasCompanyWidePermission('sims:write');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importFilename, setImportFilename] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);

  // The filters and the search live in the URL (?search=, ?provider=,
  // ?attachment=, ?status=, ?state=, ?stationId=), so Back, a reload and a
  // shared link keep them. `status` is the CSMS status, `state` the provider status.
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => simListParams(searchParams), [searchParams]);
  const setFilters = useCallback(
    (changes: Record<string, string>) => {
      setSearchParams(
        () => {
          // From the URL as it is now, not `prev`: react-router passes the hook's
          // last rendered params, so a second change before the re-render (a
          // debounced search, then a filter) would drop the first one.
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

  // The station filter lists the first 100 stations; a selected one past them
  // (a link from a station) is loaded by id, so the filter shows it.
  const filterStationId = filters.stationId ?? '';
  const { data: stations } = useQuery({
    queryKey: ['stations', 'filter-options'],
    queryFn: () => api.get<{ data: Station[]; total: number }>('/v1/stations?limit=100'),
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

  const extraParams = useMemo(
    () => (Object.keys(filters).length > 0 ? (filters as Record<string, string>) : undefined),
    [filters],
  );
  const {
    data: sims,
    isLoading,
    isError,
    refetch,
    page,
    totalPages,
    setPage,
    search,
    setSearch: setListSearch,
  } = usePaginatedQuery<SimListItem>(
    ['sims'],
    '/v1/sims',
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

  const { visibility, setVisibility } = useColumnVisibility('sims', SIMS_COLUMNS);

  const importMutation = useMutation({
    mutationFn: (data: { rows: Record<string, unknown>[]; updateExisting: boolean }) =>
      api.post<SimImportResult>('/v1/sims/import', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      setImportDialogOpen(false);
    },
  });

  function handleExport(): void {
    // Export CSV exports the list with the search and the filters on screen.
    const query = simExportQuery(search, filters);
    download(`${API_BASE_URL}/v1/sims/export${query ? `?${query}` : ''}`, 'sims.csv').catch(
      (err: unknown) => {
        toast({ title: getErrorMessage(err, t), variant: 'destructive' });
      },
    );
  }

  function handleDownloadTemplate(): void {
    download(`${API_BASE_URL}/v1/sims/export/template`, 'sims-template.csv').catch(
      (err: unknown) => {
        toast({ title: getErrorMessage(err, t), variant: 'destructive' });
      },
    );
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = readCsvText(event.target?.result as string);
      const lines = text.trim().split('\n');
      const header = lines[0];
      if (!header) return;
      const columns = parseCsvLine(header);
      const rows = lines.slice(1).map((line) => {
        const parts = parseCsvLine(line);
        const row: Record<string, unknown> = {};
        for (const column of IMPORT_COLUMNS) {
          const index = columns.indexOf(column);
          row[column] = (index >= 0 ? parts[index] : undefined) || undefined;
        }
        return row;
      });
      setImportRows(rows);
      setImportFilename(file.name);
      setUpdateExisting(false);
      importMutation.reset();
      setImportDialogOpen(true);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const activeFilterCount = SIM_FILTER_KEYS.filter((key) => filters[key] != null).length;
  const clearFilters = (): void => {
    setFilters(Object.fromEntries(SIM_FILTER_KEYS.map((key) => [key, ''])));
  };

  const searchInput = (
    <SearchInput
      value={search}
      onDebouncedChange={setSearch}
      placeholder={t('sims.searchPlaceholder')}
      className="w-full"
    />
  );
  const filterControls = (
    <>
      <div className="space-y-2">
        <Label className="leading-6">{t('sims.filters.provider')}</Label>
        <Select
          aria-label={t('sims.filters.provider')}
          value={filters.provider ?? ''}
          onChange={(e) => {
            setFilters({ provider: e.target.value });
          }}
        >
          <option value="">{t('sims.filters.allProviders')}</option>
          {Object.entries(PROVIDER_NAMES).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('sims.filters.attachment')}</Label>
        <Select
          aria-label={t('sims.filters.attachment')}
          value={filters.attachment ?? ''}
          onChange={(e) => {
            setFilters({ attachment: e.target.value });
          }}
        >
          <option value="">{t('sims.filters.allAttachments')}</option>
          {SIM_ATTACHMENT_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(`sims.attachmentFilter.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('sims.filters.csmsStatus')}</Label>
        <Select
          aria-label={t('sims.filters.csmsStatus')}
          value={filters.status ?? ''}
          onChange={(e) => {
            setFilters({ status: e.target.value });
          }}
        >
          <option value="">{t('sims.filters.allCsmsStatuses')}</option>
          {SIM_CSMS_STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`sims.csmsStatus.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('sims.filters.providerStatus')}</Label>
        <Select
          aria-label={t('sims.filters.providerStatus')}
          value={filters.state ?? ''}
          onChange={(e) => {
            setFilters({ state: e.target.value });
          }}
        >
          <option value="">{t('sims.filters.allProviderStatuses')}</option>
          {SIM_PROVIDER_STATES.map((value) => (
            <option key={value} value={value}>
              {t(`stations.sim.state.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('sims.filters.station')}</Label>
        <Select
          aria-label={t('sims.filters.station')}
          value={filterStationId}
          onChange={(e) => {
            setFilters({ stationId: e.target.value });
          }}
        >
          <option value="">{t('sims.filters.allStations')}</option>
          {stationOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.stationId}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
  const columnsToggle = (
    <ColumnVisibilityToggle
      tableKey="sims"
      columns={SIMS_COLUMNS}
      visibility={visibility}
      onChange={setVisibility}
    />
  );

  const result = importMutation.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold">{t('sims.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('sims.subtitle')}</p>
        </div>
        <div className="flex flex-col gap-2 *:w-full sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:*:w-auto">
          {canImport && (
            <TemplateButton label={t('sims.downloadTemplate')} onClick={handleDownloadTemplate} />
          )}
          {canImport && (
            <ImportButton
              label={importMutation.isPending ? t('sites.importing') : t('sites.importCsv')}
              onClick={() => {
                fileInputRef.current?.click();
              }}
              disabled={importMutation.isPending}
            />
          )}
          <ExportButton label={t('sites.exportCsv')} onClick={handleExport} />
          {canImport && (
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              aria-label={t('sites.importCsv')}
              onChange={handleImportFile}
            />
          )}
        </div>
      </div>

      {importMutation.isSuccess && result != null && (
        <CsvImportResultCard
          lines={[
            ...(result.created > 0
              ? [t('sims.importResult.created', { count: result.created })]
              : []),
            ...(result.updated > 0
              ? [t('sims.importResult.updated', { count: result.updated })]
              : []),
            ...(result.attached > 0
              ? [t('sims.importResult.attached', { count: result.attached })]
              : []),
          ]}
          errors={result.errors}
        />
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 md:hidden">
            <div className="min-w-0 flex-1">{searchInput}</div>
            <FilterPopover activeCount={activeFilterCount} onClearAll={clearFilters}>
              {filterControls}
            </FilterPopover>
            {columnsToggle}
          </div>
          <div className="hidden items-end gap-4 md:flex">
            <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-6">
              <div className="space-y-2">
                <Label className="leading-6">{t('sims.search')}</Label>
                {searchInput}
              </div>
              {filterControls}
            </div>
            {columnsToggle}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <SimsTable
            sims={sims}
            timezone={timezone}
            isLoading={isLoading}
            isError={isError}
            onRetry={refetch}
            visibility={visibility}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <CsvImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        title={t('sims.importConfirmTitle')}
        rowCount={importRows.length}
        filename={importFilename}
        updateExisting={updateExisting}
        onUpdateExistingChange={setUpdateExisting}
        isPending={importMutation.isPending}
        error={importMutation.isError ? importMutation.error : null}
        onConfirm={() => {
          importMutation.mutate({ rows: importRows, updateExisting });
        }}
      />
    </div>
  );
}
