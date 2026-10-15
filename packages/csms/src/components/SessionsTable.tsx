// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { memo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDuration, formatNumber, formatCents } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { sessionStatusVariant } from '@/lib/status-variants';
import type { ColumnMeta, ColumnVisibility } from '@/lib/column-visibility';
import { LoadingLogo } from '@/components/loading-logo';
import { formatVehicleId } from '@evtivity/lib/vehicle-id';
import { sessionDisplayCostCents } from '@evtivity/lib/session-cost';

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
    key: 'vehicle',
    label: 'vehicles.vehicle',
    defaultVisible: true,
    defaultVisibleMobile: false,
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
  currency: string;
  freeVend: boolean | null;
  isGuestSession?: boolean;
  co2AvoidedKg: number | null;
  /** Operator re-bill of a session the CSMS could not end; 'manual' waits for billing outside the platform. */
  rebillStatus?: 'in_progress' | 'billed' | 'manual' | null;
  vehicleId?: string | null;
  vehicleName?: string | null;
  vehicleCapture?: { value: string; type: string; source: string } | null;
  autocharge?: boolean;
}

/**
 * The vehicle of a session row: the linked vehicle (with Autocharge when it
 * started the session), else the id the charger sent, marked as captured.
 */
function SessionVehicleCell({ session }: { session: Session }): React.JSX.Element {
  const { t } = useTranslation();
  if (session.vehicleName != null && session.vehicleName !== '') {
    return (
      <span className="inline-flex items-center gap-2">
        {session.vehicleName}
        {session.autocharge === true && <Badge variant="info">{t('vehicles.autocharge')}</Badge>}
      </span>
    );
  }
  if (session.vehicleCapture != null) {
    return (
      <span title={t('sessions.capturedFromCharger')}>
        <span className="font-mono">{formatVehicleId(session.vehicleCapture.value)}</span>{' '}
        <span className="text-xs text-muted-foreground">{t('sessions.captured')}</span>
      </span>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

function formatCost(session: Session): string {
  const cents = sessionDisplayCostCents(session);
  if (cents == null) return '-';
  return formatCents(cents, session.currency);
}

interface SessionsTableProps {
  sessions: Session[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  isLoading?: boolean;
  /** The list failed to load: shows the load error with a Retry button. */
  isError?: boolean;
  onRetry?: () => void;
  emptyMessage?: string;
  hideStationName?: boolean;
  hideDriverName?: boolean;
  visibility?: ColumnVisibility;
}

export const SessionsTable = memo(function SessionsTable({
  sessions,
  timezone,
  isLoading,
  isError = false,
  onRetry,
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
              {isVisible('vehicle') && <TableHead>{t('vehicles.vehicle')}</TableHead>}
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
            {isError && isLoading !== true && (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center">
                  <span className="text-destructive">{t('common.loadError')}</span>
                  {onRetry != null && (
                    <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
                      {t('common.retry')}
                    </Button>
                  )}
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
                      className="text-link hover:underline"
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
                        className="text-link hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {session.driverName}
                      </Link>
                    ) : (
                      t('common.na')
                    )}
                  </TableCell>
                )}
                {isVisible('vehicle') && (
                  <TableCell className="whitespace-nowrap">
                    <SessionVehicleCell session={session} />
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
                        : t(`status.${session.status}`, { defaultValue: session.status })}
                    </Badge>
                    {session.rebillStatus === 'manual' && (
                      <Badge variant="warning" className="ml-2">
                        {t('sessions.manualBilling')}
                      </Badge>
                    )}
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
                          value: formatNumber(session.energyDeliveredWh / 1000, 2),
                        })
                      : '-'}
                  </TableCell>
                )}
                {isVisible('co2Avoided') && (
                  <TableCell className="text-right">
                    {session.co2AvoidedKg != null ? (
                      <span className="text-success">
                        {t('sessions.co2Kg', {
                          value: formatNumber(parseFloat(String(session.co2AvoidedKg)), 2),
                        })}
                      </span>
                    ) : (
                      t('common.na')
                    )}
                  </TableCell>
                )}
                {isVisible('cost') && (
                  <TableCell className="text-right">{formatCost(session)}</TableCell>
                )}
              </TableRow>
            ))}
            {!isError && sessions?.length === 0 && (
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
