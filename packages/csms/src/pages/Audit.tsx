// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { actorDisplay, AuditActorBadge, type AuditEntry } from '@/components/EntityHistoryTab';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_ENTITY_TYPES,
  auditActionLabel,
  auditActorLabel,
  auditEntityLabel,
} from '@/lib/audit-labels';
import { FilterPopover } from '@/components/FilterBar';
import { LogDateRangeFilter } from '@/components/LogDateRangeFilter';
import { useUrlDateRange } from '@/hooks/use-url-date-range';
import { AuditEntryDialog } from '@/components/audit/AuditEntryDialog';
import { LoadingLogo } from '@/components/loading-logo';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface AuditPage {
  data: AuditEntry[];
  total: number;
}

function formatTimestamp(iso: string, timezone: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d, timezone);
}

export function Audit(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [openEntry, setOpenEntry] = useState<AuditEntry | null>(null);
  // Every filter lives in the URL, so it survives Back, a reload and a shared link.
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType = searchParams.get('entityType') ?? '';
  const actor = searchParams.get('actor') ?? '';
  const action = searchParams.get('action') ?? '';
  const urlEntityId = searchParams.get('entityId') ?? '';
  const range = useUrlDateRange();
  const [entityId, setEntityId] = useState(urlEntityId);

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        () => {
          // From the URL as it is now, not `prev` (frontend/ui.md).
          const next = new URLSearchParams(window.location.search);
          if (value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const limit = 25;

  // Debounce the only free-text filter (entityId) so a 10-keystroke input
  // does not fire 10 audit queries. Selects and date pickers commit at once.
  useEffect(() => {
    if (entityId === urlEntityId) return;
    const timer = setTimeout(() => {
      setParam('entityId', entityId);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [entityId, urlEntityId, setParam]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (entityType !== '') p.set('entityType', entityType);
    if (actor !== '') p.set('actor', actor);
    if (action !== '') p.set('action', action);
    if (urlEntityId !== '') p.set('entityId', urlEntityId);
    for (const [key, value] of Object.entries(range.apiParams)) p.set(key, value);
    return p.toString();
  }, [page, entityType, actor, action, urlEntityId, range.apiParams]);

  const { data, isLoading, error } = useQuery<AuditPage>({
    queryKey: ['audit-global', queryString],
    queryFn: () => api.get<AuditPage>(`/v1/audit?${queryString}`),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const activeFilterCount =
    (entityType !== '' ? 1 : 0) +
    (actor !== '' ? 1 : 0) +
    (action !== '' ? 1 : 0) +
    (entityId !== '' ? 1 : 0) +
    (range.from !== '' ? 1 : 0) +
    (range.to !== '' ? 1 : 0);

  const filters = (
    <>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.entityType', 'Entity type')}</Label>
        <Select
          aria-label={t('audit.entityType', 'Entity type')}
          value={entityType}
          onChange={(e) => {
            setParam('entityType', e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('audit.all', 'All')}</option>
          {AUDIT_ENTITY_TYPES.map((tt) => (
            <option key={tt} value={tt}>
              {auditEntityLabel(t, tt)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.actor', 'Actor')}</Label>
        <Select
          aria-label={t('audit.actor', 'Actor')}
          value={actor}
          onChange={(e) => {
            setParam('actor', e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('audit.all', 'All')}</option>
          {AUDIT_ACTORS.map((a) => (
            <option key={a} value={a}>
              {auditActorLabel(t, a)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.action', 'Action')}</Label>
        <Select
          aria-label={t('audit.action', 'Action')}
          value={action}
          onChange={(e) => {
            setParam('action', e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('audit.all', 'All')}</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {auditActionLabel(t, a)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.entityId', 'Entity id')}</Label>
        <Input
          value={entityId}
          placeholder={t('audit.entityIdPlaceholder', 'sta_... / sit_... / etc')}
          onChange={(e) => {
            setEntityId(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <LogDateRangeFilter
        range={range}
        onChange={() => {
          setPage(1);
        }}
      />
    </>
  );

  const clearAllFilters = (): void => {
    setSearchParams(
      () => {
        const next = new URLSearchParams(window.location.search);
        for (const key of ['entityType', 'actor', 'action', 'entityId', 'from', 'to']) {
          next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
    setEntityId('');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('audit.title', 'Audit Log')}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              'audit.subtitle',
              'Every operator-initiated mutation across the system. Filter by entity, actor, action, or time range.',
            )}
          </p>
        </div>
        <div className="flex justify-end lg:hidden">
          <FilterPopover activeCount={activeFilterCount} onClearAll={clearAllFilters}>
            {filters}
          </FilterPopover>
        </div>
      </div>

      <Card className="hidden lg:block">
        <CardContent className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3 lg:grid-cols-6">
          {filters}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingLogo size="inline" />
          ) : error != null ? (
            <p className="p-6 text-center text-sm text-destructive">
              {t('audit.loadFailed', 'Failed to load audit log')}
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t('audit.noEntries', 'No audit entries match these filters')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('audit.when', 'When')}</TableHead>
                    <TableHead>{t('audit.entityType', 'Entity')}</TableHead>
                    <TableHead>{t('audit.entityId', 'ID')}</TableHead>
                    <TableHead>{t('audit.action', 'Action')}</TableHead>
                    <TableHead>{t('audit.actorType', 'Type')}</TableHead>
                    <TableHead>{t('audit.actor', 'Actor')}</TableHead>
                    <TableHead>{t('audit.notes', 'Notes')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow
                      key={`${row.entityType}-${String(row.id)}`}
                      className="cursor-pointer"
                      data-testid={`audit-row-${row.entityType}-${String(row.id)}`}
                      onClick={() => {
                        setOpenEntry(row);
                      }}
                    >
                      <TableCell
                        className="whitespace-nowrap text-xs"
                        data-testid="row-click-target"
                      >
                        {formatTimestamp(row.createdAt, timezone)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" title={row.entityType}>
                          {auditEntityLabel(t, row.entityType)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.entityId ?? row.entityIdSnapshot}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" title={row.action}>
                          {auditActionLabel(t, row.action)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <AuditActorBadge actor={row.actor} />
                      </TableCell>
                      <TableCell className="text-sm">{actorDisplay(row)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.notes ?? '--'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {totalPages > 1 ? (
            <div className="border-t p-3">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AuditEntryDialog
        entry={openEntry}
        onOpenChange={(open) => {
          if (!open) setOpenEntry(null);
        }}
      />
    </div>
  );
}
