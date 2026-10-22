// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, Info, RotateCcw, ShieldCheck, Unlink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { RefreshButton } from '@/components/refresh-button';
import { LoadingLogo } from '@/components/loading-logo';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { formatCalendarDate } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { SimCoverageStrip } from './SimCoverageStrip';
import { SimRangeDialog } from './SimRangeDialog';
import { SimStationCard } from './SimStationCard';
import {
  DAY_MS,
  formatDataBytes,
  initialPeriod,
  notFetchedRuns,
  periodOptions,
  providerName,
  rangeWindowDays,
  refreshResultLines,
  selectedPeriod,
  simErrorMessage,
  stateBadgeVariant,
  stationSimKey,
  timelineRows,
  usageNearLimit,
  useStationSim,
  zonedDate,
  type SimRefreshBody,
  type SimRefreshResult,
  type SimTimelineItem,
  type SimTimelinePage,
  type StationSimStatus,
} from './sim-connectivity';

const TIMELINE_PRESETS = [1, 24, 168, 744] as const;
type TimelinePreset = (typeof TIMELINE_PRESETS)[number];

type TimelineRange =
  | { kind: 'preset'; hours: TimelinePreset; anchor: number }
  | { kind: 'custom'; from: string; to: string };

const PRESET_KEYS = {
  1: 'stations.sim.timelineLastHour',
  24: 'stations.sim.timelineLast24Hours',
  168: 'stations.sim.timelineLast7Days',
  744: 'stations.sim.timelineLast31Days',
} as const;

const STATE_KEYS = {
  active: 'stations.sim.state.active',
  pending: 'stations.sim.state.pending',
  suspended: 'stations.sim.state.suspended',
  inactive: 'stations.sim.state.inactive',
  deactivated: 'stations.sim.state.deactivated',
  test: 'stations.sim.state.test',
  unknown: 'stations.sim.state.unknown',
} as const;

const KIND_KEYS: Record<string, string> = {
  connected: 'stations.sim.kind.connected',
  disconnected: 'stations.sim.kind.disconnected',
  session: 'stations.sim.kind.session',
  data_limit: 'stations.sim.kind.dataLimit',
  data_warning: 'stations.sim.kind.dataWarning',
  device_changed: 'stations.sim.kind.deviceChanged',
  device_model_changed: 'stations.sim.kind.deviceModelChanged',
  first_device: 'stations.sim.kind.firstDevice',
  signal_low: 'stations.sim.kind.signalLow',
  signal_restored: 'stations.sim.kind.signalRestored',
};

const DISCONNECT_REASON_KEYS: Record<string, string> = {
  server_shutdown: 'stations.sim.disconnectReason.serverShutdown',
  offline_sweep: 'stations.sim.disconnectReason.offlineSweep',
};

const OFFLINE_CAUSE_KEYS: Record<string, string> = {
  server: 'stations.sim.offlineCause.server',
  sim_account: 'stations.sim.offlineCause.simAccount',
  station: 'stations.sim.offlineCause.station',
  network: 'stations.sim.offlineCause.network',
  pending: 'stations.sim.offlineCause.pending',
  unknown: 'stations.sim.offlineCause.unknown',
};

const OFFLINE_CAUSE_HINT_KEYS: Record<string, string> = {
  server: 'stations.sim.offlineCauseHint.server',
  sim_account: 'stations.sim.offlineCauseHint.simAccount',
  station: 'stations.sim.offlineCauseHint.station',
  network: 'stations.sim.offlineCauseHint.network',
  pending: 'stations.sim.offlineCauseHint.pending',
  unknown: 'stations.sim.offlineCauseHint.unknown',
};

const CAPABILITY_KEYS = {
  networkName: 'stations.sim.network',
  radioAccessTechnology: 'stations.sim.radioAccessTechnology',
  cellId: 'stations.sim.cellId',
  usage: 'stations.sim.usage',
} as const;

