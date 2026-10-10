// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
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
  const [entityType, setEntityType] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const limit = 25;

  // Debounce the only remaining free-text filter (entityId) so a 10-keystroke
  // input does not fire 10 audit queries. Selects (entityType, actor, action)
  // and date pickers commit immediately because they're click-driven.
  const [debouncedEntityId, setDebouncedEntityId] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedEntityId(entityId);
    }, 300);
    return () => {
      clearTimeout(t);
    };
  }, [entityId]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (entityType !== '') p.set('entityType', entityType);
    if (actor !== '') p.set('actor', actor);
    if (action !== '') p.set('action', action);
    if (debouncedEntityId !== '') p.set('entityId', debouncedEntityId);
    // Interpret the picked date in the operator's local timezone (no `Z`),
    // then convert to UTC ISO so the API filter aligns with the local day.
    if (from !== '') p.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to !== '') p.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    return p.toString();
  }, [page, entityType, actor, action, debouncedEntityId, from, to]);

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
    (from !== '' ? 1 : 0) +
    (to !== '' ? 1 : 0);

  const filters = (
    <>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.entityType', 'Entity type')}</Label>
        <Select
          aria-label={t('audit.entityType', 'Entity type')}
          className="h-10"
          value={entityType}
          onChange={(e) => {
            setEntityType(e.target.value);
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
          className="h-10"
          value={actor}
          onChange={(e) => {
            setActor(e.target.value);
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
          className="h-10"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
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
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.from', 'From')}</Label>
        <Input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="space-y-2">
        <Label className="leading-6">{t('audit.to', 'To')}</Label>
        <Input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
        />
      </div>
    </>
  );

  const clearAllFilters = (): void => {
    setEntityType('');
    setActor('');
    setAction('');
    setEntityId('');
    setFrom('');
    setTo('');
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
                    <TableRow key={`${row.entityType}-${String(row.id)}`}>
                      <TableCell className="whitespace-nowrap text-xs">
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
    </div>
  );
}
