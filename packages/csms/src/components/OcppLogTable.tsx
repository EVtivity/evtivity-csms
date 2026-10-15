// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
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
  /**
   * The station message log's processing state: `queued` for a command held
   * in the offline command queue until the station reconnects (its id is the
   * queue row's), `processed` for a message exchanged with the station.
   */
  processingStatus?: 'processed' | 'queued';
}

/** A row key unique across log rows and queue rows, whose ids can be equal. */
function entryKey(entry: OcppLogEntry): string {
  return `${entry.processingStatus === 'queued' ? 'queued' : 'log'}-${String(entry.id)}`;
}

export interface OcppLogTableProps {
  title: string;
  entries: OcppLogEntry[];
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  emptyMessage: string;
  isLoading?: boolean;
  rowTestIdPrefix?: string;
  showStationColumn?: boolean;
  showResponseTimeColumn?: boolean;
  /** The Status column: Processed or Queued (entries carry `processingStatus`). */
  showProcessingStatusColumn?: boolean;
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
  isLoading = false,
  rowTestIdPrefix = 'ocpp-log-row',
  showStationColumn = false,
  showResponseTimeColumn = false,
  showProcessingStatusColumn = false,
  actions,
  actionFilter,
  onActionFilterChange,
}: OcppLogTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
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
                className="px-2 pr-8 text-xs"
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
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="h-6 w-6" />
          </div>
        ) : entries.length === 0 ? (
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
                    <TableHead>{t('common.type')}</TableHead>
                    {showProcessingStatusColumn && <TableHead>{t('common.status')}</TableHead>}
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
                    const key = entryKey(log);
                    const isQueued = log.processingStatus === 'queued';
                    const isExpanded = expandedKey === key;
                    const colCount =
                      4 +
                      (showStationColumn ? 1 : 0) +
                      (showProcessingStatusColumn ? 1 : 0) +
                      (showResponseTimeColumn ? 1 : 0);
                    return (
                      <Fragment key={key}>
                        <TableRow
                          className="cursor-pointer"
                          data-testid={`${rowTestIdPrefix}-${isQueued ? 'queued-' : ''}${String(log.id)}`}
                          onClick={() => {
                            setExpandedKey(isExpanded ? null : key);
                          }}
                        >
                          <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                            {formatDateTime(log.createdAt, timezone)}
                          </TableCell>
                          {showStationColumn && <TableCell>{log.stationOcppId ?? 'n/a'}</TableCell>}
                          <TableCell>
                            <span className="flex items-center gap-1">
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
                              className="text-[10px] leading-5 px-1.5 py-0"
                            >
                              {typeLabel}
                            </Badge>
                          </TableCell>
                          {showProcessingStatusColumn && (
                            <TableCell>
                              {isQueued ? (
                                <Badge variant="warning" title={t('ocppLogs.queuedHint')}>
                                  {t('ocppLogs.queued')}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">{t('ocppLogs.processed')}</Badge>
                              )}
                            </TableCell>
                          )}
                          {showResponseTimeColumn && (
                            <TableCell className="text-right">
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
