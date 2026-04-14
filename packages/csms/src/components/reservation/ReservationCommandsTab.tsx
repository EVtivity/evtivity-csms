// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface OcppCommand {
  id: number;
  stationOcppId: string | null;
  direction: 'inbound' | 'outbound';
  messageType: number;
  messageId: string;
  action: string | null;
  payload: Record<string, unknown> | null;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: string;
  responseTimeMs: number | null;
}

interface OcppCommandsResponse {
  data: OcppCommand[];
  total: number;
}

const MESSAGE_TYPE_LABELS: Record<number, string> = {
  2: 'CALL',
  3: 'RESULT',
  4: 'ERROR',
};

export interface ReservationCommandsTabProps {
  reservationId: string;
  timezone: string;
}

export function ReservationCommandsTab({
  reservationId,
  timezone,
}: ReservationCommandsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const limit = 20;

  const { data } = useQuery({
    queryKey: ['reservations', reservationId, 'commands', page],
    queryFn: () =>
      api.get<OcppCommandsResponse>(
        `/v1/reservations/${reservationId}/commands?page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: reservationId !== '',
  });

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (logs.length === 0 && page === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('reservations.commandLog')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('reservations.noCommands')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reservations.commandLog')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.timestamp')}</TableHead>
                <TableHead>{t('reservations.stationLabel')}</TableHead>
                <TableHead>{t('reservations.direction')}</TableHead>
                <TableHead>{t('reservations.action')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead className="text-right">{t('reservations.responseTime')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const isCsms = log.direction === 'outbound';
                const typeLabel = MESSAGE_TYPE_LABELS[log.messageType] ?? String(log.messageType);
                const isExpanded = expandedId === log.id;

                return (
                  <TableRow
                    key={log.id}
                    className="cursor-pointer"
                    data-testid={`reservation-command-row-${String(log.id)}`}
                    onClick={() => {
                      setExpandedId(isExpanded ? null : log.id);
                    }}
                  >
                    <TableCell className="whitespace-nowrap text-xs" data-testid="row-click-target">
                      {formatDateTime(log.createdAt, timezone)}
                    </TableCell>
                    <TableCell className="text-xs">{log.stationOcppId ?? '--'}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1 text-xs">
                        <span className="font-medium text-blue-600 dark:text-blue-400">CSMS</span>
                        {isCsms ? (
                          <ArrowRight className="h-3 w-3" />
                        ) : (
                          <ArrowLeft className="h-3 w-3" />
                        )}
                        <span>Station</span>
                      </span>
                    </TableCell>
                    <TableCell className="font-medium">{log.action ?? '--'}</TableCell>
                    <TableCell>
                      <Badge
                        variant={log.messageType === 4 ? 'destructive' : 'secondary'}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {typeLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {log.responseTimeMs != null ? `${String(log.responseTimeMs)}ms` : '--'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {logs.map((log) => {
          if (expandedId !== log.id) return null;
          return (
            <div key={`payload-${String(log.id)}`} className="mt-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground mb-1">Message ID: {log.messageId}</p>
              {log.errorCode != null && (
                <p className="text-xs text-destructive mb-1">
                  Error: {log.errorCode}
                  {log.errorDescription != null ? ` - ${log.errorDescription}` : ''}
                </p>
              )}
              {log.payload != null && Object.keys(log.payload).length > 0 && (
                <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto max-h-64">
                  {JSON.stringify(log.payload, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      </CardContent>
    </Card>
  );
}
