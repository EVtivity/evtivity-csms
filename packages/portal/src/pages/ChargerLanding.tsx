// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, Plug } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { PricingDisplay } from '@/components/PricingDisplay';
import type { PricingInfo } from '@/components/PricingDisplay';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
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
}

function connectorStatusVariant(): 'secondary' {
  return 'secondary';
}

function connectorStatusClassName(status: string): string {
  switch (status) {
    case 'available':
      return 'bg-green-500 text-green-50 hover:bg-green-500/80';
    case 'finishing':
      return 'bg-violet-500 text-violet-50 hover:bg-violet-500/80';
    case 'occupied':
    case 'charging':
    case 'discharging':
      return 'bg-blue-500 text-blue-50 hover:bg-blue-500/80';
    case 'preparing':
    case 'ev_connected':
      return 'bg-cyan-500 text-cyan-50 hover:bg-cyan-500/80';
    case 'reserved':
      return 'bg-orange-500 text-orange-50 hover:bg-orange-500/80';
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return 'bg-yellow-500 text-yellow-50 hover:bg-yellow-500/80';
    case 'faulted':
      return 'bg-red-500 text-red-50 hover:bg-red-500/80';
    default:
      return 'bg-red-500 text-red-50 hover:bg-red-500/80';
  }
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
  const [pendingAction, setPendingAction] = useState<'free' | 'paid' | null>(null);

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
    } catch {
      setFreeStartError(t('guest.paymentFailed'));
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
        setPendingAction('free');
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
        setPendingAction('paid');
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
  const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected'];
  const isAvailable = startableStatuses.includes(connectorStatus);
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

          {/* Connector info + status */}
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
          {connectorStatus === 'reserved' && (
            <p className="text-xs text-muted-foreground">
              {charger.evse.reservationExpiresAt != null
                ? t('charger.reservedUntil', {
                    time: formatDate(charger.evse.reservationExpiresAt),
                  })
                : t('charger.reserved')}
            </p>
          )}

          {/* Pricing */}
          {displayPricing != null && <PricingDisplay pricing={displayPricing} />}

          {/* Actions */}
          {isAvailable && charger.isOnline ? (
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
              {t('charger.notAvailable')}
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
        confirmLabel={charger.isSimulator ? t('charger.startForSimulation') : t('common.ok')}
        hideCancel={!charger.isSimulator}
        onConfirm={() => {
          if (!charger.isSimulator) return;
          if (pendingAction === 'free') void handleFreeStart();
          if (pendingAction === 'paid')
            void navigate(`/charge/${stationId ?? ''}/${evseId ?? ''}/checkout`);
        }}
      >
        <EvPlugAnimation />
      </ConfirmDialog>
    </div>
  );
}
