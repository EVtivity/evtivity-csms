// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Zap,
  Clock,
  DollarSign,
  MapPin,
  Pause,
  CircleStop,
  AlertCircle,
  Check,
  Leaf,
  CalendarClock,
  ChevronRight,
} from 'lucide-react';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorCard } from '@/components/ui/error-card';
import { useToast } from '@/components/ui/toast';
import { SessionCharts } from '@/components/SessionCharts';
import { ReportIssue } from '@/components/ReportIssue';
import { api } from '@/lib/api';
import { formatCents, formatEnergy, formatDate, formatDistance } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useDriverTimezone } from '@/lib/timezone';

interface SessionDetailData {
  id: string;
  transactionId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  energyDeliveredWh: string | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string | null;
  meterStart: number | null;
  meterStop: number | null;
  stoppedReason: string | null;
  stationName: string | null;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  updatedAt: string | null;
  idleStartedAt: string | null;
  currentPowerW: number | null;
  batteryPercent: number | null;
  co2AvoidedKg: number | null;
  payment: {
    status: string;
    preAuthAmountCents: number | null;
    capturedAmountCents: number | null;
    currency: string;
  } | null;
  reservationId: string | null;
  token: { idToken: string; tokenType: string } | null;
  vehicle: {
    id: string;
    make: string | null;
    model: string | null;
    year: string | null;
    efficiencyMiPerKwh: number;
  } | null;
}

interface DriverVehicle {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
}

interface PortalFeatures {
  reservationEnabled: boolean;
  supportEnabled: boolean;
}

interface PowerHistoryResponse {
  data: Array<{ timestamp: string; powerW: number }>;
}

