// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
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
import { stationStatusVariant, stationStatusClassName } from '@/lib/status-variants';

interface MaintenanceEventDetail {
  id: string;
  siteId: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string | null;
}

interface FanoutStationRow {
  id: number;
  stationId: string | null;
  stationIdSnapshot: string;
  stationOcppId: string;
  phase: string;
  command: string;
  commandStatus: string;
  error: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  currentStatus: string | null;
  createdAt: string;
}

const STATUS_I18N_KEY = {
  scheduled: 'maintenance.statusScheduled',
  active: 'maintenance.statusActive',
  completed: 'maintenance.statusCompleted',
  cancelled: 'maintenance.statusCancelled',
} as const;

const PHASE_I18N_KEY = {
  enter: 'maintenance.phaseEnter',
  exit: 'maintenance.phaseExit',
  cancel: 'maintenance.phaseCancel',
  release: 'maintenance.phaseRelease',
  add: 'maintenance.phaseAdd',
  'remove-stations': 'maintenance.phaseRemoveStations',
  reassert: 'maintenance.phaseReassert',
} as const;

function phaseI18nKey(phase: string): (typeof PHASE_I18N_KEY)[keyof typeof PHASE_I18N_KEY] {
  return PHASE_I18N_KEY[(phase in PHASE_I18N_KEY ? phase : 'enter') as keyof typeof PHASE_I18N_KEY];
}

const COMMAND_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline'> = {
  accepted: 'success',
  scheduled: 'warning',
  rejected: 'destructive',
  failed: 'destructive',
  offline: 'outline',
};

const PAGE_SIZE = 25;

export function MaintenanceEventStations(): React.JSX.Element {
  const { siteId, eventId } = useParams<{ siteId: string; eventId: string }>();
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [phaseFilter, setPhaseFilter] = useState('');

  const { data: site } = useQuery({
    queryKey: ['sites', siteId],
    queryFn: () =>
      api.get<{ id: string; name: string; timezone: string }>(`/v1/sites/${siteId ?? ''}`),
    enabled: siteId != null,
  });
  const timezone = site?.timezone ?? 'UTC';

  const { data: event } = useQuery({
    queryKey: ['maintenance', 'event', siteId, eventId],
    queryFn: () =>
      api.get<MaintenanceEventDetail>(
        `/v1/sites/${siteId ?? ''}/maintenance/events/${eventId ?? ''}`,
      ),
    enabled: siteId != null && eventId != null,
  });

  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (phaseFilter !== '') params.set('phase', phaseFilter);

  const { data } = useQuery({
    queryKey: ['maintenance', 'event-stations', eventId, page, phaseFilter],
    queryFn: () =>
      api.get<{ data: FanoutStationRow[]; total: number }>(
        `/v1/sites/${siteId ?? ''}/maintenance/events/${eventId ?? ''}/stations?${params.toString()}`,
      ),
    enabled: siteId != null && eventId != null,
  });

  const rows = data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to={`/sites/${siteId ?? ''}?tab=maintenance`} />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold">{t('maintenance.stationResults')}</h1>
            {event != null && <Badge variant="outline">{t(STATUS_I18N_KEY[event.status])}</Badge>}
          </div>
          {eventId != null && <CopyableId id={eventId} />}
        </div>
      </div>

      {event != null && (
        <p className="text-sm text-muted-foreground">
          {formatDateTime(event.plannedStartAt, timezone)} —{' '}
          {formatDateTime(event.plannedEndAt, timezone)}
          {event.reason != null && event.reason.length > 0 ? ` · ${event.reason}` : ''}
        </p>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('maintenance.stationResults')}</CardTitle>
          <Select
            aria-label={t('maintenance.filterByPhase')}
            className="h-9 w-auto"
            value={phaseFilter}
            onChange={(ev) => {
              setPhaseFilter(ev.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('maintenance.allPhases')}</option>
            {Object.entries(PHASE_I18N_KEY).map(([phase, key]) => (
              <option key={phase} value={phase}>
                {t(key)}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('maintenance.colStation')}</TableHead>
                  <TableHead>{t('maintenance.colPhase')}</TableHead>
                  <TableHead>{t('maintenance.colCommand')}</TableHead>
                  <TableHead>{t('maintenance.colResult')}</TableHead>
                  <TableHead>{t('maintenance.colError')}</TableHead>
                  <TableHead>{t('maintenance.colStatusChange')}</TableHead>
                  <TableHead>{t('maintenance.colCurrentStatus')}</TableHead>
                  <TableHead>{t('maintenance.colTime')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                      {t('maintenance.noStationResults')}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id} data-testid={`maintenance-station-row-${String(r.id)}`}>
                      <TableCell className="font-medium">{r.stationOcppId}</TableCell>
                      <TableCell>{t(phaseI18nKey(r.phase))}</TableCell>
                      <TableCell>{r.command}</TableCell>
                      <TableCell>
                        <Badge variant={COMMAND_STATUS_VARIANT[r.commandStatus] ?? 'outline'}>
                          {r.commandStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm" title={r.error ?? ''}>
                        {r.error != null && r.error.length > 0 ? (
                          r.error
                        ) : (
                          <span className="text-muted-foreground">{t('common.na')}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {r.statusBefore ?? t('common.na')} → {r.statusAfter ?? t('common.na')}
                      </TableCell>
                      <TableCell>
                        {r.currentStatus != null ? (
                          <Badge
                            variant={stationStatusVariant(r.currentStatus)}
                            className={stationStatusClassName(r.currentStatus)}
                          >
                            {t(`status.${r.currentStatus}`, r.currentStatus)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">{t('common.na')}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(r.createdAt, timezone)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}
