// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, Plug } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { formatConnectorType } from '@/lib/charger-utils';
import { useStationEvents } from '@/hooks/use-station-events';

interface ConnectorItem {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface EvseItem {
  evseId: number;
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

export function ChargerStationLanding(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId } = useParams<{ stationId: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const { companyName, companyLogo, branding } = useAuthBranding();
  useStationEvents(stationId);

  useEffect(() => {
    if (isAuthenticated && stationId != null) {
      void navigate(`/start/${stationId}`, { replace: true });
    }
  }, [isAuthenticated, stationId, navigate]);

  const {
    data: station,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['station-landing', stationId],
    queryFn: () => api.get<StationInfo>(`/v1/portal/chargers/${stationId ?? ''}`),
    enabled: stationId != null,
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{station.stationId}</CardTitle>
          {station.siteName != null && (
            <p className="text-sm text-muted-foreground">{station.siteName}</p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Location */}
          {station.siteAddress != null && station.siteId != null ? (
            <Link
              to={`/location/${station.siteId}?from=${encodeURIComponent(`/charge/${stationId ?? ''}`)}`}
              className="flex items-start gap-2 text-sm text-primary hover:underline transition-colors"
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

          {/* EVSE selection */}
          {station.evses.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">{t('stationDetail.selectConnector')}</p>
              <div
                className={`grid gap-3 ${station.evses.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}
              >
                {station.evses.map((evse) => {
                  const connectorStatus = evse.connectors[0]?.status ?? 'unavailable';
                  const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected'];
                  const isAvailable =
                    startableStatuses.includes(connectorStatus) && station.isOnline;

                  const connectorTypes = [
                    ...new Set(
                      evse.connectors.map((c) => c.connectorType).filter((ct) => ct != null),
                    ),
                  ].map(formatConnectorType);
                  const maxPowerKw = evse.connectors.reduce((max, c) => {
                    const kw = c.maxPowerKw ?? 0;
                    return kw > max ? kw : max;
                  }, 0);
                  const maxCurrentAmps = evse.connectors.reduce((max, c) => {
                    const amps = c.maxCurrentAmps ?? 0;
                    return amps > max ? amps : max;
                  }, 0);

                  const isCharging = ['charging', 'discharging'].includes(connectorStatus);
                  const isIdleState = ['suspended_ev', 'suspended_evse', 'idle'].includes(
                    connectorStatus,
                  );
                  return (
                    <Card
                      key={evse.evseId}
                      className={cn(
                        'transition-all',
                        isAvailable
                          ? 'hover:shadow-md cursor-pointer'
                          : 'opacity-50 cursor-not-allowed',
                        isCharging && 'ring-2 ring-success animate-pulse',
                        isIdleState && 'ring-2 ring-warning animate-pulse',
                      )}
                      onClick={() => {
                        if (isAvailable) {
                          void navigate(`/charge/${stationId ?? ''}/${String(evse.evseId)}`);
                        }
                      }}
                    >
                      <CardContent className="p-3 space-y-2">
                        <Badge
                          variant={connectorStatusVariant()}
                          className={cn('text-xs', connectorStatusClassName(connectorStatus))}
                        >
                          {t(`status.${connectorStatus}`)}
                        </Badge>
                        {connectorStatus === 'reserved' && (
                          <p className="text-xs text-muted-foreground">
                            {evse.reservationExpiresAt != null
                              ? t('charger.reservedUntil', {
                                  time: formatDate(evse.reservationExpiresAt),
                                })
                              : t('charger.reserved')}
                          </p>
                        )}
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1 text-sm font-medium">
                            <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>
                              {connectorTypes.length > 0 ? connectorTypes.join(', ') : '--'}
                            </span>
                          </div>
                          {(maxPowerKw > 0 || maxCurrentAmps > 0) && (
                            <p className="text-xs text-muted-foreground">
                              {maxPowerKw > 0 ? `${String(maxPowerKw)} kW` : ''}
                              {maxPowerKw > 0 && maxCurrentAmps > 0 ? ' / ' : ''}
                              {maxCurrentAmps > 0 ? `${String(maxCurrentAmps)}A` : ''}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {t('stationDetail.connectorPort', { id: evse.evseId })}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}

          {station.evses.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">{t('charger.notAvailable')}</p>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
