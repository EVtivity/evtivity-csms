// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The fleet Departures tab: the upcoming departures of the next 7 days and the
// weekly schedules. It shows whether depot charging planning is on or off, so a
// depot enters schedules before planning starts; while it is off the planner
// columns show a dash. Times are the depot's local time.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info, X } from 'lucide-react';
import { TabPanel } from '@/components/ui/tab-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { ImportButton } from '@/components/import-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, TableStateRow } from '@/components/ui/content-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDepotTime, formatLocalTime, isoWeekdayNames } from '@/lib/depot-time';
import { formatNumber } from '@/lib/formatting';
import { DepartureScheduleDialog } from './DepartureScheduleDialog';
import { DepartureDialog } from './DepartureDialog';
import { DepartureImportDialog } from './DepartureImportDialog';
import { DepartureSourceBadge } from './DepartureSourceBadge';
import {
  DEPARTURE_STATUS_FILTERS,
  cancelReasonLabel,
  deliveredOfTarget,
  departureTimeLabel,
  fleetDepartureKeys,
  isDepartureEditable,
  readinessVariant,
  targetWithMaxLabel,
  vehicleLabel,
  type Departure,
  type DepartureSchedule,
  type DepartureStatus,
  type DepotSite,
  type FleetVehicleOption,
} from './departure-types';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';

/**
 * The sort keys of `GET /v1/fleets/:id/departure-schedules` (`departureScheduleListSort` in
 * the API). The departures table above keeps its departure-time order: one sort per tab.
 */
const SCHEDULE_SORT_KEYS = ['departureTime', 'priority', 'depot'] as const;
type ScheduleSortKey = (typeof SCHEDULE_SORT_KEYS)[number];

const PAGE_SIZE = 10;
const NOT_PLANNED = '-';
const DAY_MS = 86_400_000;
/** Cancelled and completed departures list from 30 days back to 7 days ahead. */
const PAST_DAYS = 30;
const AHEAD_DAYS = 7;

