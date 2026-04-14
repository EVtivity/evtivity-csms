// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SearchInput } from '@/components/search-input';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CreateButton } from '@/components/create-button';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { Link } from 'react-router-dom';
import { CopyableId } from '@/components/copyable-id';
import { TableSkeleton } from '@/components/TableSkeleton';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
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

interface Site {
  id: string;
  name: string;
}

interface Station {
  id: string;
  stationId: string;
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

export function Reservations(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [stationFilter, setStationFilter] = useState('');

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const { data: stations } = useQuery({
    queryKey: ['stations'],
    queryFn: () => api.get<{ data: Station[]; total: number }>('/v1/stations?limit=100'),
  });

  const {
    data: reservations,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Reservation>('reservations', '/v1/reservations', {
    status: statusFilter,
    siteId: siteFilter,
    stationId: stationFilter,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('reservations.title')}</h1>
        <CreateButton
          label={t('reservations.create')}
          onClick={() => {
            void navigate('/reservations/new');
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('reservations.searchPlaceholder')}
        />
        <InfoTooltip content={t('reservations.searchHint')} />
        <ResponsiveFilters
          activeCount={[siteFilter, stationFilter, statusFilter].filter((v) => v !== '').length}
        >
          <Select
            aria-label="Filter by site"
            value={siteFilter}
            onChange={(e) => {
              setSiteFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('reservations.allSites')}</option>
            {sites?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by station"
            value={stationFilter}
            onChange={(e) => {
              setStationFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('reservations.allStations')}</option>
            {stations?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.stationId}
              </option>
            ))}
          </Select>
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
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('reservations.stationName')}</TableHead>
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
                <TableCell colSpan={7}>
                  <TableSkeleton columns={7} rows={5} />
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
                <TableCell className="whitespace-nowrap">
                  <Link
                    to={`/stations/${r.stationId}`}
                    className="text-primary hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {r.siteName != null ? `${r.siteName} / ${r.stationOcppId}` : r.stationOcppId}
                  </Link>
                </TableCell>
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
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t('reservations.noReservations')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
