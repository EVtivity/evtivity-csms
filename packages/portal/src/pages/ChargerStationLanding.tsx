// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';
import { ChargerHeading } from '@/components/ChargerHeading';
import { PortCard, PortGrid } from '@/components/PortCard';
import { formatDate } from '@/lib/utils';
import { isStartable, portDisplayStatus } from '@/lib/connector-status';
import { useStationEvents } from '@/hooks/use-station-events';
import { EmptyState } from '@/components/ui/content-state';
import { evseDisplayStatus } from '@evtivity/lib/evse-status';
import { chargerUnitQuery } from '@/lib/station-units';

interface ConnectorItem {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface EvseItem {
  evseId: number;
  /** The unit (physical charger box) of the EVSE, null when it has none. */
  unitId?: string | null;
  connectors: ConnectorItem[];
  reservationExpiresAt: string | null;
}

interface StationInfo {
  stationId: string;
  siteId: string | null;
  model: string | null;
  isOnline: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  evses: EvseItem[];
  /** Units of a station with several charger boxes; each is its own charger to drivers. */
  units?: { id: string; name: string; evseIds: number[]; availableCount: number }[];
  maintenance: { active: boolean; plannedEndAt: string | null; message: string | null } | null;
  stationUnavailable: boolean;
}

export function ChargerStationLanding(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId } = useParams<{ stationId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // `?unit=<id>` shows one unit (charger box) of a station with units as its
  // own charger, as the signed-in charger page does. A unit id the station
  // does not have is ignored, so the page never names another station's unit.
  const unitParam = searchParams.get('unit');
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  // Signed-out visitors see times in the browser's time zone.
  const timezone = useAuth((s) => s.driver?.timezone);
  const { companyName, companyLogo, branding } = useAuthBranding();
  useStationEvents(stationId);

  useEffect(() => {
    if (isAuthenticated && stationId != null) {
      void navigate(`/start/${stationId}${chargerUnitQuery(unitParam)}`, { replace: true });
    }
  }, [isAuthenticated, stationId, unitParam, navigate]);

  const {
    data: station,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['station-landing', stationId],
    queryFn: () => api.get<StationInfo>(`/v1/portal/chargers/${stationId ?? ''}`),
    enabled: stationId != null,
    // SSE via useStationEvents is the primary update path -- it invalidates
    // this query within ~50ms of any 'station.status' event. Polling at 2s
    // is a defensive fallback for transient SSE drops.
    refetchInterval: 2000,
    // Override the global 30s staleTime so re-mount and focus always refetch
    // the live connector status instead of serving cached state.
    staleTime: 0,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('charger.loadingInfo')}</p>
      </div>
    );
  }

  if (error != null || station == null) {
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

  const activeUnit = (station.units ?? []).find((unit) => unit.id === unitParam);
  const shownEvses =
    activeUnit != null
      ? station.evses.filter((evse) => evse.unitId === activeUnit.id)
      : station.evses;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {activeUnit != null ? (
            // A unit charger: the driver heading (box, station, location).
            <ChargerHeading
              title={activeUnit.name}
              stationId={station.stationId}
              siteName={station.siteName}
              align="center"
            />
          ) : (
            <>
              <CardTitle data-testid="charger-title">{station.stationId}</CardTitle>
              {station.siteName != null && (
                <p className="text-sm text-muted-foreground">{station.siteName}</p>
              )}
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Location */}
          {station.siteAddress != null && station.siteId != null ? (
            <Link
              to={`/location/${station.siteId}?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
              className="flex items-start gap-2 text-sm text-link hover:underline transition-colors"
            >
              <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>
                {station.siteAddress}
                {station.siteCity != null && `, ${station.siteCity}`}
                {station.siteState != null && `, ${station.siteState}`}
              </span>
            </Link>
          ) : station.siteAddress != null ? (
            <div className="flex items-start gap-2 text-sm">
              <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <span>
                {station.siteAddress}
                {station.siteCity != null && `, ${station.siteCity}`}
                {station.siteState != null && `, ${station.siteState}`}
              </span>
            </div>
          ) : null}

          {!station.isOnline && (
            <Alert variant="warning" data-testid="station-offline-notice">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{t('charger.offlineNotice')}</AlertDescription>
            </Alert>
          )}

          {station.stationUnavailable && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{t('errors.STATION_UNAVAILABLE')}</AlertDescription>
            </Alert>
          )}

          {station.maintenance?.active === true && (
            <Alert variant="warning" className="items-start">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div>
                <AlertTitle>{t('charger.maintenanceTitle')}</AlertTitle>
                <AlertDescription>
                  {station.maintenance.plannedEndAt != null && (
                    <p>
                      {t('charger.maintenanceUntil', {
                        time: formatDate(station.maintenance.plannedEndAt, timezone),
                      })}
                    </p>
                  )}
                  {station.maintenance.message != null &&
                    station.maintenance.message.length > 0 && (
                      <p className="mt-1">{station.maintenance.message}</p>
                    )}
                </AlertDescription>
              </div>
            </Alert>
          )}

          {/* EVSE selection */}
          {shownEvses.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">{t('stationDetail.selectConnector')}</p>
              <PortGrid count={shownEvses.length}>
                {shownEvses.map((evse) => {
                  const connectorStatus = evseDisplayStatus(evse.connectors.map((c) => c.status));
                  const maintenanceBlocks = station.maintenance?.active === true;
                  // Block reserved EVSEs even after the holder plugs in: the
                  // connector flips to `preparing`/`occupied`, both of which
                  // are startable -- without this guests could start against
                  // the holder's plug. Authenticated drivers use ChargerDetail
                  // which knows their identity and can let the holder through.
                  const isReserved = evse.reservationExpiresAt != null;
                  const isAvailable =
                    !maintenanceBlocks &&
                    !station.stationUnavailable &&
                    !isReserved &&
                    isStartable(connectorStatus) &&
                    station.isOnline;
                  return (
                    <PortCard
                      key={evse.evseId}
                      evseId={evse.evseId}
                      connectors={evse.connectors}
                      status={portDisplayStatus(connectorStatus, isAvailable)}
                      available={isAvailable}
                      reservationExpiresAt={evse.reservationExpiresAt}
                      timezone={timezone}
                      onSelect={() => {
                        void navigate(`/charge/${stationId ?? ''}/${String(evse.evseId)}`);
                      }}
                    />
                  );
                })}
              </PortGrid>
            </>
          )}

          {shownEvses.length === 0 && <EmptyState>{t('charger.stationNotAvailable')}</EmptyState>}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