/** The list request of a status: the default window for scheduled, else the past 30 days too. */
function departureListPath(
  fleetId: string,
  status: DepartureStatus,
  page: number,
  nowMs: number,
): string {
  const base = `/v1/fleets/${fleetId}/departures?status=${status}&page=${String(page)}&limit=${String(PAGE_SIZE)}`;
  if (status === 'scheduled') return base;
  const from = new Date(nowMs - PAST_DAYS * DAY_MS).toISOString();
  const to = new Date(nowMs + AHEAD_DAYS * DAY_MS).toISOString();
  return `${base}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

interface FleetDeparturesTabProps {
  fleetId: string;
}

export function FleetDeparturesTab({ fleetId }: FleetDeparturesTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasPermission('fleets:write');
  const { flags } = useFeatureFlags();
  const planning = flags.fleetChargingEnabled;

  const [departurePage, setDeparturePage] = useState(1);
  // The window of a past status starts when the status is picked, so the query key holds still.
  const [listFilter, setListFilter] = useState<{ status: DepartureStatus; nowMs: number }>({
    status: 'scheduled',
    nowMs: 0,
  });
  const [schedulePage, setSchedulePage] = useState(1);
  const [scheduleDialog, setScheduleDialog] = useState<{
    schedule: DepartureSchedule | null;
  } | null>(null);
  const [departureDialog, setDepartureDialog] = useState<{ departure: Departure | null } | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Departure | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DepartureSchedule | null>(null);

  const departures = useQuery({
    queryKey: [
      ...fleetDepartureKeys.departures(fleetId, departurePage),
      listFilter.status,
      listFilter.nowMs,
    ],
    queryFn: () =>
      api.get<{ data: Departure[]; total: number }>(
        departureListPath(fleetId, listFilter.status, departurePage, listFilter.nowMs),
      ),
  });
  const urlScheduleSort = useListSort(SCHEDULE_SORT_KEYS);
  // A new sort starts again at page 1.
  const scheduleSort: ListSort<ScheduleSortKey> = {
    ...urlScheduleSort,
    toggle: (key) => {
      setSchedulePage(1);
      urlScheduleSort.toggle(key);
    },
  };
  const scheduleSortQuery = new URLSearchParams(urlScheduleSort.params).toString();
  const schedules = useQuery({
    queryKey: [...fleetDepartureKeys.schedules(fleetId, schedulePage), urlScheduleSort.params],
    queryFn: () =>
      api.get<{ data: DepartureSchedule[]; total: number }>(
        `/v1/fleets/${fleetId}/departure-schedules?page=${String(schedulePage)}&limit=${String(PAGE_SIZE)}${
          scheduleSortQuery === '' ? '' : `&${scheduleSortQuery}`
        }`,
      ),
  });
  // The depots the dialogs offer, with their time zones for a new departure.
  const sites = useQuery({
    queryKey: ['sites', 'departure-options'],
    queryFn: () => api.get<{ data: DepotSite[]; total: number }>('/v1/sites?limit=100'),
    enabled: canWrite,
  });
  const vehicles = useQuery({
    queryKey: ['fleets', fleetId, 'vehicles', 'departure-options'],
    queryFn: () =>
      api.get<{ data: FleetVehicleOption[]; total: number }>(
        `/v1/fleets/${fleetId}/vehicles?page=1&limit=100`,
      ),
    enabled: canWrite,
  });

  const siteList = sites.data?.data ?? [];
  const vehicleList = vehicles.data?.data ?? [];
  const weekdays = isoWeekdayNames();

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/v1/departures/${id}/cancel`, {}),
    onSuccess: () => {
      toast({ title: t('fleets.departures.cancelled'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: fleetDepartureKeys.all(fleetId) });
      void queryClient.invalidateQueries({ queryKey: ['site-charging-plan'] });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/departure-schedules/${id}`),
    onSuccess: () => {
      toast({ title: t('fleets.departures.scheduleDeleted'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: fleetDepartureKeys.all(fleetId) });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  const departureRows = departures.data?.data ?? [];
  const scheduleRows = schedules.data?.data ?? [];
  const departurePages = Math.max(1, Math.ceil((departures.data?.total ?? 0) / PAGE_SIZE));
  const schedulePages = Math.max(1, Math.ceil((schedules.data?.total ?? 0) / PAGE_SIZE));

  return (
    <>
      <TabPanel
        title={t('fleets.departures.title')}
        description={t('fleets.departures.description')}
        actions={
          canWrite ? (
            <>
              <ImportButton
                label={t('fleets.departures.importCsv')}
                onClick={() => {
                  setImportOpen(true);
                }}
              />
              <CreateButton
                label={t('fleets.departures.addDeparture')}
                onClick={() => {
                  setDepartureDialog({ departure: null });
                }}
              />
            </>
          ) : undefined
        }
        bodyClassName="space-y-4"
        isLoading={departures.isLoading}
        isError={departures.isError}
        onRetry={() => {
          void departures.refetch();
        }}
      >
        {!planning && (
          <Alert variant="info" data-testid="departures-not-planned">
            <Info />
            <AlertDescription>{t('fleets.departures.notPlannedNotice')}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2 sm:max-w-xs">
          <Label htmlFor="departure-status-filter">{t('fleets.departures.statusFilter')}</Label>
          <Select
            id="departure-status-filter"
            value={listFilter.status}
            onChange={(e) => {
              setListFilter({ status: e.target.value as DepartureStatus, nowMs: Date.now() });
              setDeparturePage(1);
            }}
          >
            {DEPARTURE_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t(`fleets.departures.statuses.${status}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fleets.departures.departure')}</TableHead>
                <TableHead>{t('fleets.departures.source')}</TableHead>
                <TableHead>{t('fleets.departures.vehicle')}</TableHead>
                <TableHead>{t('fleets.departures.depot')}</TableHead>
                <TableHead>{t('fleets.departures.target')}</TableHead>
                <TableHead>{t('fleets.departures.state')}</TableHead>
                <TableHead>{t('fleets.departures.delivered')}</TableHead>
                <TableHead>{t('fleets.departures.predictedReady')}</TableHead>
                <TableHead>{t('fleets.departures.reason')}</TableHead>
                {canWrite && <TableHead className="text-right">{t('common.actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {departureRows.length === 0 && (
                <TableStateRow colSpan={canWrite ? 10 : 9}>
                  <EmptyState>
                    {listFilter.status === 'scheduled'
                      ? t('fleets.departures.noDepartures')
                      : t('fleets.departures.noDeparturesOfStatus', {
                          status: t(`fleets.departures.statuses.${listFilter.status}`),
                        })}
                  </EmptyState>
                </TableStateRow>
              )}
              {departureRows.map((d) => {
                const tz = d.siteTimezone ?? null;
                const scheduled = d.status === 'scheduled';
                const plannedHere = planning && scheduled;
                return (
                  <TableRow key={d.id} data-testid={`departure-row-${d.id}`}>
                    <TableCell>
                      <div className="whitespace-nowrap">{departureTimeLabel(t, d, tz)}</div>
                      {d.expectedArrivalAt != null && (
                        <div className="text-xs text-muted-foreground whitespace-nowrap">
                          {d.expectedArrivalSocPercent != null
                            ? t('fleets.departures.expectedArrivalWithSoc', {
                                time: formatDepotTime(d.expectedArrivalAt, tz),
                                soc: `${formatNumber(d.expectedArrivalSocPercent, 0)}%`,
                              })
                            : t('fleets.departures.expectedArrival', {
                                time: formatDepotTime(d.expectedArrivalAt, tz),
                              })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <DepartureSourceBadge departure={d} />
                    </TableCell>
                    <TableCell className="wrap-anywhere">{vehicleLabel(d.vehicle)}</TableCell>
                    <TableCell className="wrap-anywhere">{d.siteName ?? ''}</TableCell>
                    <TableCell className="whitespace-nowrap">{targetWithMaxLabel(t, d)}</TableCell>
                    <TableCell>
                      {!scheduled ? (
                        <Badge variant={d.status === 'cancelled' ? 'outline' : 'secondary'}>
                          {t(`fleets.departures.statuses.${d.status}`)}
                        </Badge>
                      ) : plannedHere && d.readiness != null ? (
                        <Badge variant={readinessVariant(d.readiness)}>
                          {t(`fleets.departures.readiness.${d.readiness}`)}
                        </Badge>
                      ) : (
                        NOT_PLANNED
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{deliveredOfTarget(t, d)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {plannedHere && d.predictedReadyAt != null
                        ? formatDepotTime(d.predictedReadyAt, tz)
                        : NOT_PLANNED}
                      {plannedHere && d.predictedMaxReadyAt != null && (
                        <div className="text-xs text-muted-foreground">
                          {t('fleets.departures.predictedMaxReady', {
                            time: formatDepotTime(d.predictedMaxReadyAt, tz),
                          })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell data-testid={`departure-reason-${d.id}`}>
                      {d.status === 'cancelled'
                        ? cancelReasonLabel(t, d.cancelReason ?? null)
                        : plannedHere && d.readinessReason != null
                          ? t(`fleets.departures.reasons.${d.readinessReason}`)
                          : NOT_PLANNED}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        {!scheduled ? null : !isDepartureEditable(d) ? (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`departure-managed-${d.id}`}
                          >
                            {t('fleets.departures.managedByDepotSystem')}
                          </span>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <EditIconButton
                              title={t('fleets.departures.editDeparture')}
                              onClick={() => {
                                setDepartureDialog({ departure: d });
                              }}
                            />
                            <RemoveIconButton
                              title={t('fleets.departures.cancelDeparture')}
                              onClick={() => {
                                setCancelTarget(d);
                              }}
                            />
                          </div>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <Pagination
          page={departurePage}
          totalPages={departurePages}
          onPageChange={setDeparturePage}
        />
      </TabPanel>

      <TabPanel
        title={t('fleets.departures.weeklySchedules')}
        description={t('fleets.departures.weeklySchedulesDescription')}
        actions={
          canWrite ? (
            <CreateButton
              label={t('fleets.departures.addSchedule')}
              onClick={() => {
                setScheduleDialog({ schedule: null });
              }}
            />
          ) : undefined
        }
        bodyClassName="space-y-4"
        isLoading={schedules.isLoading}
        isError={schedules.isError}
        onRetry={() => {
          void schedules.refetch();
        }}
        isEmpty={scheduleRows.length === 0}
        emptyMessage={t('fleets.departures.noSchedules')}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fleets.departures.vehicle')}</TableHead>
                <TableHead>{t('fleets.departures.days')}</TableHead>
                <SortableTableHead sortKey="departureTime" sort={scheduleSort}>
                  {t('fleets.departures.departureTime')}
                </SortableTableHead>
                <TableHead>{t('fleets.departures.target')}</TableHead>
                <SortableTableHead sortKey="priority" sort={scheduleSort}>
                  {t('fleets.departures.priority')}
                </SortableTableHead>
                <SortableTableHead sortKey="depot" sort={scheduleSort}>
                  {t('fleets.departures.depot')}
                </SortableTableHead>
                {canWrite && <TableHead className="text-right">{t('common.actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduleRows.map((s) => (
                <TableRow key={s.id} data-testid={`departure-schedule-row-${s.id}`}>
                  <TableCell className="wrap-anywhere">
                    {vehicleLabel(s.vehicle)}
                    {!s.isActive && (
                      <Badge variant="outline" className="ml-2">
                        {t('fleets.departures.paused')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {[...s.daysOfWeek]
                      .sort((a, b) => a - b)
                      .map((d) => weekdays[d - 1])
                      .join(', ')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatLocalTime(s.departureTime)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{targetWithMaxLabel(t, s)}</TableCell>
                  <TableCell>{String(s.priority)}</TableCell>
                  <TableCell className="wrap-anywhere">{s.siteName ?? ''}</TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <EditIconButton
                          title={t('fleets.departures.editSchedule')}
                          onClick={() => {
                            setScheduleDialog({ schedule: s });
                          }}
                        />
                        <RemoveIconButton
                          title={t('fleets.departures.deleteSchedule')}
                          onClick={() => {
                            setDeleteTarget(s);
                          }}
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Pagination page={schedulePage} totalPages={schedulePages} onPageChange={setSchedulePage} />
      </TabPanel>

      {canWrite && (
        <>
          <DepartureScheduleDialog
            fleetId={fleetId}
            open={scheduleDialog != null}
            onOpenChange={(open) => {
              if (!open) setScheduleDialog(null);
            }}
            schedule={scheduleDialog?.schedule ?? null}
            vehicles={vehicleList}
            sites={siteList}
          />
          <DepartureDialog
            fleetId={fleetId}
            open={departureDialog != null}
            onOpenChange={(open) => {
              if (!open) setDepartureDialog(null);
            }}
            departure={departureDialog?.departure ?? null}
            vehicles={vehicleList}
            sites={siteList}
          />
          <DepartureImportDialog fleetId={fleetId} open={importOpen} onOpenChange={setImportOpen} />
        </>
      )}

      <ConfirmDialog
        open={cancelTarget != null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title={t('fleets.departures.cancelDeparture')}
        description={t('fleets.departures.confirmCancel')}
        confirmLabel={t('fleets.departures.cancelDeparture')}
        confirmIcon={<X className="h-4 w-4" />}
        cancelLabel={t('fleets.departures.keepDeparture')}
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (cancelTarget != null) cancelMutation.mutate(cancelTarget.id);
          setCancelTarget(null);
        }}
      />
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('fleets.departures.deleteSchedule')}
        description={t('fleets.departures.confirmDeleteSchedule')}
        confirmLabel={t('common.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget != null) deleteMutation.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}
