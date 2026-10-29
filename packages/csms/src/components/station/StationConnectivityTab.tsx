// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RotateCcw, ShieldCheck, Unlink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { TabPanel } from '@/components/ui/tab-panel';
import { DisabledWithReason } from '@/components/sim/DisabledWithReason';
import { SimProviderStatusCard } from '@/components/sim/SimProviderStatusCard';
import { SimRefreshCard, SimRefreshRangeDialog } from '@/components/sim/SimRefreshCard';
import { SimTimelineCard } from '@/components/sim/SimTimelineCard';
import {
  providerName,
  resetSuccessKey,
  simErrorMessage,
  stationSimKey,
  useStationSim,
  type StationSimAttachment,
  type StationSimStatus,
} from '@/components/sim/sim-connectivity';
import { useSimRefresh } from '@/components/sim/use-sim-refresh';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { SimStationCard } from './SimStationCard';

interface StationConnectivityTabProps {
  stationId: string;
  /** The ICCID the station reported or an operator entered. */
  iccid: string | null;
  timezone: string;
  /** Station signal reads are on: a Refresh also sends one OCPP request to the station. */
  stationSignalEnabled: boolean;
}

export function StationConnectivityTab({
  stationId,
  iccid,
  timezone,
  stationSignalEnabled,
}: StationConnectivityTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { data: sim, isLoading, isError, error, refetch } = useStationSim(stationId);

  if (isLoading || isError || sim == null) {
    return (
      <TabPanel
        title={t('stations.sim.tab')}
        isLoading={isLoading}
        isError
        errorMessage={getErrorMessage(error, t, 'common.loadError')}
        onRetry={() => {
          void refetch();
        }}
      />
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
  const controller = useSimRefresh({ kind: 'station', stationId }, sim);

  return (
    <div className="space-y-6">
      <SimRefreshCard
        controller={controller}
        title={t('stations.sim.tab')}
        hint={
          stationSignalEnabled
            ? t('stations.sim.refreshHint')
            : t('stations.sim.refreshHintProviderOnly')
        }
      />

      <SimCard
        stationId={stationId}
        iccid={iccid}
        timezone={timezone}
        sim={sim}
        lookingUp={controller.refresh.isPending}
        onLookUpAgain={() => {
          controller.refreshWithDays(true);
        }}
      />

      {sim.station != null && (
        <SimStationCard stationId={stationId} timezone={timezone} station={sim.station} />
      )}

      <SimTimelineCard
        controller={controller}
        timezone={timezone}
        lastFetchedAt={sim.lastFetchedAt}
        reportingDelayHours={sim.reportingDelayHours}
      />

      <SimRefreshRangeDialog controller={controller} />
    </div>
  );
}

/** Errors after which the SIM shown is out of date: the status is read again. */
const STALE_SIM_CODES = new Set([
  'SIM_ATTACHMENT_CHANGED',
  'SIM_INACTIVE',
  'SIM_ATTACHMENT_NOT_CONFIRMED',
]);

/** Where the ICCID of an attachment came from, in plain words, with the person when known. */
function attachmentSourceText(attachment: StationSimAttachment, t: TFunction): string {
  if (attachment.source === 'reported') return t('stations.sim.confirmSource.reported');
  const name = attachment.attachedBy?.name ?? null;
  return name == null
    ? t(`stations.sim.confirmSource.${attachment.source}Unknown`)
    : t(`stations.sim.confirmSource.${attachment.source}`, { name });
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
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const canReadSims = useHasPermission('sims:read');
  const allSites = useHasAllSiteAccess();
  const canReadIntegrations = useHasPermission('settings.integrations:read') && allSites;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);

  const reloadOnStale = (err: unknown): void => {
    const code = getApiErrorCode(err);
    if (code != null && STALE_SIM_CODES.has(code)) {
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    }
  };

  const confirm = useMutation({
    // The attachment the dialog shows: one that changed since is refused, never confirmed.
    mutationFn: (attachmentId: number) =>
      api.post(`/v1/stations/${stationId}/sim/attachment/confirm`, { attachmentId }),
    onSuccess: () => {
      setConfirmOpen(false);
      toast({ variant: 'success', title: t('stations.sim.confirmSuccess') });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
      // The dialog stays open on the reloaded attachment, so the person sees what they confirm.
      reloadOnStale(err);
    },
  });

  const detach = useMutation({
    mutationFn: () => api.delete(`/v1/stations/${stationId}/sim/attachment`),
    onSuccess: () => {
      setDetachOpen(false);
      toast({ variant: 'success', title: t('stations.sim.detachSimSuccess') });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/sim/network-reset`, {}),
    onSuccess: (reply) => {
      setResetOpen(false);
      toast({ variant: 'success', title: t(resetSuccessKey(reply)) });
      void queryClient.invalidateQueries({ queryKey: stationSimKey(stationId) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
      reloadOnStale(err);
    },
  });

  if (sim.provider == null) {
    // Only an all-site user is sure to see a SIM that is not attached here; the SIM list finds it by the ICCID.
    const findSim =
      canReadSims && allSites && iccid != null ? (
        <Link
          to={`/sims?search=${encodeURIComponent(iccid)}`}
          className="text-sm text-link hover:underline"
        >
          {t('stations.sim.findSim')}
        </Link>
      ) : null;
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
          {sim.reason === 'attached_elsewhere' && (
            <>
              <p className="text-sm text-muted-foreground">
                {t('stations.sim.emptyAttachedElsewhere')}
              </p>
              {findSim}
            </>
          )}
          {sim.reason === 'sim_inactive' && (
            <>
              <p className="text-sm text-muted-foreground">{t('stations.sim.emptySimInactive')}</p>
              {findSim}
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const provider = providerName(sim.provider);
  const attachment = sim.attachment;
  const confirmed = attachment?.confirmedAt != null;
  const canReset = canWrite && sim.capabilities?.networkReset === true;
  // A site-restricted user sees a SIM only through a confirmed attachment.
  const viewSimId =
    canReadSims && attachment != null && (confirmed || allSites) ? attachment.simId : null;
  const na = t('common.na');
  const resetButton = (disabled: boolean): React.JSX.Element => (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={disabled}
      onClick={() => {
        setResetOpen(true);
      }}
    >
      <RotateCcw className="h-4 w-4" />
      {t('stations.sim.resetNetwork')}
    </Button>
  );

  return (
    <SimProviderStatusCard
      provider={sim.provider}
      capabilities={sim.capabilities}
      status={sim.status}
      statusFetchedAt={sim.statusFetchedAt}
      network={sim.network}
      recentAlerts={sim.recentAlerts}
      showRecentAlerts={confirmed}
      timezone={timezone}
      actions={
        <>
          {attachment != null && !confirmed && canWrite && allSites && (
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
              resetButton(false)
            ) : (
              <DisabledWithReason
                reason={t('stations.sim.resetNeedsConfirm')}
                testId="sim-reset-disabled"
              >
                {resetButton(true)}
              </DisabledWithReason>
            ))}
          {canWrite && attachment != null && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setDetachOpen(true);
              }}
            >
              <Unlink className="h-4 w-4" />
              {t('stations.sim.detachSim')}
            </Button>
          )}
        </>
      }
      notice={
        <>
          {!confirmed && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {t('stations.sim.unconfirmedNotice', { provider })}
              </AlertDescription>
            </Alert>
          )}
          {viewSimId != null && (
            <p>
              <Link
                to={`/sims/${encodeURIComponent(viewSimId)}`}
                className="text-sm text-link hover:underline"
              >
                {t('stations.sim.viewSim')}
              </Link>
            </p>
          )}
        </>
      }
    >
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
          if (attachment != null) confirm.mutate(attachment.id);
          return false;
        }}
      >
        {attachment != null && (
          <p className="text-sm text-muted-foreground" data-testid="sim-confirm-source">
            {attachmentSourceText(attachment, t)}
          </p>
        )}
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
        open={detachOpen}
        onOpenChange={setDetachOpen}
        title={t('stations.sim.detachSim')}
        description={t('stations.sim.detachSimDescription')}
        confirmLabel={t('stations.sim.detachSim')}
        isPending={detach.isPending}
        onConfirm={() => {
          detach.mutate();
          return false;
        }}
      />
    </SimProviderStatusCard>
  );
}
