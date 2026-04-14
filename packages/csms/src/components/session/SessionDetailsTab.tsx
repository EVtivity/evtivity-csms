// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Leaf } from 'lucide-react';
import { CopyableId } from '@/components/copyable-id';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { Pagination } from '@/components/ui/pagination';
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
import { formatDateTime } from '@/lib/timezone';
import { eventTypeVariant } from '@/lib/status-variants';

interface TransactionEvent {
  id: number;
  eventType: string;
  seqNo: number;
  timestamp: string;
  triggerReason: string;
  offline: boolean;
}

interface SessionOverview {
  stationId: string;
  stationName: string | null;
  siteName: string | null;
  driverId: string | null;
  driverName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  idleStartedAt: string | null;
  energyDeliveredWh: number | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  status: string;
  stoppedReason: string | null;
  reservationId: string | null;
  freeVend: boolean | null;
  co2AvoidedKg: number | null;
  transactionId: string | null;
}

export interface SessionDetailsTabProps {
  session: SessionOverview;
  sessionId: string;
  currency: string;
  timezone: string;
  formatCents: (cents: number | null | undefined, currency: string) => string;
  formatDuration: (start: string | null, end: string | null) => string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 w-32">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function SessionDetailsTab({
  session,
  sessionId,
  currency,
  timezone,
  formatCents,
  formatDuration,
}: SessionDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();

  const {
    data: txEventData,
    isLoading: txEventLoading,
    page: txEventPage,
    totalPages: txEventTotalPages,
    setPage: setTxEventPage,
    total: txEventTotal,
  } = usePaginatedQuery<TransactionEvent>(
    'session-transaction-events',
    `/v1/sessions/${sessionId}/transaction-events`,
  );

  return (
    <div className="space-y-6">
      {/* Overview */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sessions.overview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Row label={t('sessions.station')}>
              <Link to={`/stations/${session.stationId}`} className="text-primary hover:underline">
                {session.siteName != null
                  ? `${session.siteName} / ${String(session.stationName)}`
                  : (session.stationName ?? '--')}
              </Link>
            </Row>
            <Row label={t('sessions.driver')}>
              {session.freeVend === true ? (
                <span className="text-muted-foreground">{t('sessions.freeVend')}</span>
              ) : session.driverName != null ? (
                <Link
                  to={`/drivers/${session.driverId ?? ''}`}
                  className="text-primary hover:underline"
                >
                  {session.driverName}
                </Link>
              ) : (
                '--'
              )}
            </Row>
            <Row label={t('sessions.started')}>
              {session.startedAt != null ? formatDateTime(session.startedAt, timezone) : '--'}
            </Row>
            <Row label={t('sessions.ended')}>
              {session.endedAt != null ? formatDateTime(session.endedAt, timezone) : '--'}
            </Row>
            {session.idleStartedAt != null && (
              <Row label={t('sessions.idleStartedAt')}>
                {formatDateTime(session.idleStartedAt, timezone)}
              </Row>
            )}
            <Row label={t('sessions.duration')}>
              {formatDuration(session.startedAt, session.endedAt)}
            </Row>
            <Row label={t('sessions.energy')}>
              {session.energyDeliveredWh != null
                ? `${(session.energyDeliveredWh / 1000).toFixed(2)} kWh`
                : '--'}
            </Row>
            {session.co2AvoidedKg != null && (
              <Row label={t('sessions.co2AvoidedLabel')}>
                <span className="inline-flex items-center gap-1 text-success">
                  <Leaf className="h-4 w-4" />
                  {parseFloat(String(session.co2AvoidedKg)).toFixed(2)} kg CO2 avoided
                </span>
              </Row>
            )}
            <Row label={t('payments.cost')}>
              {formatCents(
                session.status === 'completed' ? session.finalCostCents : session.currentCostCents,
                currency,
              )}
            </Row>
            <Row label={t('sessions.stoppedReason')}>{session.stoppedReason ?? '--'}</Row>
            {session.reservationId != null && (
              <Row label={t('sessions.reservation')}>
                <Link
                  to={`/reservations/${session.reservationId}`}
                  className="text-primary hover:underline"
                >
                  {session.reservationId}
                </Link>
              </Row>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Transaction Events */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('sessions.transactionEvents')}</CardTitle>
            {txEventTotal > 0 && (
              <span className="text-sm text-muted-foreground">
                {txEventTotal} {txEventTotal === 1 ? 'event' : 'events'}
              </span>
            )}
          </div>
          {session.transactionId != null && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>{t('sessions.transactionId')}:</span>
              <CopyableId id={session.transactionId} />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {txEventLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : txEventData == null || txEventData.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('sessions.noTransactionEvents')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('transactions.eventType')}</TableHead>
                      <TableHead>{t('transactions.seq')}</TableHead>
                      <TableHead>{t('transactions.triggerReason')}</TableHead>
                      <TableHead>{t('transactions.timestamp')}</TableHead>
                      <TableHead>{t('transactions.offline')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {txEventData.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>
                          <Badge variant={eventTypeVariant(event.eventType)}>
                            {event.eventType}
                          </Badge>
                        </TableCell>
                        <TableCell>{event.seqNo}</TableCell>
                        <TableCell>{event.triggerReason}</TableCell>
                        <TableCell>{formatDateTime(event.timestamp, timezone)}</TableCell>
                        <TableCell>{event.offline ? t('common.yes') : t('common.no')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={txEventPage}
                totalPages={txEventTotalPages}
                onPageChange={setTxEventPage}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
