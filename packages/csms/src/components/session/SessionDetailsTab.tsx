// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Leaf, AlertTriangle } from 'lucide-react';
import { CopyableId } from '@/components/copyable-id';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { LoadingLogo } from '@/components/loading-logo';
import { formatNumber } from '@/lib/formatting';
import { sessionDisplayCostCents } from '@evtivity/lib/session-cost';
import {
  SessionVehicle,
  type SessionVehicleCapture,
  type SessionVehicleInfo,
} from '@/components/session/SessionVehicle';

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
  token: {
    id: string;
    idToken: string;
    tokenType: string;
    pncContract?: { id: number; pcid: string; status: 'active' | 'revoked' } | null;
  } | null;
  vehicle: SessionVehicleInfo | null;
  vehicleCapture?: SessionVehicleCapture | null;
  autocharge?: boolean;
  metadata: Record<string, unknown> | null;
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
    ['sessions', sessionId, 'transaction-events'],
    `/v1/sessions/${sessionId}/transaction-events`,
  );

  // reservationTokenMismatch is written by the TransactionEvent.Started
  // projection when reservation.token_id doesn't match the session's matched
  // token. Don't abort the session (the EV is already charging), but operators
  // need to see it.
  const reservationMismatch =
    session.metadata != null && typeof session.metadata === 'object'
      ? (session.metadata['reservationTokenMismatch'] as
          | { expected?: string | null; actual?: string | null }
          | undefined)
      : undefined;

  return (
    <div className="space-y-6">
      {reservationMismatch != null && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('sessions.reservationTokenMismatchTitle')}</AlertTitle>
          <AlertDescription>
            {t('sessions.reservationTokenMismatchDescription')}
            <div className="mt-2 text-xs">
              <div>
                {t('sessions.expectedToken')}: {reservationMismatch.expected ?? t('common.na')}
              </div>
              <div>
                {t('sessions.actualToken')}: {reservationMismatch.actual ?? t('common.na')}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {/* Overview */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sessions.overview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Row label={t('sessions.station')}>
              <Link to={`/stations/${session.stationId}`} className="text-link hover:underline">
                {session.siteName != null
                  ? `${session.siteName} / ${String(session.stationName)}`
                  : (session.stationName ?? t('common.na'))}
              </Link>
            </Row>
            <Row label={t('sessions.driver')}>
              {session.freeVend === true ? (
                <span className="text-muted-foreground">{t('sessions.freeVend')}</span>
              ) : session.driverName != null ? (
                <Link
                  to={`/drivers/${session.driverId ?? ''}`}
                  className="text-link hover:underline block"
                >
                  {session.driverName}
                </Link>
              ) : (
                t('common.na')
              )}
            </Row>
            <Row label={t('vehicles.vehicle')}>
              <SessionVehicle
                sessionId={sessionId}
                driverId={session.driverId}
                vehicle={session.vehicle}
                capture={session.vehicleCapture ?? null}
                autocharge={session.autocharge === true}
              />
            </Row>
            <Row label={t('sessions.started')}>
              {session.startedAt != null
                ? formatDateTime(session.startedAt, timezone)
                : t('common.na')}
            </Row>
            <Row label={t('sessions.ended')}>
              {session.endedAt != null ? formatDateTime(session.endedAt, timezone) : t('common.na')}
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
                ? t('sessions.energyKwh', {
                    value: formatNumber(session.energyDeliveredWh / 1000, 2),
                  })
                : t('common.na')}
            </Row>
            {session.co2AvoidedKg != null && (
              <Row label={t('sessions.co2AvoidedLabel')}>
                <span className="inline-flex items-center gap-1 text-success">
                  <Leaf className="h-4 w-4" />
                  {t('sessions.co2AvoidedValue', {
                    value: formatNumber(parseFloat(String(session.co2AvoidedKg)), 2),
                  })}
                </span>
              </Row>
            )}
            <Row label={t('payments.cost')}>
              {formatCents(sessionDisplayCostCents(session), currency)}
            </Row>
            {session.token != null && (
              <Row label={t('sessions.token')}>
                <Link to={`/tokens/${session.token.id}`} className="text-link hover:underline">
                  {session.token.idToken}
                </Link>
                <span className="ml-2 text-muted-foreground">{session.token.tokenType}</span>
              </Row>
            )}
            {session.token?.pncContract != null && (
              <Row label={t('sessions.pncContract')}>
                <span data-testid="session-pnc-contract">
                  {t('sessions.pncContractPcid', { pcid: session.token.pncContract.pcid })}
                </span>
                <Badge
                  variant={
                    session.token.pncContract.status === 'active' ? 'success' : 'destructive'
                  }
                  className="ml-2"
                >
                  {t(`drivers.pncContractStatus.${session.token.pncContract.status}`)}
                </Badge>
              </Row>
            )}
            <Row label={t('sessions.stoppedReason')}>{session.stoppedReason ?? t('common.na')}</Row>
            {session.reservationId != null && (
              <Row label={t('sessions.reservation')}>
                <Link
                  to={`/reservations/${session.reservationId}`}
                  className="text-link hover:underline"
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
                {t('sessions.eventCount', { count: txEventTotal })}
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
            <LoadingLogo size="inline" />
          ) : txEventData == null || txEventData.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('sessions.noTransactionEvents')}
            </p>
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
