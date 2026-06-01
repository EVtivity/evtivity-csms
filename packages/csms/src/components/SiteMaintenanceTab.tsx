// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useToast } from '@/components/ui/toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { useHasPermission } from '@/lib/auth';

interface MaintenanceEvent {
  id: string;
  siteId: string;
  eventType: 'immediate' | 'one_off';
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  plannedStartAt: string;
  plannedEndAt: string;
  affectedStationIds: string[] | null;
  activeSessionPolicy: 'ignore' | 'stop_graceful';
  customMessage: string | null;
  reason: string | null;
  reservationsCancelledCount: number;
  sessionsStoppedCount: number;
}

interface StationPreviewRow {
  id: string;
  stationId: string;
  model: string | null;
  isOnline: boolean;
  hasActiveSession: boolean;
  activeSession: { id: string; transactionId: string | null; driverName: string | null } | null;
  upcomingReservationCount: number;
  upcomingReservations: Array<{
    id: string;
    startsAt: string | null;
    endsAt: string | null;
    driverName: string | null;
  }>;
}

interface StatusSummary {
  current: MaintenanceEvent | null;
  upcoming: MaintenanceEvent[];
}

interface Props {
  siteId: string;
  timezone: string;
}

const STATUS_I18N_KEY = {
  scheduled: 'maintenance.statusScheduled',
  active: 'maintenance.statusActive',
  completed: 'maintenance.statusCompleted',
  cancelled: 'maintenance.statusCancelled',
} as const;

type StationFilter = 'all' | 'charging' | 'reserved' | 'idle' | 'offline';

