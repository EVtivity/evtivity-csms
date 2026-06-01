// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
import { TableSkeleton } from '@/components/TableSkeleton';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import type { BadgeProps } from '@/components/ui/badge';

interface MaintenanceEventRow {
  id: string;
  siteId: string;
  eventType: 'immediate' | 'one_off';
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string | null;
  reservationsCancelledCount: number;
  sessionsStoppedCount: number;
}

interface SiteRow {
  id: string;
  name: string;
}

function statusVariant(status: string): BadgeProps['variant'] {
  if (status === 'active') return 'warning';
  if (status === 'scheduled') return 'info';
  if (status === 'completed') return 'secondary';
  if (status === 'cancelled') return 'outline';
  return 'default';
}

const STATUS_I18N_KEY = {
  scheduled: 'maintenance.statusScheduled',
  active: 'maintenance.statusActive',
  completed: 'maintenance.statusCompleted',
  cancelled: 'maintenance.statusCancelled',
} as const;

export function Maintenance(): React.JSX.Element {
  const { t } = useTranslation();
  const tz = useUserTimezone();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [siteId, setSiteId] = useState<string>('');

  const { data: sitesData } = useQuery({
    queryKey: ['sites', 'all-for-filter'],
    queryFn: () => api.get<{ data: SiteRow[]; total: number }>('/v1/sites?limit=200'),
  });
  const sites = useMemo(() => sitesData?.data ?? [], [sitesData]);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '25');
    if (status !== '') params.set('status', status);
    if (siteId !== '') params.set('siteId', siteId);
    return params.toString();
  }, [page, status, siteId]);

  const { data, isLoading } = useQuery({
    queryKey: ['maintenance', { page, status, siteId }],
    queryFn: () =>
      api.get<{ data: MaintenanceEventRow[]; total: number }>(
        `/v1/maintenance/events?${queryParams}`,
      ),
  });

  const events = data?.data ?? [];
  const total = data?.total ?? 0;

  const siteNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sites) m.set(s.id, s.name);
    return m;
  }, [sites]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('maintenance.title')}</h1>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="m-status">{t('maintenance.statusFilter')}</Label>
              <Select
                id="m-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t('common.all')}</option>
                <option value="scheduled">{t('maintenance.statusScheduled')}</option>
                <option value="active">{t('maintenance.statusActive')}</option>
                <option value="completed">{t('maintenance.statusCompleted')}</option>
                <option value="cancelled">{t('maintenance.statusCancelled')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-site">{t('maintenance.siteFilter')}</Label>
              <Select
                id="m-site"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t('common.all')}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="overflow-x-auto">
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('maintenance.colSite')}</TableHead>
                <TableHead>{t('maintenance.colType')}</TableHead>
                <TableHead>{t('maintenance.colStatus')}</TableHead>
                <TableHead>{t('maintenance.colStart')}</TableHead>
                <TableHead>{t('maintenance.colEnd')}</TableHead>
                <TableHead className="text-right">{t('maintenance.colSessionsStopped')}</TableHead>
                <TableHead className="text-right">
                  {t('maintenance.colReservationsCancelled')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {t('maintenance.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{siteNameById.get(e.siteId) ?? e.siteId}</TableCell>
                    <TableCell>
                      {e.eventType === 'immediate'
                        ? t('maintenance.typeImmediate')
                        : t('maintenance.typeOneOff')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(e.status)}>
                        {t(STATUS_I18N_KEY[e.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(e.plannedStartAt, tz)}</TableCell>
                    <TableCell>{formatDateTime(e.plannedEndAt, tz)}</TableCell>
                    <TableCell className="text-right">{e.sessionsStoppedCount}</TableCell>
                    <TableCell className="text-right">{e.reservationsCancelledCount}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / 25))}
        onPageChange={setPage}
      />
    </div>
  );
}
