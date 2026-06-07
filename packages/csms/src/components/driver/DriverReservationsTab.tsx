// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

interface DriverReservation {
  id: string;
  reservationId: number;
  stationId: string;
  stationOcppId: string;
  siteName: string | null;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancelNote: string | null;
  cancellationFeeCents: number;
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  scheduled: 'outline',
  active: 'warning',
  in_use: 'success',
  used: 'success',
  cancelled: 'secondary',
  expired: 'destructive',
};

interface Props {
  driverId: string;
  timezone: string;
}

export function DriverReservationsTab({ driverId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['drivers', driverId, 'reservations', page],
    queryFn: () =>
      api.get<{ data: DriverReservation[]; total: number }>(
        `/v1/drivers/${driverId}/reservations?page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: driverId !== '',
  });

  const totalPages = data != null ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  const reservations = data?.data ?? [];

  function formatCancelReason(r: DriverReservation): string {
    if (r.cancelledBy == null) return 'n/a';
    // i18next type config requires literal keys; build dynamic keys here.
    const actor: string = t(
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      `reservations.cancelledByActor.${r.cancelledBy}` as never,
    );
    const reason: string =
      r.cancelReason != null
        ? t(
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            `reservations.cancelReason.${r.cancelReason}` as never,
          )
        : '';
    const note = r.cancelNote != null && r.cancelNote.trim() !== '' ? ` (${r.cancelNote})` : '';
    return reason !== '' ? `${actor} - ${reason}${note}` : `${actor}${note}`;
  }

  function formatCents(cents: number): string {
    return cents > 0 ? `$${(cents / 100).toFixed(2)}` : 'n/a';
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reservations.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : reservations.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('reservations.noReservations')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('reservations.internalId')}</TableHead>
                    <TableHead>{t('reservations.reservationId')}</TableHead>
                    <TableHead>{t('reservations.station')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('reservations.startsAt')}</TableHead>
                    <TableHead>{t('reservations.expiresAt')}</TableHead>
                    <TableHead>{t('reservations.cancelReasonColumn')}</TableHead>
                    <TableHead className="text-right">
                      {t('reservations.cancellationFee')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reservations.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{r.id}</TableCell>
                      <TableCell className="font-medium">
                        <Link to={`/reservations/${r.id}`} className="text-primary hover:underline">
                          {String(r.reservationId)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.stationOcppId}
                        {r.siteName != null && (
                          <span className="text-muted-foreground"> - {r.siteName}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.startsAt != null ? formatDateTime(r.startsAt, timezone) : 'n/a'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(r.expiresAt, timezone)}
                      </TableCell>
                      <TableCell className="text-xs">{formatCancelReason(r)}</TableCell>
                      <TableCell className="text-xs text-right">
                        {formatCents(r.cancellationFeeCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