function toDatetimeLocal(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SiteMaintenanceTab({ siteId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('maintenance:write');

  const [createOpen, setCreateOpen] = useState(false);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const [mode, setMode] = useState<'immediate' | 'one_off'>('immediate');
  const [startsAt, setStartsAt] = useState<string>(() => {
    const d = new Date(Date.now() + 15 * 60 * 1000);
    return toDatetimeLocal(d);
  });
  const [endsAt, setEndsAt] = useState<string>(() => {
    const d = new Date(Date.now() + 75 * 60 * 1000);
    return toDatetimeLocal(d);
  });
  const [policy, setPolicy] = useState<'ignore' | 'stop_graceful'>('ignore');
  const [customMessage, setCustomMessage] = useState('');
  const [reason, setReason] = useState('');
  const [selectAllStations, setSelectAllStations] = useState(true);
  const [selectedStationIds, setSelectedStationIds] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const [stationSearch, setStationSearch] = useState('');
  const [stationFilter, setStationFilter] = useState<StationFilter>('all');
  // Stable timestamp for the "immediate" mode preview so the React Query key
  // doesn't change on every render and re-fire the network request forever.
  // Captured when the form opens and refreshed once per minute while open.
  const [immediateNow, setImmediateNow] = useState(() => new Date());

  useEffect(() => {
    if (!createOpen || mode !== 'immediate') return;
    setImmediateNow(new Date());
    const interval = setInterval(() => {
      setImmediateNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(interval);
    };
  }, [createOpen, mode]);

  const previewStart = mode === 'immediate' ? immediateNow : new Date(startsAt);
  const previewEnd = new Date(endsAt);
  const previewRangeValid =
    !Number.isNaN(previewStart.getTime()) &&
    !Number.isNaN(previewEnd.getTime()) &&
    previewEnd.getTime() > previewStart.getTime();

  const { data: previewData, isLoading: previewLoading } = useQuery({
    queryKey: [
      'maintenance',
      'station-preview',
      siteId,
      previewStart.toISOString(),
      previewEnd.toISOString(),
    ],
    queryFn: () =>
      api.get<StationPreviewRow[]>(
        `/v1/sites/${siteId}/maintenance/station-preview?startAt=${encodeURIComponent(previewStart.toISOString())}&endAt=${encodeURIComponent(previewEnd.toISOString())}`,
      ),
    enabled: createOpen && previewRangeValid,
  });
  const previewStations: StationPreviewRow[] = previewData ?? [];

  const visibleStations = useMemo(() => {
    const needle = stationSearch.trim().toLowerCase();
    return previewStations.filter((s) => {
      if (needle.length > 0) {
        const haystack = `${s.stationId} ${s.model ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      switch (stationFilter) {
        case 'charging':
          return s.hasActiveSession;
        case 'reserved':
          return s.upcomingReservationCount > 0;
        case 'idle':
          return !s.hasActiveSession && s.upcomingReservationCount === 0 && s.isOnline;
        case 'offline':
          return !s.isOnline;
        default:
          return true;
      }
    });
  }, [previewStations, stationSearch, stationFilter]);

  const effectiveSelected = selectAllStations
    ? new Set(previewStations.map((s) => s.id))
    : selectedStationIds;
  const impactedStations = previewStations.filter((s) => effectiveSelected.has(s.id));
  const totalSessions = impactedStations.filter((s) => s.hasActiveSession).length;
  const totalReservations = impactedStations.reduce(
    (sum, s) => sum + s.upcomingReservationCount,
    0,
  );
  const requiresAck = totalSessions > 0 || totalReservations > 0;

  const visibleIds = visibleStations.map((s) => s.id);
  const visibleSelectedCount = visibleIds.filter((id) => effectiveSelected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;

  function toggleVisible(checked: boolean): void {
    if (selectAllStations) setSelectAllStations(false);
    setSelectedStationIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        if (selectAllStations) {
          for (const s of previewStations) next.add(s.id);
        }
        for (const id of visibleIds) next.add(id);
      } else {
        for (const id of visibleIds) next.delete(id);
      }
      return next;
    });
  }

  const { data: allSiteStationsData } = useQuery({
    queryKey: ['sites', siteId, 'stations-for-maintenance'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; stationId: string }>; total: number }>(
        `/v1/stations?siteId=${siteId}&limit=100`,
      ),
  });
  const allSiteStations = useMemo(() => allSiteStationsData?.data ?? [], [allSiteStationsData]);
  const stationIdLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allSiteStations) m.set(s.id, s.stationId);
    return m;
  }, [allSiteStations]);

  function resolveEventStations(event: MaintenanceEvent): Array<{ id: string; stationId: string }> {
    if (event.affectedStationIds == null || event.affectedStationIds.length === 0) {
      return allSiteStations;
    }
    return event.affectedStationIds.map((id) => ({ id, stationId: stationIdLookup.get(id) ?? id }));
  }

  const { data: status } = useQuery({
    queryKey: ['maintenance', 'status', siteId],
    queryFn: () => api.get<StatusSummary>(`/v1/sites/${siteId}/maintenance/status`),
  });

  const [historyPage, setHistoryPage] = useState(1);
  const HISTORY_PAGE_SIZE = 10;

  const { data: listData } = useQuery({
    queryKey: ['maintenance', 'site-events', siteId, historyPage],
    queryFn: () =>
      api.get<{ data: MaintenanceEvent[]; total: number }>(
        `/v1/sites/${siteId}/maintenance/events?page=${String(historyPage)}&limit=${String(HISTORY_PAGE_SIZE)}`,
      ),
  });

  function resetForm(): void {
    setMode('immediate');
    setSelectAllStations(true);
    setSelectedStationIds(new Set());
    setAcknowledged(false);
    setStationSearch('');
    setStationFilter('all');
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.post(`/v1/sites/${siteId}/maintenance/events`, {
        eventType: mode,
        plannedStartAt:
          mode === 'immediate' ? new Date().toISOString() : new Date(startsAt).toISOString(),
        plannedEndAt: new Date(endsAt).toISOString(),
        affectedStationIds: selectAllStations ? null : Array.from(selectedStationIds),
        activeSessionPolicy: policy,
        customMessage: customMessage.length > 0 ? customMessage : null,
        reason: reason.length > 0 ? reason : null,
      }),
    onSuccess: () => {
      toast({ title: t('maintenance.createdToast'), variant: 'success' });
      setCreateOpen(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    },
    onError: (err: unknown) => {
      toast({
        title: t('maintenance.createFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/v1/sites/${siteId}/maintenance/events/${id}/cancel`, {}),
    onSuccess: () => {
      toast({ title: t('maintenance.cancelledToast'), variant: 'success' });
      setConfirmCancelId(null);
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    },
    onError: (err: unknown) => {
      toast({
        title: t('maintenance.cancelFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  const removeStationsMutation = useMutation({
    mutationFn: ({ eventId, stationIds }: { eventId: string; stationIds: string[] }) =>
      api.post(`/v1/sites/${siteId}/maintenance/events/${eventId}/remove-stations`, {
        stationIds,
      }),
    onSuccess: () => {
      toast({ title: t('maintenance.stationRemovedToast'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    },
    onError: (err: unknown) => {
      toast({
        title: t('maintenance.stationRemoveFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  const events = listData?.data ?? [];
  const historyTotal = listData?.total ?? 0;
  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const saveDisabled =
    createMutation.isPending ||
    !previewRangeValid ||
    (!selectAllStations && selectedStationIds.size === 0) ||
    (requiresAck && !acknowledged);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('maintenance.statusTitle')}</CardTitle>
          {canWrite && !createOpen && (
            <Button
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              {t('maintenance.schedule')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {status?.current != null ? (
            (() => {
              const cur = status.current;
              const stationCount = cur.affectedStationIds?.length ?? 0;
              const isAllStations = cur.affectedStationIds == null || stationCount === 0;
              return (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="font-semibold text-sm">{t('maintenance.activeNow')}</p>
                      <p className="text-xs">
                        {t('maintenance.endsAt', {
                          time: formatDateTime(cur.plannedEndAt, timezone),
                        })}
                      </p>
                    </div>
                    {canWrite && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setConfirmCancelId(cur.id);
                        }}
                      >
                        {t('maintenance.endNow')}
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="font-medium">{t('maintenance.scopeLabel')}:</span>{' '}
                      {isAllStations
                        ? t('maintenance.allStations')
                        : t('maintenance.nStations', { count: stationCount })}
                    </div>
                    <div>
                      <span className="font-medium">{t('maintenance.sessionPolicy')}:</span>{' '}
                      {cur.activeSessionPolicy === 'stop_graceful'
                        ? t('maintenance.policyStop')
                        : t('maintenance.policyIgnore')}
                    </div>
                    {cur.sessionsStoppedCount > 0 && (
                      <div>
                        <span className="font-medium">{t('maintenance.colSessionsStopped')}:</span>{' '}
                        {cur.sessionsStoppedCount}
                      </div>
                    )}
                    {cur.reservationsCancelledCount > 0 && (
                      <div>
                        <span className="font-medium">
                          {t('maintenance.colReservationsCancelled')}:
                        </span>{' '}
                        {cur.reservationsCancelledCount}
                      </div>
                    )}
                  </div>
                  {cur.reason != null && cur.reason.length > 0 && (
                    <p className="text-xs">
                      <span className="font-medium">{t('maintenance.reason')}:</span> {cur.reason}
                    </p>
                  )}
                  {cur.customMessage != null && cur.customMessage.length > 0 && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {cur.customMessage}
                    </p>
                  )}
                  <EventStationList
                    event={cur}
                    stations={resolveEventStations(cur)}
                    canWrite={canWrite}
                    removePending={removeStationsMutation.isPending}
                    onRemove={(stationId) => {
                      removeStationsMutation.mutate({ eventId: cur.id, stationIds: [stationId] });
                    }}
                  />
                </div>
              );
            })()
          ) : (
            <p className="text-sm text-muted-foreground">{t('maintenance.noneActive')}</p>
          )}

          {(status?.upcoming.length ?? 0) > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('maintenance.upcoming')}</p>
              <ul className="space-y-2">
                {status?.upcoming.map((u) => {
                  const stationCount = u.affectedStationIds?.length ?? 0;
                  const isAllStations = u.affectedStationIds == null || stationCount === 0;
                  const durationMinutes = Math.max(
                    0,
                    Math.round(
                      (new Date(u.plannedEndAt).getTime() - new Date(u.plannedStartAt).getTime()) /
                        60_000,
                    ),
                  );
                  return (
                    <li key={u.id} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="text-sm font-medium">
                            {formatDateTime(u.plannedStartAt, timezone)} →{' '}
                            {formatDateTime(u.plannedEndAt, timezone)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t('maintenance.durationLabel', { minutes: durationMinutes })}
                          </div>
                        </div>
                        {canWrite && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setConfirmCancelId(u.id);
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="font-medium">{t('maintenance.scopeLabel')}:</span>{' '}
                          {isAllStations
                            ? t('maintenance.allStations')
                            : t('maintenance.nStations', { count: stationCount })}
                        </div>
                        <div>
                          <span className="font-medium">{t('maintenance.sessionPolicy')}:</span>{' '}
                          {u.activeSessionPolicy === 'stop_graceful'
                            ? t('maintenance.policyStop')
                            : t('maintenance.policyIgnore')}
                        </div>
                        <div>
                          <span className="font-medium">{t('maintenance.colType')}:</span>{' '}
                          {u.eventType === 'immediate'
                            ? t('maintenance.typeImmediate')
                            : t('maintenance.typeOneOff')}
                        </div>
                      </div>
                      {u.reason != null && u.reason.length > 0 && (
                        <p className="text-xs">
                          <span className="font-medium">{t('maintenance.reason')}:</span> {u.reason}
                        </p>
                      )}
                      {u.customMessage != null && u.customMessage.length > 0 && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {u.customMessage}
                        </p>
                      )}
                      <EventStationList
                        event={u}
                        stations={resolveEventStations(u)}
                        canWrite={canWrite}
                        removePending={removeStationsMutation.isPending}
                        onRemove={(stationId) => {
                          removeStationsMutation.mutate({
                            eventId: u.id,
                            stationIds: [stationId],
                          });
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <Card>
          <CardHeader>
            <CardTitle>{t('maintenance.schedule')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('maintenance.mode')}</Label>
                  <div className="flex items-center gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="m-mode"
                        checked={mode === 'immediate'}
                        onChange={() => {
                          setMode('immediate');
                        }}
                      />
                      {t('maintenance.modeNow')}
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="m-mode"
                        checked={mode === 'one_off'}
                        onChange={() => {
                          setMode('one_off');
                        }}
                      />
                      {t('maintenance.modeScheduled')}
                    </label>
                  </div>
                </div>

                {mode === 'one_off' && (
                  <div className="space-y-2">
                    <Label htmlFor="m-starts">{t('maintenance.start')}</Label>
                    <Input
                      id="m-starts"
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => {
                        setStartsAt(e.target.value);
                      }}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="m-ends">{t('maintenance.end')}</Label>
                  <Input
                    id="m-ends"
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => {
                      setEndsAt(e.target.value);
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="m-policy">{t('maintenance.sessionPolicy')}</Label>
                  <Select
                    id="m-policy"
                    value={policy}
                    onChange={(e) => {
                      setPolicy(e.target.value as 'ignore' | 'stop_graceful');
                    }}
                  >
                    <option value="ignore">{t('maintenance.policyIgnore')}</option>
                    <option value="stop_graceful">{t('maintenance.policyStop')}</option>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('maintenance.reservationsAlwaysCancelled')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="m-message">{t('maintenance.customMessage')}</Label>
                  <Textarea
                    id="m-message"
                    value={customMessage}
                    onChange={(e) => {
                      setCustomMessage(e.target.value);
                    }}
                    placeholder={t('maintenance.customMessagePlaceholder')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="m-reason">{t('maintenance.reason')}</Label>
                  <Input
                    id="m-reason"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>{t('maintenance.affectedStations')}</Label>
                  <span className="text-xs text-muted-foreground">
                    {t('maintenance.selectedCount', {
                      count: effectiveSelected.size,
                      total: previewStations.length,
                    })}
                  </span>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectAllStations}
                    onChange={(e) => {
                      setSelectAllStations(e.target.checked);
                      if (e.target.checked) setSelectedStationIds(new Set());
                    }}
                  />
                  <span className="font-medium">{t('maintenance.allStations')}</span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                  <Input
                    placeholder={t('maintenance.stationSearchPlaceholder')}
                    value={stationSearch}
                    onChange={(e) => {
                      setStationSearch(e.target.value);
                    }}
                    aria-label={t('maintenance.stationSearchPlaceholder')}
                  />
                  <Select
                    className="h-9 w-auto"
                    aria-label={t('maintenance.stationFilterLabel')}
                    value={stationFilter}
                    onChange={(e) => {
                      setStationFilter(e.target.value as StationFilter);
                    }}
                  >
                    <option value="all">{t('common.all')}</option>
                    <option value="charging">{t('maintenance.filterCharging')}</option>
                    <option value="reserved">{t('maintenance.filterReserved')}</option>
                    <option value="idle">{t('maintenance.filterIdle')}</option>
                    <option value="offline">{t('maintenance.filterOffline')}</option>
                  </Select>
                </div>

                <div className="rounded-md border">
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={selectAllStations || visibleIds.length === 0}
                      onChange={(e) => {
                        toggleVisible(e.target.checked);
                      }}
                      aria-label={t('maintenance.toggleVisible')}
                    />
                    <span className="text-muted-foreground">
                      {t('maintenance.toggleVisibleHint', {
                        visible: visibleIds.length,
                        selected: visibleSelectedCount,
                      })}
                    </span>
                  </div>
                  <div className="h-72 overflow-y-auto">
                    {!previewRangeValid ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {t('maintenance.previewRangeInvalid')}
                      </p>
                    ) : previewLoading ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {t('maintenance.previewLoading')}
                      </p>
                    ) : visibleStations.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {t('maintenance.previewEmpty')}
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <tbody>
                          {visibleStations.map((s) => {
                            const isChecked = effectiveSelected.has(s.id);
                            return (
                              <tr key={s.id} className="border-b last:border-b-0">
                                <td className="p-2 align-top">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    disabled={selectAllStations}
                                    onChange={(e) => {
                                      setSelectedStationIds((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(s.id);
                                        else next.delete(s.id);
                                        return next;
                                      });
                                    }}
                                    aria-label={s.stationId}
                                  />
                                </td>
                                <td className="p-2 align-top">
                                  <div className="font-medium">{s.stationId}</div>
                                  {s.model != null && (
                                    <div className="text-xs text-muted-foreground">{s.model}</div>
                                  )}
                                </td>
                                <td className="p-2 align-top text-right">
                                  <div className="flex flex-wrap justify-end gap-1">
                                    {s.isOnline ? (
                                      <Badge variant="success">{t('status.online')}</Badge>
                                    ) : (
                                      <Badge variant="destructive">{t('status.offline')}</Badge>
                                    )}
                                    {s.hasActiveSession && (
                                      <Badge variant="warning">
                                        {t('maintenance.chargingBadge')}
                                      </Badge>
                                    )}
                                    {s.upcomingReservationCount > 0 && (
                                      <Badge variant="outline">
                                        {t('maintenance.reservationsBadge', {
                                          count: s.upcomingReservationCount,
                                        })}
                                      </Badge>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {previewRangeValid && requiresAck && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs space-y-1">
                    <p>
                      {t('maintenance.previewSummary', {
                        sessions: totalSessions,
                        reservations: totalReservations,
                      })}
                    </p>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => {
                          setAcknowledged(e.target.checked);
                        }}
                      />
                      {t('maintenance.acknowledge')}
                    </label>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 mt-4 border-t">
              <Button
                variant="outline"
                onClick={() => {
                  setCreateOpen(false);
                  resetForm();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  createMutation.mutate();
                }}
                disabled={saveDisabled}
              >
                {createMutation.isPending ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('maintenance.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('maintenance.colStart')}</TableHead>
                  <TableHead>{t('maintenance.colEnd')}</TableHead>
                  <TableHead>{t('maintenance.colStatus')}</TableHead>
                  <TableHead>{t('maintenance.colType')}</TableHead>
                  <TableHead>{t('maintenance.reason')}</TableHead>
                  <TableHead className="text-right">
                    {t('maintenance.colSessionsStopped')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('maintenance.colReservationsCancelled')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                      {t('maintenance.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{formatDateTime(e.plannedStartAt, timezone)}</TableCell>
                      <TableCell>{formatDateTime(e.plannedEndAt, timezone)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{t(STATUS_I18N_KEY[e.status])}</Badge>
                      </TableCell>
                      <TableCell>
                        {e.eventType === 'immediate'
                          ? t('maintenance.typeImmediate')
                          : t('maintenance.typeOneOff')}
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={e.reason ?? ''}>
                        {e.reason != null && e.reason.length > 0 ? (
                          e.reason
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{e.sessionsStoppedCount}</TableCell>
                      <TableCell className="text-right">{e.reservationsCancelledCount}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={historyPage}
            totalPages={historyTotalPages}
            onPageChange={setHistoryPage}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmCancelId != null}
        onOpenChange={(open) => {
          if (!open) setConfirmCancelId(null);
        }}
        title={t('maintenance.confirmCancelTitle')}
        description={t('maintenance.confirmCancelDescription')}
        confirmLabel={t('common.confirm')}
        variant="destructive"
        onConfirm={() => {
          if (confirmCancelId != null) cancelMutation.mutate(confirmCancelId);
        }}
      />
    </div>
  );
}

interface EventStationListProps {
  event: MaintenanceEvent;
  stations: Array<{ id: string; stationId: string }>;
  canWrite: boolean;
  removePending: boolean;
  onRemove: (stationId: string) => void;
}

function EventStationList({
  event,
  stations,
  canWrite,
  removePending,
  onRemove,
}: EventStationListProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (stations.length === 0) return null;
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="text-xs font-medium text-primary hover:underline"
        onClick={() => {
          setExpanded((v) => !v);
        }}
      >
        {expanded
          ? t('maintenance.hideStations')
          : t('maintenance.showStations', { count: stations.length })}
      </button>
      {expanded && (
        <>
          <ul className="max-h-40 overflow-y-auto rounded border bg-muted/30 text-xs divide-y">
            {stations.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-2 py-1.5">
                <span className="font-medium">{s.stationId}</span>
                {canWrite && stations.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removePending}
                    onClick={() => {
                      onRemove(s.id);
                    }}
                  >
                    {t('maintenance.removeFromEvent')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {stations.length === 1 && (
            <p className="text-xs text-muted-foreground">{t('maintenance.lastStationHint')}</p>
          )}
          {event.status === 'active' && stations.length > 1 && (
            <p className="text-xs text-muted-foreground">{t('maintenance.removeActiveHint')}</p>
          )}
        </>
      )}
    </div>
  );
}
