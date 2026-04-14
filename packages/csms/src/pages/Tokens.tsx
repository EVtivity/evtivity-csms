// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useRef, useState } from 'react';
import { API_BASE_URL } from '@/lib/config';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { ImportButton } from '@/components/import-button';
import { ExportButton } from '@/components/export-button';
import { SearchInput } from '@/components/search-input';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { TokensTable, type Token } from '@/components/TokensTable';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

export function Tokens(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const { data: filterOptions } = useQuery({
    queryKey: ['tokens-filter-options'],
    queryFn: () => api.get<{ tokenTypes: string[] }>('/v1/tokens/filter-options'),
  });

  const {
    data: tokens,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Token>('tokens', '/v1/tokens', {
    tokenType: filterType,
    status: filterStatus,
  });

  const importMutation = useMutation({
    mutationFn: (
      rows: Array<{ idToken: string; tokenType: string; driverEmail?: string; isActive?: boolean }>,
    ) => api.post<{ imported: number; errors: string[] }>('/v1/tokens/import', { rows }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
  });

  function handleExport(): void {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    const url = `${API_BASE_URL}/v1/tokens/export${params}`;
    const link = document.createElement('a');
    link.href = url;
    void fetch(url, { credentials: 'include' })
      .then((res) => res.blob())
      .then((blob) => {
        link.href = URL.createObjectURL(blob);
        link.download = 'tokens.csv';
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

      const rows = lines.slice(1).map((line) => {
        const parts = parseCsvLine(line);
        const row: { idToken: string; tokenType: string; driverEmail?: string; isActive: boolean } =
          {
            idToken: parts[0] ?? '',
            tokenType: parts[1] ?? '',
            isActive: parts[3] !== 'false',
          };
        if (parts[2]) {
          row.driverEmail = parts[2];
        }
        return row;
      });

      importMutation.mutate(rows);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('tokens.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ImportButton
            label={importMutation.isPending ? t('tokens.importing') : t('tokens.importCsv')}
            onClick={() => {
              fileInputRef.current?.click();
            }}
            disabled={importMutation.isPending}
          />
          <ExportButton label={t('tokens.exportCsv')} onClick={handleExport} />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleImportFile}
          />
          <CreateButton
            label={t('tokens.addToken')}
            onClick={() => {
              void navigate('/tokens/new');
            }}
          />
        </div>
      </div>

      {importMutation.isSuccess && (
        <div className="rounded-md border p-3 text-sm">
          <p>{t('tokens.imported', { count: importMutation.data.imported })}</p>
          {importMutation.data.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-destructive">
                {t('tokens.importErrors')} ({importMutation.data.errors.length})
              </summary>
              <ul className="mt-1 list-disc pl-4 text-destructive">
                {importMutation.data.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('tokens.searchPlaceholder')}
        />
        <InfoTooltip content={t('tokens.searchHint')} />
        <ResponsiveFilters activeCount={[filterType, filterStatus].filter((v) => v !== '').length}>
          <Select
            aria-label="Filter by type"
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value);
            }}
            className="h-9 w-[calc(50%-0.5rem)] sm:w-auto"
          >
            <option value="">{t('tokens.allTypes')}</option>
            {filterOptions?.tokenTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
            }}
            className="h-9 w-[calc(50%-0.5rem)] sm:w-auto"
          >
            <option value="">{t('tokens.allStatuses')}</option>
            <option value="active">{t('common.active')}</option>
            <option value="inactive">{t('common.inactive')}</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <TokensTable
        tokens={tokens}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        timezone={timezone}
        isLoading={isLoading}
      />
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
