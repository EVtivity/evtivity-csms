// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, Plug, Info } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { PricingDisplay } from '@/components/PricingDisplay';
import type { PricingInfo } from '@/components/PricingDisplay';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { connectorStatusVariant, connectorStatusClassName } from '@/lib/connector-status';
import {
  checkGuestConnectorStatus,
  isCableDetected,
  formatConnectorType,
} from '@/lib/charger-utils';
import { useStationEvents } from '@/hooks/use-station-events';

interface ChargerInfo {
  stationId: string;
  siteId: string | null;
  model: string | null;
  isOnline: boolean;
  isSimulator: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  evse: {
    evseId: number;
    connectors: Array<{
      connectorId: number;
      connectorType: string | null;
      maxPowerKw: number | null;
      maxCurrentAmps: number | null;
      status: string;
    }>;
    reservationExpiresAt: string | null;
  };
  maintenance: { active: boolean; plannedEndAt: string | null; message: string | null } | null;
}

export function ChargerLanding(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId, evseId } = useParams<{ stationId: string; evseId: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const { companyName, companyLogo, branding } = useAuthBranding();
  useStationEvents(stationId);

  useEffect(() => {
    if (isAuthenticated && stationId != null) {
      const path = evseId != null ? `/start/${stationId}?evse=${evseId}` : `/start/${stationId}`;
      void navigate(path, { replace: true });
    }
  }, [isAuthenticated, stationId, evseId, navigate]);

  const {
    data: charger,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['charger-info', stationId, evseId],
    queryFn: () =>
      api.get<ChargerInfo>(`/v1/portal/chargers/${stationId ?? ''}/evse/${evseId ?? ''}`),
    enabled: stationId != null && evseId != null,
    // SSE via useStationEvents is the primary update path -- it invalidates
    // this query within ~50ms of any 'station.status' event. Polling at 2s
    // is a defensive fallback that catches transient SSE drops or events
    // missed during page transitions. Stays within the 60/min rate limit.
    refetchInterval: 2000,
    // Override the global 30s staleTime: connector status must never serve
    // a stale cached value when the page mounts or the tab regains focus.
    // Without this, navigating back within 30s would render the last-known
    // status (e.g. 'preparing' from a prior plug-in) before the next poll
    // catches up to the current 'finishing'.
    staleTime: 0,
  });

  const { data: guestConfig } = useQuery({
    queryKey: ['guest-charger-config', stationId, evseId],
    queryFn: () =>
      api.get<{
        isFree: boolean;
        paymentEnabled?: boolean;
        isSimulator?: boolean;
        pricing?: PricingInfo;
      }>(`/v1/portal/guest/charger-config/${stationId ?? ''}/${evseId ?? ''}`),
    enabled: stationId != null && evseId != null,
    retry: false,
  });

  const displayPricing = guestConfig?.pricing ?? null;

  const [freeStartLoading, setFreeStartLoading] = useState(false);
  const [freeStartError, setFreeStartError] = useState('');
  const [showEvWarning, setShowEvWarning] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  async function handleFreeStart(): Promise<void> {
    if (stationId == null || evseId == null) return;
    setFreeStartError('');
    setFreeStartLoading(true);
    try {
      const result = await api.post<{ sessionToken: string }>(
        `/v1/portal/guest/start/${stationId}/${evseId}`,
        {},
      );
      void navigate(`/guest-session/${result.sessionToken}`);
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setFreeStartError(body.error ?? t('guest.paymentFailed'));
      } else {
        setFreeStartError(t('guest.paymentFailed'));
      }
    } finally {
      setFreeStartLoading(false);
    }
  }

  async function handleFreeStartCheck(): Promise<void> {
    if (stationId == null || evseId == null) return;
    setFreeStartError('');
    setIsCheckingStatus(true);
    try {
      const result = await checkGuestConnectorStatus(stationId, evseId);
      setIsCheckingStatus(false);

      if (result.error != null) {
        setFreeStartError(result.error);
        return;
      }

      if (!isCableDetected(result.connectorStatus)) {
        setShowEvWarning(true);
        return;
      }

      await handleFreeStart();
    } catch {
      setIsCheckingStatus(false);
      setFreeStartError(t('charger.statusCheckFailed'));
    }
  }

  async function handlePaidCheck(): Promise<void> {
    if (stationId == null || evseId == null) return;
    setFreeStartError('');
    setIsCheckingStatus(true);
    try {
      const result = await checkGuestConnectorStatus(stationId, evseId);
      setIsCheckingStatus(false);

      if (result.error != null) {
        setFreeStartError(result.error);
        return;
      }

      if (!isCableDetected(result.connectorStatus)) {
        setShowEvWarning(true);
        return;
      }

      void navigate(`/charge/${stationId}/${evseId}/checkout`);
    } catch {
      setIsCheckingStatus(false);
      setFreeStartError(t('charger.statusCheckFailed'));
    }
  }

  const isFreeForGuest = guestConfig?.isFree === true;
  const paymentNotConfigured = !isFreeForGuest && guestConfig?.paymentEnabled !== true;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('charger.loadingInfo')}</p>
      </div>
    );
  }

  if (error != null || charger == null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} />
        <Card className="w-full max-w-sm text-center">
          <CardContent className="p-6">
            <p className="text-destructive">{t('charger.notFound')}</p>
          </CardContent>
        </Card>
        <AuthFooter companyName={companyName} branding={branding} />
      </div>
    );
  }

  const connectorStatus = charger.evse.connectors[0]?.status ?? 'unavailable';
  // 'finishing' (OCPP 1.6) means cable is still plugged after a previous stop;
  // real stations accept a new RemoteStart from this state without an unplug
  // cycle. The OCPP 2.1 equivalent is 'occupied' which is already in the set.
  const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected', 'finishing'];
  // Reserved connectors are never available for guest checkout, even when
  // their status flips to `preparing`/`occupied` after the reservation
  // holder plugs in. The portal-authenticated flow (ChargerDetail) handles
  // the reservation-holder case; guests must always be blocked.
  const isReserved = charger.evse.reservationExpiresAt != null;
  const isAvailable =
    charger.maintenance?.active !== true &&
    startableStatuses.includes(connectorStatus) &&
    !isReserved;
  const maxPower = charger.evse.connectors.reduce((max, c) => Math.max(max, c.maxPowerKw ?? 0), 0);
  const maxCurrent = charger.evse.connectors.reduce(
    (max, c) => Math.max(max, c.maxCurrentAmps ?? 0),
    0,
  );
  const connectorTypes = charger.evse.connectors
    .map((c) => c.connectorType)
    .filter((ct): ct is string => ct != null)
    .map(formatConnectorType);

  const isCharging = ['charging', 'discharging'].includes(connectorStatus);
  const isIdleState = ['suspended_ev', 'suspended_evse', 'idle'].includes(connectorStatus);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card
        className={cn(
          'w-full max-w-sm',
          isCharging && 'ring-2 ring-success animate-pulse',
          isIdleState && 'ring-2 ring-warning animate-pulse',
        )}
      >
        <CardHeader className="text-center">
          <CardTitle>{charger.stationId}</CardTitle>
          {charger.siteName != null && (
            <p className="text-sm text-muted-foreground">{charger.siteName}</p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {charger.maintenance?.active === true && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-left">
              <p className="font-semibold text-sm">{t('charger.maintenanceTitle')}</p>
              {charger.maintenance.plannedEndAt != null && (
                <p className="mt-1 text-xs">
                  {t('charger.maintenanceUntil', {
                    time: new Date(charger.maintenance.plannedEndAt).toLocaleString(),
                  })}
                </p>
              )}
              {charger.maintenance.message != null && charger.maintenance.message.length > 0 && (
                <p className="mt-1 text-xs">{charger.maintenance.message}</p>
              )}
            </div>
          )}

          {/* Location */}
          {charger.siteAddress != null && charger.siteId != null ? (
            <Link
              to={`/location/${charger.siteId}?from=${encodeURIComponent(`/charge/${stationId ?? ''}/${evseId ?? ''}`)}`}
              className="flex items-start gap-2 text-sm text-primary hover:underline transition-colors"
            >
              <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>
                {charger.siteAddress}
                {charger.siteCity != null && `, ${charger.siteCity}`}
                {charger.siteState != null && `, ${charger.siteState}`}
              </span>
            </Link>
          ) : charger.siteAddress != null ? (
            <div className="flex items-start gap-2 text-sm">
              <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>
                {charger.siteAddress}
                {charger.siteCity != null && `, ${charger.siteCity}`}
                {charger.siteState != null && `, ${charger.siteState}`}
              </span>
            </div>
          ) : null}

          {isAvailable && charger.isOnline && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Plug className="h-4 w-4 text-muted-foreground" />
                  <span>{connectorTypes.join(', ')}</span>
                  {(maxPower > 0 || maxCurrent > 0) && (
                    <span className="text-muted-foreground">
                      {maxPower > 0 ? `${String(maxPower)} kW` : ''}
                      {maxPower > 0 && maxCurrent > 0 ? ' / ' : ''}
                      {maxCurrent > 0 ? `${String(maxCurrent)}A` : ''}
                    </span>
                  )}
                </div>
                <Badge
                  variant={connectorStatusVariant()}
                  className={connectorStatusClassName(connectorStatus)}
                >
                  {t(`status.${connectorStatus}`)}
                </Badge>
              </div>
              {displayPricing != null && <PricingDisplay pricing={displayPricing} />}
            </>
          )}

          {/* Actions */}
          {isReserved ? (
            <p className="pt-2 text-center text-sm text-destructive font-medium">
              {t('charger.connectorReserved')}
            </p>
          ) : isAvailable && charger.isOnline ? (
            <div className="space-y-2 pt-2">
              {freeStartError !== '' && (
                <p className="text-sm text-destructive">{freeStartError}</p>
              )}
              {isFreeForGuest ? (
                <Button
                  className="w-full"
                  size="lg"
                  disabled={freeStartLoading || isCheckingStatus}
                  onClick={() => void handleFreeStartCheck()}
                >
                  {isCheckingStatus
                    ? t('charger.checkingStatus')
                    : freeStartLoading
                      ? t('guest.processing')
                      : t('charger.startCharging')}
                </Button>
              ) : paymentNotConfigured ? (
                <p className="text-sm text-muted-foreground text-center">
                  {t('guest.paymentNotConfigured')}
                </p>
              ) : (
                <Button
                  className="w-full"
                  size="lg"
                  disabled={isCheckingStatus}
                  onClick={() => void handlePaidCheck()}
                >
                  {isCheckingStatus ? t('charger.checkingStatus') : t('charger.payWithCard')}
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  void navigate('/login');
                }}
              >
                {t('charger.signIn')}
              </Button>
            </div>
          ) : (
            <p className="pt-2 text-center text-sm text-muted-foreground">
              {t('charger.stationNotAvailable')}
            </p>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={t('common.ok')}
        hideCancel
        onConfirm={() => undefined}
      >
        <EvPlugAnimation />
        {charger.isSimulator && (
          <Alert variant="info" className="mt-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('charger.simulatorPlugInHint')}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}