interface StationConnectivityTabProps {
  stationId: string;
  /** The ICCID the station reported or an operator entered. */
  iccid: string | null;
  timezone: string;
  /** Station signal reads are on: a Refresh also sends one OCPP request to the station. */
  stationSignalEnabled: boolean;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function StationConnectivityTab({
  stationId,
  iccid,
  timezone,
  stationSignalEnabled,
}: StationConnectivityTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { data: sim, isLoading, isError, error, refetch } = useStationSim(stationId);

  if (isLoading) return <LoadingLogo size="inline" />;
  if (isError || sim == null) {
    return (
      <div className="space-y-2 text-center">
        <p className="text-sm text-destructive">{getErrorMessage(error, t, 'common.loadError')}</p>
        <Button
          variant="outline"
          onClick={() => {
            void refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return (
    <ConnectivityContent
      stationId={stationId}
      iccid={iccid}
      timezone={timezone}
      stationSignalEnabled={stationSignalEnabled}
      sim={sim}
    />
  );
}

function ConnectivityContent({
  stationId,
  iccid,
  timezone,
  stationSignalEnabled,
  sim,
}: StationConnectivityTabProps & { sim: StationSimStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const options = periodOptions(sim);
  const [chosenDays, setDays] = useState(() => initialPeriod(options, sim.fetchDays));
  // A reload can shorten the window or the retention; the select then falls back to an open period.
  const days = selectedPeriod(options, chosenDays, sim.fetchDays);
  const coverageZone = sim.coverageTimeZone;
  const blockedByHistory = options.some((o) => o.blockedBy === 'history');
  const blockedByRetention = options.some((o) => o.blockedBy === 'retention');
  const [result, setResult] = useState<SimRefreshResult | null>(null);
  const [range, setRange] = useState<TimelineRange>({
    kind: 'preset',
    hours: 24,
    anchor: Date.now(),
  });
  const [dialog, setDialog] = useState<{ from: string; to: string } | null>(null);
  const windowDays = rangeWindowDays(sim);

  const refresh = useMutation({
    mutationFn: (body: SimRefreshBody) =>
      api.post<SimRefreshResult>(`/v1/stations/${stationId}/sim/refresh`, body),
    onMutate: () => {
      setResult(null);
    },
    onSuccess: (data, body) => {
      setResult(data);
      if ('from' in body) {
        setRange({ kind: 'custom', from: body.from, to: body.to });
        setDialog(null);
      } else {
        setRange((current) =>
          current.kind === 'preset' ? { ...current, anchor: Date.now() } : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
  });

  function refreshWithDays(retryLookup = false): void {
    refresh.mutate(retryLookup ? { days, retryLookup: true } : { days });
  }

  function openDialog(from: string, to: string): void {
    refresh.reset();
    setDialog({ from, to });
  }

  const today = zonedDate(new Date(), coverageZone);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('stations.sim.refreshTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="sim-refresh-period">{t('stations.sim.period')}</Label>
              <Select
                id="sim-refresh-period"
                className="w-auto"
                value={String(days)}
                disabled={refresh.isPending}
                onChange={(e) => {
                  setDays(Number(e.target.value));
                }}
              >
                {options.map((o) => (
                  <option
                    key={o.days}
                    value={String(o.days)}
                    disabled={o.blockedBy != null}
                    title={
                      o.blockedBy === 'history'
                        ? t('stations.sim.periodBeyondHistory', {
                            provider: providerName(sim.provider),
                            days: sim.historyDays ?? 0,
                          })
                        : o.blockedBy === 'retention'
                          ? t('stations.sim.periodBeyondRetention', { days: sim.retentionDays })
                          : undefined
                    }
                  >
                    {t('stations.sim.lastDays', { count: o.days })}
                  </option>
                ))}
              </Select>
            </div>
            <RefreshButton
              label={t('stations.sim.refresh')}
              isPending={refresh.isPending}
              onClick={() => {
                refreshWithDays();
              }}
            />
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={refresh.isPending}
              onClick={() => {
                openDialog(
                  zonedDate(new Date(Date.now() - (days - 1) * DAY_MS), coverageZone),
                  today,
                );
              }}
            >
              <CalendarRange className="h-4 w-4" />
              {t('stations.sim.customRange')}
            </Button>
          </div>
          {(blockedByHistory || blockedByRetention) && (
            <div
              className="space-y-1 text-xs text-muted-foreground"
              data-testid="sim-period-limits"
            >
              {blockedByHistory && (
                <p>
                  {t('stations.sim.periodBlockedHistory', {
                    provider: providerName(sim.provider),
                    days: sim.historyDays ?? 0,
                  })}
                </p>
              )}
              {blockedByRetention && (
                <p>{t('stations.sim.periodBlockedRetention', { days: sim.retentionDays })}</p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {stationSignalEnabled
              ? t('stations.sim.refreshHint')
              : t('stations.sim.refreshHintProviderOnly')}
          </p>
          {result != null && (
            <ul className="space-y-1 text-sm" data-testid="sim-refresh-result">
              {refreshResultLines(result).map((line) => {
                const counts = Object.fromEntries(
                  Object.entries(line.counts ?? {}).map(([name, c]) => [
                    name,
                    t(c.key as 'stations.sim.result.sessionCount', {
                      count: c.count,
                      formatted: formatNumber(c.count, 0),
                    }),
                  ]),
                );
                return (
                  <li key={line.key}>
                    {t(line.key as 'stations.sim.refresh', { ...line.values, ...counts })}
                  </li>
                );
              })}
            </ul>
          )}
          {refresh.isError && dialog == null && (
            <p className="text-sm text-destructive">{simErrorMessage(refresh.error, t)}</p>
          )}
        </CardContent>
      </Card>

      <SimCard
        stationId={stationId}
        iccid={iccid}
        timezone={timezone}
        sim={sim}
        lookingUp={refresh.isPending}
        onLookUpAgain={() => {
          refreshWithDays(true);
        }}
      />

      {sim.station != null && (
        <SimStationCard stationId={stationId} timezone={timezone} station={sim.station} />
      )}

      <TimelineCard
        stationId={stationId}
        timezone={timezone}
        coverageZone={coverageZone}
        sim={sim}
        range={range}
        onRangeChange={setRange}
        onFetchRange={openDialog}
      />

      <SimRangeDialog
        open={dialog != null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        stationId={stationId}
        timezone={coverageZone}
        windowDays={windowDays}
        initialFrom={dialog?.from ?? today}
        initialTo={dialog?.to ?? today}
        isPending={refresh.isPending}
        errorText={refresh.isError ? simErrorMessage(refresh.error, t) : null}
        onFetch={({ from, to }) => {
          refresh.mutate({ from: from.toISOString(), to: to.toISOString() });
        }}
      />
    </div>
  );
}

function SimCard({
  stationId,
  iccid,
  timezone,
  sim,
  lookingUp,
  onLookUpAgain,
}: {
  stationId: string;
  iccid: string | null;
  timezone: string;
  sim: StationSimStatus;
  lookingUp: boolean;
  onLookUpAgain: () => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const allSites = useHasAllSiteAccess();
  const canReadIntegrations = useHasPermission('settings.integrations:read') && allSites;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const resetReasonId = useId();

  const confirm = useMutation({
    // The match the dialog shows: one that changed since is refused, never confirmed.
    mutationFn: (matchedAt: string | null) =>
      api.post(`/v1/stations/${stationId}/sim/match/confirm`, { matchedAt }),
    onSuccess: () => {
      setConfirmOpen(false);
      toast({ variant: 'success', title: t('stations.sim.confirmSuccess') });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
      // The dialog stays open on the reloaded match, so the person sees what they confirm.
      if (getApiErrorCode(err) === 'SIM_MATCH_CHANGED') {
        void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
      }
    },
  });

  const clearMatch = useMutation({
    mutationFn: () => api.delete(`/v1/stations/${stationId}/sim/match`),
    onSuccess: () => {
      setClearOpen(false);
      toast({ variant: 'success', title: t('stations.sim.clearMatchSuccess') });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/sim/network-reset`, {}),
    onSuccess: () => {
      setResetOpen(false);
      toast({ variant: 'success', title: t('stations.sim.resetSuccess') });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  if (sim.provider == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('stations.sim.fromProviderTitle')}</CardTitle>
        </CardHeader>
        <CardContent
          className="space-y-3 text-center"
          data-testid={`sim-empty-${sim.reason ?? ''}`}
        >
          {sim.reason === 'no_iccid' && (
            <>
              <p className="text-sm text-muted-foreground">{t('stations.sim.emptyNoIccid')}</p>
              <Link to="?tab=info" className={buttonVariants({ variant: 'link', size: 'inline' })}>
                {t('stations.sim.goToDetails')}
              </Link>
            </>
          )}
          {sim.reason === 'no_provider_configured' && (
            <>
              <p className="text-sm text-muted-foreground">{t('stations.sim.emptyNoProvider')}</p>
              {canReadIntegrations && (
                <Link
                  to="/settings?tab=integrations&sub=simProviders"
                  className={buttonVariants({ variant: 'link', size: 'inline' })}
                >
                  {t('stations.sim.goToSettings')}
                </Link>
              )}
            </>
          )}
          {sim.reason === 'not_looked_up' && (
            <p className="text-sm text-muted-foreground">{t('stations.sim.notFetchedYet')}</p>
          )}
          {sim.reason === 'not_found' && (
            <>
              <p className="text-sm text-muted-foreground">{t('stations.sim.emptyNotFound')}</p>
              <Button variant="outline" disabled={lookingUp} onClick={onLookUpAgain}>
                {t('stations.sim.lookUpAgain')}
              </Button>
            </>
          )}
          {sim.reason === 'sim_matched_elsewhere' && (
            <p className="text-sm text-muted-foreground">
              {t('stations.sim.emptyMatchedElsewhere')}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const provider = providerName(sim.provider);
  const capabilities = sim.capabilities;
  const status = sim.status;
  const confirmed = sim.match?.confirmed === true;
  const missing = (Object.keys(CAPABILITY_KEYS) as Array<keyof typeof CAPABILITY_KEYS>).filter(
    (c) => capabilities != null && !capabilities[c],
  );
  const canReset = canWrite && capabilities?.networkReset === true;
  const na = t('common.na');
  const time = (iso: string | null | undefined): string =>
    iso == null ? na : formatDateTime(iso, timezone);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('stations.sim.fromProviderTitle')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {!confirmed && canWrite && allSites && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              {t('stations.sim.confirmSim')}
            </Button>
          )}
          {canReset &&
            (confirmed ? (
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setResetOpen(true);
                }}
              >
                <RotateCcw className="h-4 w-4" />
                {t('stations.sim.resetNetwork')}
              </Button>
            ) : (
              <Tooltip content={t('stations.sim.resetNeedsConfirm')}>
                {/* A disabled button takes no focus: the wrapper carries the reason to keyboard users. */}
                <span
                  tabIndex={0}
                  aria-describedby={resetReasonId}
                  className="inline-flex rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  data-testid="sim-reset-disabled"
                >
                  <Button variant="outline" className="gap-1.5" disabled>
                    <RotateCcw className="h-4 w-4" />
                    {t('stations.sim.resetNetwork')}
                  </Button>
                  <span id={resetReasonId} className="sr-only">
                    {t('stations.sim.resetNeedsConfirm')}
                  </span>
                </span>
              </Tooltip>
            ))}
          {canWrite && sim.match != null && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setClearOpen(true);
              }}
            >
              <Unlink className="h-4 w-4" />
              {t('stations.sim.clearMatch')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!confirmed && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t('stations.sim.unconfirmedNotice', { provider: providerName(sim.provider) })}
            </AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">
          {sim.statusFetchedAt == null
            ? t('stations.sim.notFetchedYet')
            : t('stations.sim.fetchedAt', { time: formatDateTime(sim.statusFetchedAt, timezone) })}
        </p>
        <DescriptionList>
          <DescriptionItem label={t('stations.sim.provider')}>{provider}</DescriptionItem>
          {status != null && (
            <>
              <DescriptionItem label={t('stations.sim.stateLabel')}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={stateBadgeVariant(status.state)}>
                    {t(STATE_KEYS[status.state])}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t('stations.sim.providerState', {
                      provider,
                      state: status.providerState,
                    })}
                  </span>
                </span>
              </DescriptionItem>
              <DescriptionItem label={t('stations.sim.inSession')}>
                {status.inSession == null
                  ? na
                  : status.inSession
                    ? t('stations.sim.inSessionSince', { time: time(status.openSessionBeganAt) })
                    : t('common.no')}
              </DescriptionItem>
            </>
          )}
          {capabilities?.networkName === true && (
            <DescriptionItem label={t('stations.sim.network')}>
              {sim.network?.name ?? na}
              {capabilities.radioAccessTechnology && sim.network?.radioAccessTechnology != null
                ? ` (${sim.network.radioAccessTechnology})`
                : ''}
            </DescriptionItem>
          )}
          {capabilities?.cellId === true && (
            <DescriptionItem label={t('stations.sim.cellId')}>
              {sim.network?.cellId ?? na}
            </DescriptionItem>
          )}
          {status != null && (
            <>
              <DescriptionItem label={t('stations.sim.apn')}>{status.apn ?? na}</DescriptionItem>
              <DescriptionItem label={t('stations.sim.profile')}>
                {status.profileName ?? na}
              </DescriptionItem>
              <DescriptionItem label={t('stations.sim.lastSession')}>
                {time(status.lastSessionAt)}
              </DescriptionItem>
            </>
          )}
          {capabilities?.usage === true && status != null && (
            <DescriptionItem label={t('stations.sim.usage')}>
              {status.usage == null
                ? na
                : status.usage.periodEnd == null
                  ? formatDataBytes(status.usage.bytes)
                  : t('stations.sim.usageUntil', {
                      amount: formatDataBytes(status.usage.bytes),
                      date: formatDateTime(status.usage.periodEnd, timezone),
                    })}
            </DescriptionItem>
          )}
        </DescriptionList>
        {status?.usage != null && usageNearLimit(status.usage) && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t('stations.sim.usageWarning', {
                amount: formatDataBytes(status.usage.bytes),
                limit: formatDataBytes(status.usage.limitBytes ?? 0),
              })}
            </AlertDescription>
          </Alert>
        )}
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('stations.sim.notReported', {
              provider,
              fields: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
                missing.map((c) => t(CAPABILITY_KEYS[c])),
              ),
            })}
          </p>
        )}
        {confirmed && capabilities?.alerts === true && (
          <div className="space-y-2" data-testid="sim-recent-alerts">
            <h4 className="text-sm font-medium">{t('stations.sim.recentAlertsTitle')}</h4>
            {(sim.recentAlerts ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('stations.sim.noRecentAlerts')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(sim.recentAlerts ?? []).map((alert) => {
                  const key = KIND_KEYS[alert.kind];
                  return (
                    <li
                      key={`${alert.kind}-${alert.receivedAt}`}
                      className="flex flex-wrap items-center gap-x-2"
                    >
                      <span className="font-medium">
                        {key != null ? t(key as 'stations.sim.kind.session') : alert.kind}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(alert.receivedAt, timezone)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('stations.sim.alertsRefreshNote')}</p>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="default"
        title={t('stations.sim.confirmSim')}
        description={t('stations.sim.confirmDescription', {
          iccid: iccid ?? na,
          provider,
        })}
        confirmLabel={t('stations.sim.confirmSim')}
        isPending={confirm.isPending}
        onConfirm={() => {
          confirm.mutate(sim.match?.matchedAt ?? null);
          return false;
        }}
      >
        <p className="text-sm text-muted-foreground" data-testid="sim-confirm-source">
          {sim.match?.iccidSource === 'entered'
            ? sim.match.enteredBy?.name != null
              ? t('stations.sim.confirmSourceEntered', { name: sim.match.enteredBy.name })
              : t('stations.sim.confirmSourceEnteredUnknown')
            : t('stations.sim.confirmSourceStation')}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('stations.sim.resetNetwork')}
        description={t('stations.sim.resetDescription')}
        confirmLabel={t('stations.sim.resetNetwork')}
        isPending={reset.isPending}
        onConfirm={() => {
          reset.mutate();
          return false;
        }}
      />
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t('stations.sim.clearMatch')}
        description={t('stations.sim.clearMatchDescription')}
        confirmLabel={t('stations.sim.clearMatch')}
        isPending={clearMatch.isPending}
        onConfirm={() => {
          clearMatch.mutate();
          return false;
        }}
      />
    </Card>
  );
}

function rangeParams(range: TimelineRange): { from: string; to?: string } {
  if (range.kind === 'custom') return { from: range.from, to: range.to };
  return { from: new Date(range.anchor - range.hours * 3_600_000).toISOString() };
}

function TimelineCard({
  stationId,
  timezone,
  coverageZone,
  sim,
  range,
  onRangeChange,
  onFetchRange,
}: {
  stationId: string;
  timezone: string;
  /** The time zone the coverage days are counted in. */
  coverageZone: string;
  sim: StationSimStatus;
  range: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
  onFetchRange: (from: string, to: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const params = rangeParams(range);
  const timeline = useInfiniteQuery({
    queryKey: [...stationSimKey(stationId), 'timeline', params.from, params.to ?? null],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ from: params.from });
      if (params.to != null) query.set('to', params.to);
      if (pageParam != null) query.set('cursor', pageParam);
      return api.get<SimTimelinePage>(`/v1/stations/${stationId}/sim/timeline?${query.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const first = timeline.data?.pages[0];
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];
  const days = first?.days ?? [];
  const runs = notFetchedRuns(days);
  const rows = timelineRows(items, runs, coverageZone, !timeline.hasNextPage);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stations.sim.timelineTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="sim-timeline-range">{t('stations.sim.timelineRange')}</Label>
          <Select
            id="sim-timeline-range"
            className="w-auto"
            value={range.kind === 'preset' ? String(range.hours) : 'custom'}
            onChange={(e) => {
              const hours = TIMELINE_PRESETS.find((h) => String(h) === e.target.value);
              if (hours != null) onRangeChange({ kind: 'preset', hours, anchor: Date.now() });
            }}
          >
            {TIMELINE_PRESETS.map((h) => (
              <option key={h} value={String(h)}>
                {t(PRESET_KEYS[h])}
              </option>
            ))}
            {range.kind === 'custom' && (
              <option value="custom">
                {t('stations.sim.timelineCustom', {
                  from: formatDateTime(range.from, timezone),
                  to: formatDateTime(range.to, timezone),
                })}
              </option>
            )}
          </Select>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {sim.lastFetchedAt == null
              ? t('stations.sim.notFetchedYet')
              : t('stations.sim.lastFetched', {
                  time: formatDateTime(sim.lastFetchedAt, timezone),
                })}
          </p>
          {sim.provider != null && sim.reportingDelayHours != null && (
            <p className="flex items-start gap-1">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              {t('stations.sim.reportingNote', {
                provider: providerName(sim.provider),
                hours: sim.reportingDelayHours,
              })}
            </p>
          )}
          {first?.capped === true && <p>{t('stations.sim.timelineCapped')}</p>}
        </div>

        {timeline.isLoading ? (
          <LoadingLogo size="inline" />
        ) : timeline.isError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-destructive">
              {getErrorMessage(timeline.error, t, 'common.loadError')}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                void timeline.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <>
            {days.length > 0 && (
              <SimCoverageStrip
                days={days}
                onSelectDay={(date) => {
                  onFetchRange(date, date);
                }}
              />
            )}
            {rows.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground">
                {t('stations.sim.timelineEmpty')}
              </p>
            ) : (
              <ul className="divide-y" data-testid="sim-timeline">
                {rows.map((row) =>
                  row.type === 'gap' ? (
                    <li
                      key={`gap-${row.from}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                      data-testid="sim-timeline-gap"
                    >
                      <span className="text-sm text-muted-foreground">
                        {t('stations.simCoverage.notFetchedRange', {
                          from: formatCalendarDate(row.from),
                          to: formatCalendarDate(row.to),
                        })}
                      </span>
                      <Button
                        variant="outline"
                        onClick={() => {
                          onFetchRange(row.from, row.to);
                        }}
                      >
                        {t('stations.sim.fetch')}
                      </Button>
                    </li>
                  ) : (
                    <TimelineRow key={row.key} item={row.item} timezone={timezone} />
                  ),
                )}
              </ul>
            )}
            {timeline.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  disabled={timeline.isFetchingNextPage}
                  onClick={() => {
                    void timeline.fetchNextPage();
                  }}
                >
                  {t('stations.sim.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineRow({
  item,
  timezone,
}: {
  item: SimTimelineItem;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const kindKey = KIND_KEYS[item.kind];
  const kind = kindKey != null ? t(kindKey as 'stations.sim.kind.session') : item.kind;
  const details: string[] = [];
  if (item.kind === 'session') {
    const ended = stringOf(item.details.endedAt);
    if (ended != null)
      details.push(t('stations.sim.sessionEnded', { time: formatDateTime(ended, timezone) }));
    if (typeof item.details.bytes === 'number') details.push(formatDataBytes(item.details.bytes));
    const network = stringOf(item.details.networkName);
    const rat = stringOf(item.details.radioAccessTechnology);
    if (network != null) details.push(rat != null ? `${network} (${rat})` : network);
    else if (rat != null) details.push(rat);
    const cell = stringOf(item.details.cellId);
    if (cell != null) details.push(t('stations.sim.cellIdValue', { cell }));
  }
  if (item.kind === 'signal_low' || item.kind === 'signal_restored') {
    const instance = stringOf(item.details.instance);
    const actual = stringOf(item.details.actualValue);
    if (actual != null) details.push(t('stations.sim.signalReading', { value: actual }));
    if (instance != null) details.push(t('stations.sim.station.modem', { instance }));
  }
  if (item.kind === 'disconnected') {
    const reasonKey = DISCONNECT_REASON_KEYS[stringOf(item.details.reason) ?? ''];
    if (reasonKey != null) details.push(t(reasonKey as 'stations.sim.kind.session'));
  }
  const cause = stringOf(item.details.offlineCause) ?? '';
  const causeKey = OFFLINE_CAUSE_KEYS[cause];
  const causeHintKey = OFFLINE_CAUSE_HINT_KEYS[cause];

  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 text-xs text-muted-foreground sm:w-44">
        {formatDateTime(item.at, timezone)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={item.source === 'sim' ? 'info' : 'secondary'}>
            {item.source === 'sim' ? t('stations.sim.sourceSim') : t('stations.sim.sourceOcpp')}
          </Badge>
          <span className="text-sm font-medium">{kind}</span>
          {causeKey != null && (
            <Badge variant="outline">{t(causeKey as 'stations.sim.kind.session')}</Badge>
          )}
        </span>
        {details.length > 0 && (
          <span className="wrap-anywhere text-xs text-muted-foreground">{details.join(', ')}</span>
        )}
        {causeHintKey != null && (
          <span className="text-xs text-muted-foreground" data-testid="offline-cause-hint">
            {t(causeHintKey as 'stations.sim.kind.session')}
          </span>
        )}
      </span>
    </li>
  );
}
