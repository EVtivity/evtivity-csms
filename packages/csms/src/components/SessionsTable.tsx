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
import { formatDuration } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';
import type { ColumnMeta, ColumnVisibility } from '@/lib/column-visibility';
import { LoadingLogo } from '@/components/loading-logo';

export const SESSIONS_COLUMNS: ColumnMeta[] = [
  {
    key: 'sessionId',
    label: 'sessions.sessionId',
    defaultVisible: true,
    defaultVisibleMobile: false,
    alwaysVisible: true,
  },
  {
    key: 'stationName',
    label: 'sessions.stationName',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  {
    key: 'driverName',
    label: 'sessions.driverName',
    defaultVisible: true,
    defaultVisibleMobile: true,
  },
  {
    key: 'guestSession',
    label: 'sessions.guestSession',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'status',
    label: 'common.status',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  { key: 'started', label: 'sessions.started', defaultVisible: true, defaultVisibleMobile: false },
  {
    key: 'duration',
    label: 'sessions.duration',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  { key: 'energy', label: 'sessions.energy', defaultVisible: true, defaultVisibleMobile: false },
  {
    key: 'co2Avoided',
    label: 'sessions.co2Avoided',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  { key: 'cost', label: 'payments.cost', defaultVisible: true, defaultVisibleMobile: true },
];

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
  isGuestSession?: boolean;
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
  visibility?: ColumnVisibility;
}

export const SessionsTable = memo(function SessionsTable({
  sessions,
  timezone,
  isLoading,
  emptyMessage,
  hideStationName = false,
  hideDriverName = false,
  visibility,
}: SessionsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isVisible = (key: string): boolean => visibility == null || visibility[key] !== false;
  const colCount = SESSIONS_COLUMNS.filter((c) => {
    if (c.key === 'stationName' && hideStationName) return false;
    if (c.key === 'driverName' && hideDriverName) return false;
    return isVisible(c.key);
  }).length;

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isVisible('sessionId') && <TableHead>{t('sessions.sessionId')}</TableHead>}
              {!hideStationName && isVisible('stationName') && (
                <TableHead>{t('sessions.stationName')}</TableHead>
              )}
              {!hideDriverName && isVisible('driverName') && (
                <TableHead>{t('sessions.driverName')}</TableHead>
              )}
              {isVisible('guestSession') && <TableHead>{t('sessions.guestSession')}</TableHead>}
              {isVisible('status') && <TableHead>{t('common.status')}</TableHead>}
              {isVisible('started') && <TableHead>{t('sessions.started')}</TableHead>}
              {isVisible('duration') && <TableHead>{t('sessions.duration')}</TableHead>}
              {isVisible('energy') && (
                <TableHead className="text-right">{t('sessions.energy')}</TableHead>
              )}
              {isVisible('co2Avoided') && (
                <TableHead className="text-right">{t('sessions.co2Avoided')}</TableHead>
              )}
              {isVisible('cost') && (
                <TableHead className="text-right">{t('payments.cost')}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading === true && (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center text-muted-foreground">
                  <LoadingLogo size="inline" />
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
                {isVisible('sessionId') && (
                  <TableCell className="text-muted-foreground">{session.id}</TableCell>
                )}
                {!hideStationName && isVisible('stationName') && (
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
                {!hideDriverName && isVisible('driverName') && (
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
                      'n/a'
                    )}
                  </TableCell>
                )}
                {isVisible('guestSession') && (
                  <TableCell>
                    {session.isGuestSession === true ? (
                      <Badge variant="info">{t('common.yes')}</Badge>
                    ) : (
                      <span className="text-muted-foreground">{t('common.no')}</span>
                    )}
                  </TableCell>
                )}
                {isVisible('status') && (
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
                )}
                {isVisible('started') && (
                  <TableCell>
                    {session.startedAt != null ? formatDateTime(session.startedAt, timezone) : '-'}
                  </TableCell>
                )}
                {isVisible('duration') && (
                  <TableCell>{formatDuration(session.startedAt, session.endedAt)}</TableCell>
                )}
                {isVisible('energy') && (
                  <TableCell className="text-right">
                    {session.energyDeliveredWh != null
                      ? t('sessions.energyKwh', {
                          value: (session.energyDeliveredWh / 1000).toFixed(2),
                        })
                      : '-'}
                  </TableCell>
                )}
                {isVisible('co2Avoided') && (
                  <TableCell className="text-right">
                    {session.co2AvoidedKg != null ? (
                      <span className="text-success">
                        {parseFloat(String(session.co2AvoidedKg)).toFixed(2)} kg
                      </span>
                    ) : (
                      'n/a'
                    )}
                  </TableCell>
                )}
                {isVisible('cost') && (
                  <TableCell className="text-right">{formatCost(session)}</TableCell>
                )}
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
    </>
  );
});
