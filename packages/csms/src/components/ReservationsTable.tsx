// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/timezone';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { useState } from 'react';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { reservationStatusVariant } from '@/lib/status-variants';

interface Reservation {
  id: string;
  reservationId: number;
  stationId: string;
  stationOcppId: string;
  siteName: string | null;
  evseOcppId: number | null;
  driverId: string | null;
  driverFirstName: string | null;
  driverLastName: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
  sessionId: string | null;
}

function getStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'active':
      return t('reservations.active');
    case 'scheduled':
      return t('reservations.scheduled');
    case 'in_use':
      return t('reservations.in_use');
    case 'used':
      return t('reservations.used');
    case 'cancelled':
      return t('reservations.cancelled');
    case 'expired':
      return t('reservations.expired');
    default:
      return status;
  }
}

interface ReservationsTableProps {
  siteId?: string | undefined;
  stationId?: string | undefined;
  timezone: string;
  hideStationName?: boolean | undefined;
}

export function ReservationsTable({
  siteId,
  stationId,
  timezone,
  hideStationName,
}: ReservationsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');

  const extraParams: Record<string, string> = {};
  if (siteId != null) extraParams.siteId = siteId;
  if (stationId != null) extraParams.stationId = stationId;
  if (statusFilter !== '') extraParams.status = statusFilter;

  const {
    data: reservations,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<Reservation>('reservations', '/v1/reservations', extraParams);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>{t('reservations.title')}</CardTitle>
        <ResponsiveFilters activeCount={statusFilter ? 1 : 0}>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('reservations.allStatuses')}</option>
            <option value="scheduled">{t('reservations.scheduled')}</option>
            <option value="active">{t('reservations.active')}</option>
            <option value="in_use">{t('reservations.in_use')}</option>
            <option value="used">{t('reservations.used')}</option>
            <option value="cancelled">{t('reservations.cancelled')}</option>
            <option value="expired">{t('reservations.expired')}</option>
          </Select>
        </ResponsiveFilters>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {hideStationName !== true && <TableHead>{t('reservations.stationName')}</TableHead>}
                <TableHead>{t('reservations.reservationId')}</TableHead>
                <TableHead>{t('reservations.driverName')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('reservations.session')}</TableHead>
                <TableHead>{t('reservations.expiresAt')}</TableHead>
                <TableHead>{t('reservations.createdAt')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={hideStationName === true ? 6 : 7}
                    className="text-center text-muted-foreground"
                  >
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              )}
              {reservations?.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  data-testid={`reservation-row-${r.id}`}
                  onClick={() => {
                    void navigate(`/reservations/${r.id}`);
                  }}
                >
                  {hideStationName !== true && (
                    <TableCell className="whitespace-nowrap">
                      <Link
                        to={`/stations/${r.stationId}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {r.siteName != null
                          ? `${r.siteName} / ${r.stationOcppId}`
                          : r.stationOcppId}
                      </Link>
                    </TableCell>
                  )}
                  <TableCell>
                    <CopyableId id={r.id} variant="table" />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.driverFirstName != null ? (
                      <Link
                        to={`/drivers/${r.driverId ?? ''}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {r.driverFirstName} {r.driverLastName}
                      </Link>
                    ) : (
                      '--'
                    )}
                  </TableCell>
                  <TableCell data-testid="row-click-target">
                    <Badge variant={reservationStatusVariant(r.status)}>
                      {getStatusLabel(r.status, t as (key: string) => string)}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.sessionId != null ? (
                      <Link
                        to={`/sessions/${r.sessionId}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {r.sessionId}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(r.expiresAt, timezone)}</TableCell>
                  <TableCell>{formatDateTime(r.createdAt, timezone)}</TableCell>
                </TableRow>
              ))}
              {reservations?.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={hideStationName === true ? 6 : 7}
                    className="text-center text-muted-foreground"
                  >
                    {t('reservations.noReservations')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
