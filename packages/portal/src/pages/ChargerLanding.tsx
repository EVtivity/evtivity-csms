// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, MapPin, Info } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { PricingDisplay } from '@/components/PricingDisplay';
import { usePriceDisplay } from '@/hooks/use-price-display';
import type { PricingInfo } from '@/components/PricingDisplay';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { api } from '@/lib/api';
import { ChargerHeading } from '@/components/ChargerHeading';
import { PortCard } from '@/components/PortCard';
import { getErrorMessage } from '@/lib/error-message';
import { formatDate } from '@/lib/utils';
import { isStartable } from '@/lib/connector-status';
import { checkGuestConnectorStatus, qrTransactionLimits } from '@/lib/charger-utils';
import { guestStartExtras } from '@/lib/guest-start';
import { useStationEvents } from '@/hooks/use-station-events';
import { useCableCheck } from '@/hooks/use-cable-check';
import { evseDisplayStatus } from '@evtivity/lib/evse-status';
import { loginPathFor } from '@/lib/return-path';
import { GuestAccountPrompt } from '@/components/GuestAccountPrompt';

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
  /** The unit (physical charger box) of the EVSE, null when it has none. */
  unit?: { id: string; name: string } | null;
  maintenance: { active: boolean; plannedEndAt: string | null; message: string | null } | null;
  stationUnavailable: boolean;
}

export function ChargerLanding(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { stationId, evseId } = useParams<{ stationId: string; evseId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // Sign-in returns the guest to this charger page.
  const loginPath = loginPathFor(`${location.pathname}${location.search}`);
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const priceDisplay = usePriceDisplay();
  // Signed-out visitors see times in the browser's time zone.
  const timezone = useAuth((s) => s.driver?.timezone);
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
  const { isCheckingStatus, showEvWarning, setShowEvWarning, runWithCableCheck } = useCableCheck();

  async function handleFreeStart(): Promise<void> {
    if (stationId == null || evseId == null) return;
    setFreeStartError('');
    setFreeStartLoading(true);
    try {
      const extras = await guestStartExtras(stationId, evseId, i18n.language);
      const result = await api.post<{ sessionToken: string }>(
        `/v1/portal/guest/start/${stationId}/${evseId}`,
        { ...qrTransactionLimits(searchParams), ...extras },
      );
      void navigate(`/guest-session/${result.sessionToken}`);
    } catch (err: unknown) {
      setFreeStartError(getErrorMessage(err, t, 'guest.paymentFailed'));
    } finally {
      setFreeStartLoading(false);
    }
  }

  async function handleFreeStartCheck(): Promise<void> {
    if (stationId == null || evseId == null) return;
    await runWithCableCheck(
      () => checkGuestConnectorStatus(stationId, evseId),
      () => handleFreeStart(),
      setFreeStartError,
    );
  }

  async function handlePaidCheck(): Promise<void> {
    if (stationId == null || evseId == null) return;
    await runWithCableCheck(
      () => checkGuestConnectorStatus(stationId, evseId),
      () => {
        // Keep the QR code limit parameters (maxenergy, maxtime, maxcost).
        void navigate(`/charge/${stationId}/${evseId}/checkout?${searchParams.toString()}`);
      },
      setFreeStartError,
    );
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

  const connectorStatus = evseDisplayStatus(charger.evse.connectors.map((c) => c.status));
  // Reserved connectors are never available for guest checkout, even when
  // their status flips to `preparing`/`occupied` after the reservation
  // holder plugs in. The portal-authenticated flow (ChargerDetail) handles
  // the reservation-holder case; guests must always be blocked.
  const isReserved = charger.evse.reservationExpiresAt != null;
  const isAvailable =
    charger.maintenance?.active !== true &&
    !charger.stationUnavailable &&
    isStartable(connectorStatus) &&
    !isReserved;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      {/* The port card carries the charging and idle rings. */}
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {charger.unit != null ? (
            // A unit charger: the driver heading (box, station, location).
            <ChargerHeading
              title={charger.unit.name}
              stationId={charger.stationId}
              siteName={charger.siteName}
              align="center"
            />
          ) : (
            <>
              <CardTitle data-testid="charger-title">{charger.stationId}</CardTitle>
              {charger.siteName != null && (
                <p className="text-sm text-muted-foreground">{charger.siteName}</p>
              )}
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {charger.stationUnavailable && (
            <Alert variant="destructive" className="text-left">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{t('errors.STATION_UNAVAILABLE')}</AlertDescription>
            </Alert>
          )}
          {charger.maintenance?.active === true && (
            <Alert variant="warning" className="items-start text-left">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div>
                <AlertTitle>{t('charger.maintenanceTitle')}</AlertTitle>
                <AlertDescription>
                  {charger.maintenance.plannedEndAt != null && (
                    <p>
                      {t('charger.maintenanceUntil', {
                        time: formatDate(charger.maintenance.plannedEndAt, timezone),
                      })}
                    </p>
                  )}
                  {charger.maintenance.message != null &&
                    charger.maintenance.message.length > 0 && (
                      <p className="mt-1">{charger.maintenance.message}</p>
                    )}
                </AlertDescription>
              </div>
            </Alert>
          )}

          {/* Location */}
          {charger.siteAddress != null && charger.siteId != null ? (
            <Link
              to={`/location/${charger.siteId}?from=${encodeURIComponent(`/charge/${stationId ?? ''}/${evseId ?? ''}`)}`}
              className="flex items-start gap-2 text-sm text-link hover:underline transition-colors"
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

          {/* The port, as the port lists show it. */}
          <PortCard
            testId="charger-port"
            evseId={charger.evse.evseId}
            connectors={charger.evse.connectors}
            status={connectorStatus}
            available={isAvailable && charger.isOnline}
            reservationExpiresAt={charger.evse.reservationExpiresAt}
            timezone={timezone}
          />

          {isAvailable && charger.isOnline && displayPricing != null && priceDisplay != null && (
            <PricingDisplay pricing={displayPricing} priceDisplay={priceDisplay} />
          )}

          {/* Actions */}
          {guestConfig == null ? (
            <p className="pt-2 text-center text-sm text-muted-foreground">
              {t('charger.loadingInfo')}
            </p>
          ) : isReserved ? (
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
                // No guest payment here: the guest charges with an account.
                <GuestAccountPrompt />
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
              {!paymentNotConfigured && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    void navigate(loginPath);
                  }}
                >
                  {t('charger.signIn')}
                </Button>
              )}
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
        {charger.isSimulator && (
          <Alert variant="info" className="mb-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('charger.simulatorPlugInHint')}</AlertDescription>
          </Alert>
        )}
        <EvPlugAnimation connectorType={charger.evse.connectors[0]?.connectorType} />
      </ConfirmDialog>
    </div>
  );
}
