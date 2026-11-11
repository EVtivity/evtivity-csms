// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
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
import { formatCents } from '@/lib/formatting';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';

/** The sort keys of `GET /v1/drivers/:id/reservations` (`driverReservationListSort` in the API). */
export const DRIVER_RESERVATION_SORT_KEYS = [
  'reservationId',
  'station',
  'status',
  'startsAt',
  'expiresAt',
  'cancellationFee',
] as const;

type DriverReservationSortKey = (typeof DRIVER_RESERVATION_SORT_KEYS)[number];

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
  const listSort = useListSort(DRIVER_RESERVATION_SORT_KEYS);
  // A new sort starts again at page 1.
  const sort: ListSort<DriverReservationSortKey> = {
    ...listSort,
    toggle: (key) => {
      setPage(1);
      listSort.toggle(key);
    },
  };
  const query = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    ...listSort.params,
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['drivers', driverId, 'reservations', page, listSort.params],
    queryFn: () =>
      api.get<{ data: DriverReservation[]; total: number }>(
        `/v1/drivers/${driverId}/reservations?${query.toString()}`,
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

  // Reservation rows carry no currency. The cancellation fee is charged in the
  // currency /v1/portal/features reports (same query as ReservationDetailsTab).
  const policyQuery = useQuery({
    queryKey: ['reservation-cancellation-policy'],
    queryFn: () =>
      api.get<{
        reservationCancellationFeeCents: number;
        reservationCancellationWindowMinutes: number;
        currency: string;
      }>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  const feeCurrency = policyQuery.data?.currency;

  function formatFee(cents: number): string {
    return cents > 0 && feeCurrency != null ? formatCents(cents, feeCurrency) : 'n/a';
  }

  return (
    <TabPanel
      title={t('reservations.title')}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      isEmpty={reservations.length === 0}
      emptyMessage={t('reservations.noReservations')}
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="reservationId" sort={sort}>
                {t('reservations.reservationId')}
              </SortableTableHead>
              <SortableTableHead sortKey="station" sort={sort}>
                {t('reservations.station')}
              </SortableTableHead>
              <SortableTableHead sortKey="status" sort={sort}>
                {t('common.status')}
              </SortableTableHead>
              <SortableTableHead sortKey="startsAt" sort={sort}>
                {t('reservations.startsAt')}
              </SortableTableHead>
              <SortableTableHead sortKey="expiresAt" sort={sort}>
                {t('reservations.expiresAt')}
              </SortableTableHead>
              <TableHead>{t('reservations.cancelReasonColumn')}</TableHead>
              <SortableTableHead sortKey="cancellationFee" sort={sort} className="text-right">
                {t('reservations.cancellationFee')}
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reservations.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  <Link to={`/reservations/${r.id}`} className="text-link hover:underline">
                    #{String(r.reservationId)}
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
                <TableCell className="text-xs">{formatDateTime(r.expiresAt, timezone)}</TableCell>
                <TableCell className="text-xs">{formatCancelReason(r)}</TableCell>
                <TableCell className="text-xs text-right">
                  {formatFee(r.cancellationFeeCents)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </TabPanel>
  );
}
