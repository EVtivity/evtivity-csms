// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface OcppLog {
  id: number;
  stationId: string;
  direction: 'inbound' | 'outbound';
  messageType: number;
  messageId: string;
  action: string | null;
  payload: Record<string, unknown> | null;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
}

interface OcppLogsResponse {
  data: OcppLog[];
  total: number;
  actions: string[];
}

interface OcppMessageLogProps {
  stationDbId: string;
  timezone: string;
}

const MESSAGE_TYPE_LABELS: Record<number, string> = {
  2: 'CALL',
  3: 'RESULT',
  4: 'ERROR',
};

export function OcppMessageLog({ stationDbId, timezone }: OcppMessageLogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const limit = 10;

  const { data } = useQuery({
    queryKey: ['stations', stationDbId, 'ocpp-logs', page, actionFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (actionFilter !== '') params.set('action', actionFilter);
      return api.get<OcppLogsResponse>(
        `/v1/stations/${stationDbId}/ocpp-logs?${params.toString()}`,
      );
    },
    refetchInterval: false,
  });

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const actions = data?.actions ?? [];
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t('ocppLogs.title')}</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="ocpp-action-filter" className="text-sm font-normal">
              {t('ocppLogs.filterAction')}
            </Label>
            <Select
              id="ocpp-action-filter"
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value);
                setPage(1);
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
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('ocppLogs.noMessages')}
          </p>
        ) : (
          <div className="space-y-1">
            {logs.map((log) => (
              <MessageRow key={log.id} log={log} timezone={timezone} />
            ))}
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}

function MessageRow({ log, timezone }: { log: OcppLog; timezone: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isCsms = isFromCsms(log);
  const typeLabel = MESSAGE_TYPE_LABELS[log.messageType] ?? String(log.messageType);

  return (
    <div
      className={`flex flex-col rounded-md border px-3 py-2 text-sm ${
        isCsms
          ? 'border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30'
          : 'border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30'
      }`}
    >
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left"
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <span className="font-medium text-blue-600 dark:text-blue-400">CSMS</span>
          {isCsms ? <ArrowRight className="h-3 w-3" /> : <ArrowLeft className="h-3 w-3" />}
          <span>Station</span>
        </span>
        <Badge
          variant={log.messageType === 4 ? 'destructive' : 'secondary'}
          className="text-[10px] px-1.5 py-0"
        >
          {typeLabel}
        </Badge>
        <span className="font-medium truncate">{log.action ?? '--'}</span>
        <span className="ml-auto text-xs text-muted-foreground shrink-0">
          {formatDateTime(log.createdAt, timezone)}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted-foreground">Message ID: {log.messageId}</p>
          {log.errorCode != null && (
            <p className="text-xs text-red-600">
              Error: {log.errorCode}{' '}
              {log.errorDescription != null ? `- ${log.errorDescription}` : ''}
            </p>
          )}
          {log.payload != null && Object.keys(log.payload).length > 0 && (
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto max-h-48">
              {JSON.stringify(log.payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function isFromCsms(log: OcppLog): boolean {
  // Outbound CALL = CSMS sending command to station
  // Outbound CALLRESULT/CALLERROR = CSMS responding to station
  // Inbound CALL = Station sending to CSMS
  // Inbound CALLRESULT/CALLERROR = Station responding to CSMS
  if (log.direction === 'outbound') return true;
  return false;
}
