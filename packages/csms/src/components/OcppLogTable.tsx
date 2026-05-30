// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { formatDateTime } from '@/lib/timezone';

export interface OcppLogEntry {
  id: number;
  stationOcppId?: string | null;
  direction: 'inbound' | 'outbound';
  messageType: number;
  messageId: string;
  action: string | null;
  payload: Record<string, unknown> | null;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
  responseTimeMs?: number | null;
}

export interface OcppLogTableProps {
  title: string;
  entries: OcppLogEntry[];
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  emptyMessage: string;
  rowTestIdPrefix?: string;
  showStationColumn?: boolean;
  showResponseTimeColumn?: boolean;
  actions?: string[];
  actionFilter?: string;
  onActionFilterChange?: (action: string) => void;
}

const MESSAGE_TYPE_LABELS: Record<number, string> = {
  2: 'CALL',
  3: 'RESULT',
  4: 'ERROR',
};

export function OcppLogTable({
  title,
  entries,
  page,
  totalPages,
  onPageChange,
  timezone,
  emptyMessage,
  rowTestIdPrefix = 'ocpp-log-row',
  showStationColumn = false,
  showResponseTimeColumn = false,
  actions,
  actionFilter,
  onActionFilterChange,
}: OcppLogTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const showFilter = actions != null && onActionFilterChange != null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4">
          <CardTitle>{title}</CardTitle>
          {showFilter && (
            <div className="flex items-center gap-2">
              <Label htmlFor="ocpp-action-filter" className="text-sm font-normal whitespace-nowrap">
                {t('ocppLogs.filterAction')}
              </Label>
              <Select
                id="ocpp-action-filter"
                value={actionFilter ?? ''}
                onChange={(e) => {
                  onActionFilterChange(e.target.value);
                }}
                className="h-8 px-2 pr-8 text-xs"
              >
                <option value="">{t('ocppLogs.allActions')}</option>
                {actions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{emptyMessage}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.timestamp')}</TableHead>
                    {showStationColumn && <TableHead>{t('reservations.stationLabel')}</TableHead>}
                    <TableHead>{t('reservations.direction')}</TableHead>
                    <TableHead>{t('reservations.action')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    {showResponseTimeColumn && (
                      <TableHead className="text-right">{t('reservations.responseTime')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((log) => {
                    const isCsms = log.direction === 'outbound';
                    const typeLabel =
                      MESSAGE_TYPE_LABELS[log.messageType] ?? String(log.messageType);
                    const isExpanded = expandedId === log.id;
                    const colCount =
                      4 + (showStationColumn ? 1 : 0) + (showResponseTimeColumn ? 1 : 0);
                    return (
                      <Fragment key={log.id}>
                        <TableRow
                          className="cursor-pointer"
                          data-testid={`${rowTestIdPrefix}-${String(log.id)}`}
                          onClick={() => {
                            setExpandedId(isExpanded ? null : log.id);
                          }}
                        >
                          <TableCell
                            className="whitespace-nowrap text-xs"
                            data-testid="row-click-target"
                          >
                            {formatDateTime(log.createdAt, timezone)}
                          </TableCell>
                          {showStationColumn && (
                            <TableCell className="text-xs">{log.stationOcppId ?? 'n/a'}</TableCell>
                          )}
                          <TableCell>
                            <span className="flex items-center gap-1 text-xs">
                              <span className="font-medium text-blue-600 dark:text-blue-400">
                                CSMS
                              </span>
                              {isCsms ? (
                                <ArrowRight className="h-3 w-3" />
                              ) : (
                                <ArrowLeft className="h-3 w-3" />
                              )}
                              <span>Station</span>
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">{log.action ?? 'n/a'}</TableCell>
                          <TableCell>
                            <Badge
                              variant={log.messageType === 4 ? 'destructive' : 'secondary'}
                              className="text-[10px] px-1.5 py-0"
                            >
                              {typeLabel}
                            </Badge>
                          </TableCell>
                          {showResponseTimeColumn && (
                            <TableCell className="text-right text-xs">
                              {log.responseTimeMs != null
                                ? `${String(log.responseTimeMs)}ms`
                                : 'n/a'}
                            </TableCell>
                          )}
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={colCount} className="p-3">
                              <p className="text-xs text-muted-foreground mb-1">
                                Message ID: {log.messageId}
                              </p>
                              {log.errorCode != null && (
                                <p className="text-xs text-destructive mb-1">
                                  Error: {log.errorCode}
                                  {log.errorDescription != null ? ` - ${log.errorDescription}` : ''}
                                </p>
                              )}
                              {log.payload != null && Object.keys(log.payload).length > 0 && (
                                <pre className="text-xs bg-background rounded p-2 overflow-x-auto max-h-64">
                                  {JSON.stringify(log.payload, null, 2)}
                                </pre>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4">
              <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
