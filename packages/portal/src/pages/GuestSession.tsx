// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Zap, Clock, DollarSign, StopCircle, AlertCircle, Check, Pause } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorCard } from '@/components/ui/error-card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { SessionCharts } from '@/components/SessionCharts';
import { api } from '@/lib/api';
import { formatCents, formatEnergy, formatDate } from '@/lib/utils';

interface GuestSessionStatus {
  status: string;
  stationOcppId: string;
  evseId: number;
  energyDeliveredWh?: string | null;
  currentCostCents?: number | null;
  finalCostCents?: number | null;
  currency?: string | null;
  failureReason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  idleStartedAt?: string | null;
}

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'pending_payment':
      return t('status.pendingPayment');
    case 'payment_authorized':
      return t('status.paymentAuthorized');
    case 'charging':
      return t('status.charging');
    case 'completed':
      return t('status.completed');
    case 'failed':
      return t('status.failed');
    case 'expired':
      return t('status.expired');
    default:
      return status;
  }
}

function useElapsedTime(startedAt: string | null | undefined, isActive: boolean): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive || startedAt == null) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [isActive, startedAt]);

  if (startedAt == null) return '--';
  const ms = (isActive ? now : Date.now()) - new Date(startedAt).getTime();
  if (ms < 0) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m ${String(seconds)}s`;
}

function formatStaticDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (startedAt == null || endedAt == null) return '--';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return '--';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

export function GuestSession(): React.JSX.Element {
  const { t } = useTranslation();
  const { sessionToken } = useParams<{ sessionToken: string }>();
  const navigate = useNavigate();
  const [stopping, setStopping] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showReceiptDialog, setShowReceiptDialog] = useState(true);
  const { companyName, companyLogo, branding } = useAuthBranding();

  const {
    data: session,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['guest-session', sessionToken],
    queryFn: () => api.get<GuestSessionStatus>(`/v1/portal/guest/status/${sessionToken ?? ''}`),
    enabled: sessionToken != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'completed' || status === 'failed' || status === 'expired') {
        return false;
      }
      return 5000;
    },
  });

  const { data: powerHistory } = useQuery({
    queryKey: ['guest-power-history', sessionToken],
    queryFn: () =>
      api.get<{ data: Array<{ timestamp: string; powerW: number }> }>(
        `/v1/portal/guest/power-history/${sessionToken ?? ''}`,
      ),
    enabled:
      sessionToken != null && (session?.status === 'charging' || session?.status === 'completed'),
    refetchInterval: () => {
      const status = session?.status;
      if (status === 'completed' || status === 'failed' || status === 'expired') return false;
      return 10000;
    },
  });

  const { data: energyHistory } = useQuery({
    queryKey: ['guest-energy-history', sessionToken],
    queryFn: () =>
      api.get<{ data: Array<{ timestamp: string; energyWh: number }> }>(
        `/v1/portal/guest/energy-history/${sessionToken ?? ''}`,
      ),
    enabled:
      sessionToken != null && (session?.status === 'charging' || session?.status === 'completed'),
    refetchInterval: () => {
      const status = session?.status;
      if (status === 'completed' || status === 'failed' || status === 'expired') return false;
      return 10000;
    },
  });

  const isCharging = session?.status === 'charging';
  const isActive = isCharging || session?.status === 'payment_authorized';
  const elapsed = useElapsedTime(session?.startedAt ?? null, isActive);

  async function handleStop(): Promise<void> {
    if (sessionToken == null) return;
    setStopping(true);
    try {
      await api.post(`/v1/portal/guest/stop/${sessionToken}`, {});
    } catch {
      // ignore, polling will update status
    } finally {
      setStopping(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('guestSession.loadingSession')}</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} />
        <ErrorCard message={t('guestSession.sessionError')} />
        <AuthFooter companyName={companyName} branding={branding} />
      </div>
    );
  }

  if (session == null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} />
        <Card className="w-full max-w-sm text-center">
          <CardContent className="p-6">
            <p className="text-destructive">{t('guestSession.notFound')}</p>
          </CardContent>
        </Card>
        <AuthFooter companyName={companyName} branding={branding} />
      </div>
    );
  }

  const isDone = session.status === 'completed';
  const isFailed = session.status === 'failed' || session.status === 'expired';
  const isIdle = isCharging && session.idleStartedAt != null;

  const statusClass = isIdle
    ? 'bg-warning text-warning-foreground'
    : isCharging
      ? 'bg-success text-success-foreground'
      : isFailed
        ? 'bg-destructive text-destructive-foreground'
        : isDone
          ? 'bg-primary text-primary-foreground'
          : 'bg-warning text-warning-foreground';

  const StatusIcon = isIdle ? Pause : isCharging ? Zap : isFailed ? AlertCircle : Check;

  const costCents = session.finalCostCents ?? session.currentCostCents;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding
        companyName={companyName}
        companyLogo={companyLogo}
        linkTo={`/charge/${session.stationOcppId}/${String(session.evseId)}`}
      />

      <div className="w-full max-w-sm space-y-4">
        {/* Status badge */}
        <div className="text-center space-y-2">
          <div
            className={`inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-xl font-bold capitalize ${statusClass}${isCharging ? ' animate-status-pulse' : isFailed ? ' animate-flash' : ''}`}
          >
            <StatusIcon className="h-5 w-5" />
            {isIdle ? t('sessionDetail.idle') : statusLabel(session.status, t)}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('guest.stationPort', { stationId: session.stationOcppId, evseId: session.evseId })}
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <Clock className="mx-auto h-5 w-5 text-muted-foreground mb-1" />
              <p className="text-xs text-muted-foreground h-8 flex items-center justify-center">
                {t('guestSession.duration')}
              </p>
              <p className="text-base font-bold">
                {isActive ? elapsed : formatStaticDuration(session.startedAt, session.endedAt)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="mx-auto h-5 w-5 text-muted-foreground mb-1" />
              <p className="text-xs text-muted-foreground h-8 flex items-center justify-center">
                {isDone ? t('guestSession.totalCost') : t('guestSession.estimatedCost')}
              </p>
              <p className="text-base font-bold">
                {formatCents(costCents, session.currency ?? undefined)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Zap className="mx-auto h-5 w-5 text-muted-foreground mb-1" />
              <p className="text-xs text-muted-foreground h-8 flex items-center justify-center">
                {t('guestSession.energyDelivered')}
              </p>
              <p className="text-base font-bold">{formatEnergy(session.energyDeliveredWh)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        {(isActive || isDone) && (
          <SessionCharts
            powerData={powerHistory?.data ?? []}
            energyData={energyHistory?.data ?? []}
            energyDeliveredWh={session.energyDeliveredWh ?? null}
          />
        )}

        {/* Session details (only show once charging has started) */}
        {(isCharging || isDone || isFailed) && (
          <Card>
            <CardContent className="p-4 space-y-3">
              {session.startedAt != null && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('guestSession.started')}</span>
                  <span className="font-medium">{formatDate(session.startedAt)}</span>
                </div>
              )}
              {session.endedAt != null && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('guestSession.ended')}</span>
                  <span className="font-medium">{formatDate(session.endedAt)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Failure reason */}
        {isFailed && session.failureReason != null && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{session.failureReason}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stop button */}
        {isCharging && (
          <Button
            variant="destructive"
            className="w-full"
            size="lg"
            onClick={() => {
              setShowStopConfirm(true);
            }}
            disabled={stopping}
          >
            <StopCircle className="mr-2 h-5 w-5" />
            {stopping ? t('guestSession.stopping') : t('guestSession.stopCharging')}
          </Button>
        )}

        <ConfirmDialog
          open={showStopConfirm}
          onOpenChange={setShowStopConfirm}
          title={t('guestSession.stopCharging')}
          description={t('sessionDetail.stopConfirmation')}
          confirmLabel={t('guestSession.stopCharging')}
          onConfirm={() => void handleStop()}
          variant="destructive"
          isPending={stopping}
        />

        {isDone && (
          <ConfirmDialog
            open={showReceiptDialog}
            onOpenChange={setShowReceiptDialog}
            title={t('status.completed')}
            description={t('guestSession.receiptMessage')}
            confirmLabel={t('common.ok')}
            onConfirm={() => {
              void navigate(`/charge/${session.stationOcppId}/${String(session.evseId)}`);
            }}
            hideCancel
          />
        )}

        {isActive && !isCharging && (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-sm text-muted-foreground animate-pulse">
                {t('guestSession.waitingForCharger')}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
