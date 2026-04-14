// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CopyableId } from '@/components/copyable-id';
import { Pagination } from '@/components/ui/pagination';
import { formatDuration } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';

export interface Session {
  id: string;
  stationId: string;
  stationName: string | null;
  siteName: string | null;
  driverId: string | null;
  driverName: string | null;
  transactionId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  idleStartedAt: string | null;
  energyDeliveredWh: number | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string | null;
  freeVend: boolean | null;
  co2AvoidedKg: number | null;
}

function formatCost(session: Session): string {
  const cents = session.status === 'completed' ? session.finalCostCents : session.currentCostCents;
  if (cents == null) return '-';
  const currency = session.currency ?? 'USD';
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

interface SessionsTableProps {
  sessions: Session[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  isLoading?: boolean;
  emptyMessage?: string;
  hideStationName?: boolean;
  hideDriverName?: boolean;
}

export const SessionsTable = memo(function SessionsTable({
  sessions,
  page,
  totalPages,
  onPageChange,
  timezone,
  isLoading,
  emptyMessage,
  hideStationName = false,
  hideDriverName = false,
}: SessionsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const colCount = 9 - (hideStationName ? 1 : 0) - (hideDriverName ? 1 : 0);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {!hideStationName && <TableHead>{t('sessions.stationName')}</TableHead>}
              <TableHead>{t('sessions.sessionId')}</TableHead>
              {!hideDriverName && <TableHead>{t('sessions.driverName')}</TableHead>}
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('sessions.started')}</TableHead>
              <TableHead>{t('sessions.duration')}</TableHead>
              <TableHead className="text-right">{t('sessions.energy')}</TableHead>
              <TableHead className="text-right">{t('sessions.co2Avoided')}</TableHead>
              <TableHead className="text-right">{t('payments.cost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading === true && (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {sessions?.map((session) => (
              <TableRow
                key={session.id}
                className="cursor-pointer"
                data-testid={`session-row-${session.id}`}
                onClick={() => {
                  void navigate(`/sessions/${session.id}`);
                }}
              >
                {!hideStationName && (
                  <TableCell className="whitespace-nowrap">
                    <Link
                      to={`/stations/${session.stationId}`}
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      {session.siteName != null
                        ? `${session.siteName} / ${String(session.stationName)}`
                        : (session.stationName ?? '-')}
                    </Link>
                  </TableCell>
                )}
                <TableCell>
                  <CopyableId id={session.id} variant="table" />
                </TableCell>
                {!hideDriverName && (
                  <TableCell className="whitespace-nowrap">
                    {session.freeVend === true ? (
                      <span className="text-muted-foreground">{t('sessions.freeVend')}</span>
                    ) : session.driverName != null ? (
                      <Link
                        to={`/drivers/${session.driverId ?? ''}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {session.driverName}
                      </Link>
                    ) : (
                      '--'
                    )}
                  </TableCell>
                )}
                <TableCell data-testid="row-click-target">
                  <Badge
                    variant={sessionStatusVariant(
                      session.status,
                      session.status === 'active' && session.idleStartedAt != null,
                    )}
                  >
                    {session.status === 'active' && session.idleStartedAt != null
                      ? t('status.idle')
                      : session.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {session.startedAt != null ? formatDateTime(session.startedAt, timezone) : '-'}
                </TableCell>
                <TableCell>{formatDuration(session.startedAt, session.endedAt)}</TableCell>
                <TableCell className="text-right">
                  {session.energyDeliveredWh != null
                    ? t('sessions.energyKwh', {
                        value: (session.energyDeliveredWh / 1000).toFixed(2),
                      })
                    : '-'}
                </TableCell>
                <TableCell className="text-right">
                  {session.co2AvoidedKg != null ? (
                    <span className="text-success">
                      {parseFloat(String(session.co2AvoidedKg)).toFixed(2)} kg
                    </span>
                  ) : (
                    '--'
                  )}
                </TableCell>
                <TableCell className="text-right">{formatCost(session)}</TableCell>
              </TableRow>
            ))}
            {sessions?.length === 0 && (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center text-muted-foreground">
                  {emptyMessage ?? t('sessions.noSessionsFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
});
