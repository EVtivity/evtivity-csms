// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';

export interface AuditEntry {
  id: number;
  entityType: string;
  entityId: string | null;
  entityIdSnapshot: string;
  action: string;
  actor: 'operator' | 'driver' | 'api_key' | 'system' | 'ocpp';
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  notes: string | null;
  createdAt: string;
}

export function actorDisplay(row: AuditEntry): string {
  if (row.actorName != null && row.actorName !== '') return row.actorName;
  if (row.actorLabel != null && row.actorLabel !== '') return row.actorLabel;
  if (row.actorUserId != null) return row.actorUserId;
  if (row.actorDriverId != null) return row.actorDriverId;
  if (row.actorApiKeyId != null) return row.actorApiKeyId;
  return '--';
}

interface AuditPage {
  data: AuditEntry[];
  total: number;
}

/**
 * Per-entity extra column. Rendered between the Actor and Notes columns.
 * Use this to surface entity-specific fields from the before/after JSONB
 * snapshot (e.g. reservation status transition, tariff price change).
 */
export interface AuditExtraColumn {
  /** Column header label. */
  header: string;
  /** Render function receiving the row. Return any React node. */
  render: (row: AuditEntry) => React.ReactNode;
  /** Optional Tailwind class for the cell. */
  className?: string;
}

interface Props {
  entityType: string;
  entityId: string;
  pageSize?: number;
  /** Entity-specific columns inserted between Actor and Notes. */
  extraColumns?: AuditExtraColumn[];
  /** When provided, renders a CardHeader/CardTitle above the audit table. Use when the History card stands alone (not inside a Tabs panel that already labels it). */
  title?: string;
}

function actorBadge(actor: AuditEntry['actor']): React.ReactNode {
  switch (actor) {
    case 'operator':
      return <Badge variant="info">operator</Badge>;
    case 'driver':
      return <Badge variant="secondary">driver</Badge>;
    case 'api_key':
      return <Badge variant="warning">api key</Badge>;
    case 'system':
      return <Badge variant="outline">system</Badge>;
    case 'ocpp':
      return <Badge variant="outline">ocpp</Badge>;
    default:
      return <Badge variant="outline">{actor}</Badge>;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function EntityHistoryTab({
  entityType,
  entityId,
  pageSize = 20,
  extraColumns = [],
  title,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery<AuditPage>({
    queryKey: ['audit', entityType, entityId, page, pageSize],
    queryFn: () =>
      api.get<AuditPage>(
        `/v1/audit/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}?page=${String(page)}&limit=${String(pageSize)}`,
      ),
    // Refetch every time the History tab mounts so operators see new entries
    // without manually reloading the page.
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card>
      {title != null && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="p-0">
        {isLoading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error != null ? (
          <p className="p-6 text-center text-sm text-destructive">
            {t('audit.loadFailed', 'Failed to load audit history')}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {t('audit.noEntries', 'No audit entries yet')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('audit.when', 'When')}</TableHead>
                  <TableHead>{t('audit.action', 'Action')}</TableHead>
                  <TableHead>{t('audit.actorType', 'Type')}</TableHead>
                  <TableHead>{t('audit.actor', 'Actor')}</TableHead>
                  {extraColumns.map((col) => (
                    <TableHead key={col.header}>{col.header}</TableHead>
                  ))}
                  <TableHead>{t('audit.notes', 'Notes')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatTimestamp(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.action}</Badge>
                    </TableCell>
                    <TableCell>{actorBadge(row.actor)}</TableCell>
                    <TableCell className="text-sm">{actorDisplay(row)}</TableCell>
                    {extraColumns.map((col) => (
                      <TableCell key={col.header} className={col.className ?? 'text-xs'}>
                        {col.render(row)}
                      </TableCell>
                    ))}
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
  );
}
