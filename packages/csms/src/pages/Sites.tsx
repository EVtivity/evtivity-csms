// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef } from 'react';
import { API_BASE_URL } from '@/lib/config';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { TemplateButton } from '@/components/template-button';
import { ImportButton } from '@/components/import-button';
import { ExportButton } from '@/components/export-button';
import { SearchInput } from '@/components/search-input';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { CopyableId } from '@/components/copyable-id';
import { TableSkeleton } from '@/components/TableSkeleton';
import { formatDate, useUserTimezone } from '@/lib/timezone';

interface Site {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  stationCount: number;
  loadManagementEnabled: boolean;
  maxPowerKw: string | null;
  totalDrawKw: string;
  createdAt: string;
}

interface ImportResult {
  sitesCreated: number;
  sitesUpdated: number;
  stationsCreated: number;
  stationsUpdated: number;
  evsesCreated: number;
  evsesUpdated: number;
  connectorsCreated: number;
  connectorsUpdated: number;
  errors: string[];
}

export function Sites(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importFilename, setImportFilename] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [locationFilter, setLocationFilter] = useState('');
  const [loadManagementFilter, setLoadManagementFilter] = useState('');

  const { data: filterOptions } = useQuery({
    queryKey: ['sites-filter-options'],
    queryFn: () =>
      api.get<{ locations: { city: string; state: string }[] }>('/v1/sites/filter-options'),
  });

  const [locationCity, locationState] = locationFilter ? locationFilter.split('|') : ['', ''];

  const {
    data: sites,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Site>('sites', '/v1/sites', {
    city: locationCity ?? '',
    state: locationState ?? '',
    loadManagement: loadManagementFilter,
  });

  const importMutation = useMutation({
    mutationFn: (data: { rows: Record<string, unknown>[]; updateExisting: boolean }) =>
      api.post<ImportResult>('/v1/sites/import', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      setImportDialogOpen(false);
    },
  });

  function handleExport(): void {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    const url = `${API_BASE_URL}/v1/sites/export${params}`;
    void fetch(url, { credentials: 'include' })
      .then((res) => res.blob())
      .then((blob) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'sites.csv';
        link.click();
        URL.revokeObjectURL(link.href);
      });
  }

  function handleDownloadTemplate(): void {
    const url = `${API_BASE_URL}/v1/sites/export/template`;
    void fetch(url, { credentials: 'include' })
      .then((res) => res.blob())
      .then((blob) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'sites-template.csv';
        link.click();
        URL.revokeObjectURL(link.href);
      });
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.trim().split('\n');
      const header = lines[0];
      if (!header) return;

      const columns = parseCsvLine(header);
      const rows = lines.slice(1).map((line) => {
        const parts = parseCsvLine(line);
        const row: Record<string, unknown> = {};
        row['siteName'] = parts[columns.indexOf('siteName')] ?? '';
        row['stationId'] = parts[columns.indexOf('stationId')] || undefined;
        row['stationModel'] = parts[columns.indexOf('stationModel')] || undefined;
        row['stationSerialNumber'] = parts[columns.indexOf('stationSerialNumber')] || undefined;
        const evseIdStr = parts[columns.indexOf('evseId')];
        row['evseId'] = evseIdStr ? Number(evseIdStr) : undefined;
        const connectorIdStr = parts[columns.indexOf('connectorId')];
        row['connectorId'] = connectorIdStr ? Number(connectorIdStr) : undefined;
        row['connectorType'] = parts[columns.indexOf('connectorType')] || undefined;
        const maxPowerStr = parts[columns.indexOf('maxPowerKw')];
        row['maxPowerKw'] = maxPowerStr ? Number(maxPowerStr) : undefined;
        const maxCurrentStr = parts[columns.indexOf('maxCurrentAmps')];
        row['maxCurrentAmps'] = maxCurrentStr ? Number(maxCurrentStr) : undefined;
        row['stationVendor'] = parts[columns.indexOf('stationVendor')] || undefined;
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

  function handleImportConfirm(): void {
    importMutation.mutate({ rows: importRows, updateExisting });
  }

  function formatLocation(site: Site): string {
    const parts: string[] = [];
    if (site.city != null) parts.push(site.city);
    if (site.state != null) parts.push(site.state);
    if (site.country != null) parts.push(site.country);
    return parts.length > 0 ? parts.join(', ') : '-';
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('sites.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <TemplateButton label={t('sites.downloadTemplate')} onClick={handleDownloadTemplate} />
          <ImportButton
            label={importMutation.isPending ? t('sites.importing') : t('sites.importCsv')}
            onClick={() => {
              fileInputRef.current?.click();
            }}
            disabled={importMutation.isPending}
          />
          <ExportButton label={t('sites.exportCsv')} onClick={handleExport} />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleImportFile}
          />
          <CreateButton
            label={t('sites.addSite')}
            onClick={() => {
              void navigate('/sites/new');
            }}
          />
        </div>
      </div>

      {importMutation.isSuccess && (
        <Card>
          <CardContent className="p-3 text-sm space-y-1">
            <p className="font-medium">{t('sites.importResults')}</p>
            {importMutation.data.sitesCreated > 0 && (
              <p>{t('sites.sitesCreated', { count: importMutation.data.sitesCreated })}</p>
            )}
            {importMutation.data.sitesUpdated > 0 && (
              <p>{t('sites.sitesUpdated', { count: importMutation.data.sitesUpdated })}</p>
            )}
            {importMutation.data.stationsCreated > 0 && (
              <p>{t('sites.stationsCreated', { count: importMutation.data.stationsCreated })}</p>
            )}
            {importMutation.data.stationsUpdated > 0 && (
              <p>{t('sites.stationsUpdated', { count: importMutation.data.stationsUpdated })}</p>
            )}
            {importMutation.data.evsesCreated > 0 && (
              <p>{t('sites.evsesCreated', { count: importMutation.data.evsesCreated })}</p>
            )}
            {importMutation.data.evsesUpdated > 0 && (
              <p>{t('sites.evsesUpdated', { count: importMutation.data.evsesUpdated })}</p>
            )}
            {importMutation.data.connectorsCreated > 0 && (
              <p>
                {t('sites.connectorsCreated', { count: importMutation.data.connectorsCreated })}
              </p>
            )}
            {importMutation.data.connectorsUpdated > 0 && (
              <p>
                {t('sites.connectorsUpdated', { count: importMutation.data.connectorsUpdated })}
              </p>
            )}
            {importMutation.data.errors.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-destructive">
                  {t('sites.importErrors')} ({importMutation.data.errors.length})
                </summary>
                <ul className="mt-1 list-disc pl-4 text-destructive">
                  {importMutation.data.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('sites.searchPlaceholder')}
        />
        <InfoTooltip content={t('sites.searchHint')} />
        <ResponsiveFilters
          activeCount={[locationFilter, loadManagementFilter].filter(Boolean).length}
        >
          <Select
            aria-label="Filter by location"
            value={locationFilter}
            onChange={(e) => {
              setLocationFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 w-[calc(50%-0.5rem)] sm:w-auto"
          >
            <option value="">{t('sites.allLocations')}</option>
            {filterOptions?.locations.map((loc) => (
              <option key={`${loc.city}|${loc.state}`} value={`${loc.city}|${loc.state}`}>
                {loc.city}, {loc.state}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by load management"
            value={loadManagementFilter}
            onChange={(e) => {
              setLoadManagementFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 w-[calc(50%-0.5rem)] sm:w-auto"
          >
            <option value="">{t('sites.allLoadMgmt')}</option>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sites.siteName')}</TableHead>
              <TableHead>{t('sites.siteId')}</TableHead>
              <TableHead>{t('sites.location')}</TableHead>
              <TableHead>{t('nav.stations')}</TableHead>
              <TableHead>{t('sites.powerDraw')}</TableHead>
              <TableHead>{t('sites.loadManagement')}</TableHead>
              <TableHead>{t('common.created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7}>
                  <TableSkeleton columns={7} rows={5} />
                </TableCell>
              </TableRow>
            )}
            {sites?.map((site) => (
              <TableRow
                key={site.id}
                data-testid={`site-row-${site.id}`}
                className="cursor-pointer"
                onClick={() => {
                  void navigate(`/sites/${site.id}`);
                }}
              >
                <TableCell className="font-medium text-primary" data-testid="row-click-target">
                  {site.name}
                </TableCell>
                <TableCell>
                  <CopyableId id={site.id} variant="table" />
                </TableCell>
                <TableCell>{formatLocation(site)}</TableCell>
                <TableCell>{site.stationCount}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium">{Number(site.totalDrawKw).toFixed(1)} kW</span>
                    {site.maxPowerKw != null && Number(site.maxPowerKw) > 0 && (
                      <span className="text-muted-foreground">/ {Number(site.maxPowerKw)} kW</span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={site.loadManagementEnabled ? 'default' : 'outline'}>
                    {site.loadManagementEnabled ? t('common.yes') : t('common.no')}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(site.createdAt, timezone)}</TableCell>
              </TableRow>
            ))}
            {sites?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t('sites.noSitesFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-sm md:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('sites.importConfirmTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm">
              {t('sites.importConfirmMessage', {
                count: importRows.length,
                filename: importFilename,
              })}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={updateExisting}
                onChange={(e) => {
                  setUpdateExisting(e.target.checked);
                }}
                className="h-4 w-4 rounded border-input"
              />
              <span>{t('sites.updateExisting')}</span>
            </label>
            <p className="text-xs text-muted-foreground">{t('sites.updateExistingDescription')}</p>
          </div>
          <DialogFooter>
            <CancelButton
              onClick={() => {
                setImportDialogOpen(false);
              }}
            />
            <Button onClick={handleImportConfirm} disabled={importMutation.isPending}>
              {importMutation.isPending ? t('sites.importing') : t('sites.importCsv')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (inQuotes) {
      if (char === '"' && line.charAt(i + 1) === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