interface EnergyHistoryResponse {
  data: Array<{ timestamp: string; energyWh: number }>;
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

export function SessionDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const fromCharge = (location.state as { fromCharge?: boolean } | null)?.fromCharge === true;
  const timezone = useDriverTimezone();
  const distanceUnit = useAuth((s) => s.driver?.distanceUnit ?? 'miles');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showVehicleDialog, setShowVehicleDialog] = useState(false);
  const [pendingVehicleId, setPendingVehicleId] = useState<string | null>(null);

  const { data: session, isLoading } = useQuery({
    queryKey: ['portal-session', id],
    queryFn: () => api.get<SessionDetailData>(`/v1/portal/sessions/${id ?? ''}`),
    enabled: id != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'active') return 5000;
      return false;
    },
  });

  const isActive = session?.status === 'active';
  const isIdle = isActive && session.idleStartedAt != null;

  const { data: powerHistory } = useQuery({
    queryKey: ['portal-session-power', id],
    queryFn: () => api.get<PowerHistoryResponse>(`/v1/portal/sessions/${id ?? ''}/power-history`),
    enabled: id != null && isActive,
    refetchInterval: isActive ? 10000 : false,
  });

  const { data: energyHistory } = useQuery({
    queryKey: ['portal-session-energy', id],
    queryFn: () => api.get<EnergyHistoryResponse>(`/v1/portal/sessions/${id ?? ''}/energy-history`),
    enabled: id != null && isActive,
    refetchInterval: isActive ? 10000 : false,
  });

  const { data: driverVehicles } = useQuery({
    queryKey: ['portal-vehicles'],
    queryFn: () => api.get<DriverVehicle[]>('/v1/portal/vehicles'),
    enabled: showVehicleDialog,
  });

  const setVehicleMutation = useMutation({
    mutationFn: (vehicleId: string | null) =>
      api.patch(`/v1/portal/sessions/${id ?? ''}/vehicle`, { vehicleId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-session', id] });
      setShowVehicleDialog(false);
    },
    onError: () => {
      toast({ variant: 'destructive', title: t('sessionDetail.vehicleUpdateFailed') });
    },
  });

  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<PortalFeatures>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });

  const stopMutation = useMutation({
    mutationFn: () => api.post(`/v1/portal/chargers/sessions/${id ?? ''}/stop`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-session', id] });
      void queryClient.invalidateQueries({ queryKey: ['portal-active-sessions'] });
    },
    onError: () => {
      setStopping(false);
      setShowStopConfirm(false);
      toast({ variant: 'destructive', title: t('sessionDetail.stopFailed') });
    },
  });

  // Hold the spinner until the polled session.status transitions out of 'active'
  // (mirrors the guest flow). The mutation only confirms the API accepted the
  // request; the actual stop happens after the OCPP roundtrip.
  useEffect(() => {
    if (!stopping) return;
    if (session != null && session.status !== 'active') {
      setStopping(false);
      setShowStopConfirm(false);
    }
  }, [session?.status, stopping]);

  // Safety timeout. If the station never acks (offline, dropped command, etc.)
  // clear the spinner and surface a toast so the user can retry.
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => {
      setStopping(false);
      setShowStopConfirm(false);
      toast({ variant: 'warning', title: t('sessionDetail.stopTimeout') });
    }, 30000);
    return () => {
      clearTimeout(timer);
    };
  }, [stopping, toast, t]);

  const elapsed = useElapsedTime(session?.startedAt, isActive);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (session == null) {
    return <ErrorCard message={t('sessionDetail.notFound')} />;
  }

  const costCents = session.finalCostCents ?? session.currentCostCents;
  const cost =
    costCents != null && costCents === 0
      ? t('sessionDetail.free')
      : formatCents(costCents, session.currency ?? 'USD');
  const energy = formatEnergy(session.energyDeliveredWh);
  const efficiency = session.vehicle?.efficiencyMiPerKwh ?? 3.5;
  const miles = formatDistance(session.energyDeliveredWh, efficiency, distanceUnit);
  const vehicleLabel =
    session.vehicle != null
      ? [session.vehicle.make, session.vehicle.model]
          .filter((v) => v != null && v !== '')
          .join(' ') +
        (session.vehicle.year != null && session.vehicle.year !== ''
          ? ` (${session.vehicle.year})`
          : '')
      : null;

  const isFaulted = session.status === 'faulted' || session.status === 'failed';

  const statusClass = isIdle
    ? 'bg-warning text-warning-foreground'
    : isActive
      ? 'bg-success text-success-foreground'
      : isFaulted
        ? 'bg-destructive text-destructive-foreground'
        : 'bg-primary text-primary-foreground';

  const StatusIcon = isActive && !isIdle ? Zap : isIdle ? Pause : isFaulted ? AlertCircle : Check;

  const statusLabel = isIdle
    ? t('sessionDetail.idle')
    : isActive
      ? t('sessionDetail.charging')
      : session.status;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.back')}
          onClick={() => {
            if (fromCharge) {
              void navigate('/');
            } else {
              void navigate(-1);
            }
          }}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold">{t('sessionDetail.title')}</h1>
          <CopyableId id={id ?? ''} />
        </div>
      </div>

      {/* Status and miles estimate */}
      <div className="text-center space-y-2">
        <div
          className={`inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-xl font-bold capitalize ${statusClass}${isActive ? ' animate-status-pulse' : isFaulted ? ' animate-flash' : ''}`}
        >
          <StatusIcon className="h-5 w-5" />
          {statusLabel}
        </div>
        {session.energyDeliveredWh != null && (
          <button
            type="button"
            onClick={() => {
              setPendingVehicleId(session.vehicle?.id ?? null);
              setShowVehicleDialog(true);
            }}
            className="block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
            aria-label={t('sessionDetail.changeVehicle')}
          >
            <p className="text-3xl font-bold hover:underline decoration-dotted underline-offset-4">
              {miles}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {vehicleLabel ?? t('sessionDetail.tapToSetVehicle')}
            </p>
          </button>
        )}
        {isActive && session.updatedAt != null && (
          <p className="text-xs text-muted-foreground">
            {t('sessionDetail.lastUpdated', {
              time: formatDate(session.updatedAt, timezone),
            })}
          </p>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <Clock className="mx-auto h-5 w-5 text-muted-foreground mb-1" />
            <p className="text-xs text-muted-foreground h-8 flex items-center justify-center">
              {t('sessionDetail.timeElapsed')}
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
              {t(isActive ? 'sessionDetail.cost' : 'sessionDetail.totalCost')}
            </p>
            <p className="text-base font-bold">{cost}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <Zap className="mx-auto h-5 w-5 text-muted-foreground mb-1" />
            <p className="text-xs text-muted-foreground h-8 flex items-center justify-center">
              {t('sessionDetail.energyAdded')}
            </p>
            <p className="text-base font-bold">{energy}</p>
          </CardContent>
        </Card>
      </div>

      {/* CO2 avoided */}
      {session.co2AvoidedKg != null && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Leaf className="h-5 w-5 text-success shrink-0" />
            <p className="text-sm font-medium text-success">
              {session.co2AvoidedKg.toFixed(2)} kg {t('sessions.co2Avoided')}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Charts (active sessions) */}
      {isActive && (
        <SessionCharts
          powerData={powerHistory?.data ?? []}
          energyData={energyHistory?.data ?? []}
          currentPowerW={session.currentPowerW}
          batteryPercent={session.batteryPercent}
          energyDeliveredWh={session.energyDeliveredWh}
        />
      )}

      {/* Stop session button (active sessions) */}
      {isActive && (
        <Button
          variant="destructive"
          className="w-full"
          size="lg"
          disabled={stopping}
          onClick={() => {
            setShowStopConfirm(true);
          }}
        >
          <CircleStop className="mr-2 h-5 w-5" />
          {stopping ? t('sessionDetail.stopping') : t('sessionDetail.stopCharging')}
        </Button>
      )}

      {/* Station info */}
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <MapPin className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">
              {session.stationName ?? t('sessionDetail.unknownStation')}
            </p>
            {session.siteName != null && (
              <p className="text-sm text-muted-foreground">{session.siteName}</p>
            )}
            {(session.siteAddress != null || session.siteCity != null) && (
              <p className="text-xs text-muted-foreground">
                {[session.siteAddress, session.siteCity, session.siteState]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Reservation link (hidden when reservations disabled system-wide) */}
      {session.reservationId != null && features?.reservationEnabled !== false && (
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => {
            void navigate(`/reservations/${session.reservationId ?? ''}`);
          }}
        >
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <CalendarClock className="h-5 w-5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium">{t('sessionDetail.fromReservation')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('sessionDetail.fromReservationHint')}
                </p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      {/* Session details (completed/all sessions) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('sessionDetail.details')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Row label={t('sessionDetail.started')} value={formatDate(session.startedAt, timezone)} />
          {session.endedAt != null && (
            <Row label={t('sessionDetail.ended')} value={formatDate(session.endedAt, timezone)} />
          )}
          <Row label={t('sessionDetail.energy')} value={energy} />
          {session.batteryPercent != null && (
            <Row
              label={t('sessionDetail.battery')}
              value={`${session.batteryPercent.toFixed(0)}%`}
            />
          )}
          <Row
            label={t(isActive ? 'sessionDetail.cost' : 'sessionDetail.totalCost')}
            value={cost}
          />
          {session.stoppedReason != null && (
            <Row label={t('sessionDetail.stopReason')} value={session.stoppedReason} />
          )}
          {session.token != null && (
            <Row label={t('sessionDetail.rfid')} value={session.token.idToken} />
          )}
        </CardContent>
      </Card>

      {/* Payment info */}
      {session.payment != null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('sessionDetail.payment')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Row
              label={t('sessionDetail.status')}
              value={t(`paymentStatus.${session.payment.status}`, {
                defaultValue: session.payment.status,
              })}
            />
            <Row
              label={t('sessionDetail.preAuthorized')}
              value={formatCents(session.payment.preAuthAmountCents, session.payment.currency)}
            />
            <Row
              label={t('sessionDetail.captured')}
              value={formatCents(session.payment.capturedAmountCents, session.payment.currency)}
            />
          </CardContent>
        </Card>
      )}

      {/* Report issue */}
      <ReportIssue
        sessionId={session.id}
        stationName={session.stationName != null ? session.stationName : undefined}
      />

      {/* Vehicle picker dialog */}
      <ConfirmDialog
        open={showVehicleDialog}
        onOpenChange={(open) => {
          if (setVehicleMutation.isPending && !open) return;
          setShowVehicleDialog(open);
        }}
        title={t('sessionDetail.changeVehicle')}
        description={
          driverVehicles != null && driverVehicles.length === 0
            ? t('sessionDetail.noVehiclesAdd')
            : t('sessionDetail.changeVehicleDescription')
        }
        confirmLabel={
          driverVehicles != null && driverVehicles.length === 0
            ? t('sessionDetail.goToAccount')
            : t('common.save')
        }
        cancelLabel={t('common.cancel')}
        isPending={setVehicleMutation.isPending}
        onConfirm={() => {
          if (driverVehicles != null && driverVehicles.length === 0) {
            void navigate('/account');
            return undefined;
          }
          if (pendingVehicleId !== (session.vehicle?.id ?? null)) {
            setVehicleMutation.mutate(pendingVehicleId);
            return false;
          }
          return undefined;
        }}
      >
        {driverVehicles != null && driverVehicles.length > 0 && (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {driverVehicles.map((v) => {
              const label =
                [v.make, v.model].filter((p) => p != null && p !== '').join(' ') +
                (v.year != null && v.year !== '' ? ` (${v.year})` : '');
              const checked = pendingVehicleId === v.id;
              return (
                <label
                  key={v.id}
                  className={`flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                    checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="session-vehicle"
                    value={v.id}
                    checked={checked}
                    onChange={() => {
                      setPendingVehicleId(v.id);
                    }}
                    className="h-4 w-4 text-primary"
                  />
                  <span className="text-sm font-medium">{label}</span>
                </label>
              );
            })}
            {pendingVehicleId != null && (
              <button
                type="button"
                onClick={() => {
                  setPendingVehicleId(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                {t('sessionDetail.clearVehicle')}
              </button>
            )}
          </div>
        )}
      </ConfirmDialog>

      {/* Stop confirmation dialog */}
      <ConfirmDialog
        open={showStopConfirm}
        onOpenChange={(open) => {
          // Block manual close while waiting for station ack -- effects above
          // close the dialog when terminal status arrives or the timeout fires.
          if (stopping && !open) return;
          setShowStopConfirm(open);
        }}
        title={t('sessionDetail.stopCharging')}
        description={t('sessionDetail.stopConfirmation')}
        confirmLabel={stopping ? t('sessionDetail.stopping') : t('sessionDetail.stopCharging')}
        onConfirm={() => {
          setStopping(true);
          stopMutation.mutate();
          return false;
        }}
        variant="destructive"
        isPending={stopping}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function formatStaticDuration(startedAt: string | null, endedAt: string | null): string {
  if (startedAt == null || endedAt == null) return '--';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return '--';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}
