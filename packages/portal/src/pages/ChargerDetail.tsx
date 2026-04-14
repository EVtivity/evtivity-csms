// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, Mail, MapPin, Phone, Plug, Star, User, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ReportIssue } from '@/components/ReportIssue';
import { useToast } from '@/components/ui/toast';
import { PricingDisplay, isPricingFree } from '@/components/PricingDisplay';
import type { PricingInfo } from '@/components/PricingDisplay';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';
import { isCableDetected, formatConnectorType } from '@/lib/charger-utils';
import { useStationEvents } from '@/hooks/use-station-events';

interface ConnectorItem {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
  status: string;
}

interface EvseItem {
  evseId: number;
  connectors: ConnectorItem[];
  reservationExpiresAt: string | null;
}

interface StationDetail {
  stationId: string;
  siteId: string | null;
  model: string | null;
  isOnline: boolean;
  isSimulator: boolean;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  siteContactName: string | null;
  siteContactEmail: string | null;
  siteContactPhone: string | null;
  paymentEnabled: boolean;
  evses: EvseItem[];
}

interface PaymentMethod {
  id: number;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
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

export function ChargerDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId } = useParams<{ stationId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  useStationEvents(stationId);

  const evseParam = searchParams.get('evse');
  const [selectedEvseId, setSelectedEvseId] = useState<number | null>(
    evseParam != null ? Number(evseParam) : null,
  );
  const [selectedPm, setSelectedPm] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [showEvWarning, setShowEvWarning] = useState(false);

  const {
    data: station,
    isLoading,
    error: loadError,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['station-detail', stationId],
    queryFn: () => api.get<StationDetail>(`/v1/portal/chargers/${stationId ?? ''}`),
    enabled: stationId != null,
  });

  // Clear stale errors when station data refreshes (e.g., via SSE)
  useEffect(() => {
    if (dataUpdatedAt > 0) setError('');
  }, [dataUpdatedAt]);

  const { data: pricing } = useQuery({
    queryKey: ['charger-pricing', stationId],
    queryFn: () => api.get<PricingInfo>(`/v1/portal/chargers/${stationId ?? ''}/pricing`),
    enabled: stationId != null && isAuthenticated,
    retry: false,
  });

  const { data: paymentMethods } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethod[]>('/v1/portal/payment-methods'),
    enabled: station?.paymentEnabled === true,
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: favoriteData } = useQuery({
    queryKey: ['favorite-check', stationId],
    queryFn: () =>
      api.get<{ isFavorite: boolean; favoriteId: number | null }>(
        `/v1/portal/favorites/check/${stationId ?? ''}`,
      ),
    enabled: stationId != null && isAuthenticated,
  });

  const { data: activeSessions } = useQuery({
    queryKey: ['portal-active-sessions'],
    queryFn: () =>
      api.get<{ data: { id: string; stationId: string }[] }>('/v1/portal/chargers/sessions/active'),
    enabled: isAuthenticated,
  });

  const hasActiveSession =
    activeSessions != null &&
    activeSessions.data.length > 0 &&
    activeSessions.data.every((s) => s.stationId !== stationId);

  const addFavoriteMutation = useMutation({
    mutationFn: () => api.post('/v1/portal/favorites', { stationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['favorite-check', stationId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-favorites'] });
      toast({ variant: 'success', title: t('favorites.added') });
    },
  });

  const removeFavoriteMutation = useMutation({
    mutationFn: (favoriteId: number) => api.delete(`/v1/portal/favorites/${String(favoriteId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['favorite-check', stationId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-favorites'] });
      toast({ variant: 'success', title: t('favorites.removed') });
    },
  });

  const [showRemoveFavorite, setShowRemoveFavorite] = useState(false);

  // Auto-select default payment method
  if (selectedPm == null && paymentMethods != null) {
    const defaultPm = paymentMethods.find((pm) => pm.isDefault);
    if (defaultPm != null) {
      setSelectedPm(defaultPm.id);
    } else if (paymentMethods.length > 0 && paymentMethods[0] != null) {
      setSelectedPm(paymentMethods[0].id);
    }
  }

  const isFree = pricing != null && isPricingFree(pricing);

  async function doStart(): Promise<void> {
    if (selectedEvseId == null) return;
    setIsStarting(true);
    setError('');
    try {
      const result = await api.post<{ chargingSessionId: string }>(
        `/v1/portal/chargers/${stationId ?? ''}/evse/${String(selectedEvseId)}/start`,
        selectedPm != null ? { paymentMethodId: selectedPm } : {},
      );
      void navigate(`/sessions/${result.chargingSessionId}`, {
        replace: true,
        state: { fromCharge: true },
      });
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('stationDetail.failedToStart'));
      } else {
        setError(t('stationDetail.failedToStart'));
      }
    } finally {
      setIsStarting(false);
    }
  }

  async function handleStart(): Promise<void> {
    if (selectedEvseId == null) return;
    setError('');
    setIsCheckingStatus(true);

    try {
      const result = await api.post<{ connectorStatus: string | null; error?: string }>(
        `/v1/portal/chargers/${stationId ?? ''}/evse/${String(selectedEvseId)}/check-status`,
        {},
      );
      setIsCheckingStatus(false);

      if (result.error != null) {
        setError(result.error);
        return;
      }

      if (!isCableDetected(result.connectorStatus)) {
        setShowEvWarning(true);
        return;
      }

      await doStart();
    } catch {
      setIsCheckingStatus(false);
      setError(t('charger.statusCheckFailed'));
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">{t('charger.loadingInfo')}</p>
      </div>
    );
  }

  if (loadError != null || station == null) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          className="gap-1 px-0"
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>
        <p className="text-destructive">{t('charger.notFound')}</p>
      </div>
    );
  }

  const showPaymentSection =
    selectedEvseId != null &&
    station.paymentEnabled &&
    !isFree &&
    isAuthenticated &&
    !hasActiveSession;
  const showStartButton =
    selectedEvseId != null &&
    (isFree || !station.paymentEnabled || selectedPm != null) &&
    !hasActiveSession;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="gap-1 px-0"
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-xl font-bold">{station.stationId}</h1>
            {favoriteData?.isFavorite === true && (
              <Star className="h-4 w-4 shrink-0 text-warning" fill="currentColor" />
            )}
          </div>
          {station.siteName != null && (
            <p className="text-xs text-muted-foreground">{station.siteName}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              station.isOnline ? 'bg-success' : 'bg-destructive',
            )}
          />
          <span className="text-xs font-medium">
            {station.isOnline ? t('charger.online') : t('charger.offline')}
          </span>
        </div>
      </div>

      {/* Location */}
      {station.siteAddress != null && station.siteId != null ? (
        <Link
          to={`/location/${station.siteId}?from=${encodeURIComponent(`/start/${station.stationId}`)}`}
          className="flex items-start gap-2 text-sm text-primary hover:underline transition-colors"
        >
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {station.siteAddress}
            {station.siteCity != null && `, ${station.siteCity}`}
            {station.siteState != null && `, ${station.siteState}`}
          </span>
        </Link>
      ) : station.siteAddress != null ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {station.siteAddress}
            {station.siteCity != null && `, ${station.siteCity}`}
            {station.siteState != null && `, ${station.siteState}`}
          </span>
        </div>
      ) : null}

      {/* Site Contact */}
      {(station.siteContactName != null ||
        station.siteContactEmail != null ||
        station.siteContactPhone != null) && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">{t('charger.siteContact')}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-1.5">
            {station.siteContactName != null && (
              <div className="flex items-center gap-2 text-sm">
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span>{station.siteContactName}</span>
              </div>
            )}
            {station.siteContactEmail != null && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a
                  href={`mailto:${station.siteContactEmail}`}
                  className="text-primary hover:underline"
                >
                  {station.siteContactEmail}
                </a>
              </div>
            )}
            {station.siteContactPhone != null && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <a
                  href={`tel:${station.siteContactPhone}`}
                  className="text-primary hover:underline"
                >
                  {station.siteContactPhone}
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pricing */}
      {pricing != null && <PricingDisplay pricing={pricing} />}

      {/* EVSE selection instruction */}
      {station.evses.length > 0 && !hasActiveSession && (
        <p className="text-sm text-muted-foreground">{t('stationDetail.selectConnector')}</p>
      )}

      {/* Active session overlay */}
      {hasActiveSession && (
        <div className="rounded-lg border bg-card p-6 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-8 w-8 text-warning" />
          <p className="text-sm font-medium">{t('stationDetail.activeSessionWarning')}</p>
        </div>
      )}

      {/* EVSE grid — one tile per EVSE */}
      {station.evses.length > 0 && !hasActiveSession && (
        <div className={`grid gap-3 ${station.evses.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {station.evses.map((evse) => {
            const connectorStatus = evse.connectors[0]?.status ?? 'unavailable';
            const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected'];
            const isAvailable = startableStatuses.includes(connectorStatus) && station.isOnline;
            const isSelected = selectedEvseId === evse.evseId;

            const connectorTypes = [
              ...new Set(evse.connectors.map((c) => c.connectorType).filter((t) => t != null)),
            ].map(formatConnectorType);
            const maxPowerKw = evse.connectors.reduce((max, c) => {
              const kw = c.maxPowerKw != null ? Number(c.maxPowerKw) : 0;
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
                    ? isSelected
                      ? 'border-primary bg-primary/5 shadow-md cursor-pointer'
                      : 'hover:shadow-md cursor-pointer'
                    : 'opacity-50 cursor-not-allowed',
                  isCharging && 'ring-2 ring-success animate-pulse',
                  isIdleState && 'ring-2 ring-warning animate-pulse',
                )}
                onClick={() => {
                  if (isAvailable) {
                    setSelectedEvseId(isSelected ? null : evse.evseId);
                    setError('');
                  }
                }}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Badge
                      variant={connectorStatusVariant()}
                      className={cn('text-xs', connectorStatusClassName(connectorStatus))}
                    >
                      {t(`status.${connectorStatus}`)}
                    </Badge>
                    {isSelected && <Zap className="h-4 w-4 text-primary" />}
                  </div>
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
                      <span>{connectorTypes.length > 0 ? connectorTypes.join(', ') : '--'}</span>
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
      )}

      {/* Payment method selection */}
      {showPaymentSection && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">{t('stationDetail.paymentMethod')}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            {paymentMethods == null || paymentMethods.length === 0 ? (
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('stationDetail.addPaymentPrompt')}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigate('/payment-methods');
                  }}
                >
                  {t('stationDetail.addPaymentMethod')}
                </Button>
              </div>
            ) : (
              paymentMethods.map((pm) => (
                <div
                  key={pm.id}
                  className={`flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                    selectedPm === pm.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  }`}
                  onClick={() => {
                    setSelectedPm(pm.id);
                  }}
                >
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {t('payments.cardEnding', {
                      brand: pm.cardBrand ?? 'Card',
                      last4: pm.cardLast4 ?? '****',
                    })}
                  </span>
                  {pm.isDefault && <Badge variant="secondary">{t('common.default')}</Badge>}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Start button */}
      {showStartButton && (
        <div className="space-y-2">
          {error !== '' && <p className="text-sm text-destructive">{error}</p>}
          <Button
            className="w-full gap-2"
            size="lg"
            disabled={isStarting || isCheckingStatus}
            onClick={() => void handleStart()}
          >
            <Zap className="h-5 w-5" />
            {isCheckingStatus
              ? t('charger.checkingStatus')
              : isStarting
                ? t('stationDetail.starting')
                : t('stationDetail.startCharging')}
          </Button>
        </div>
      )}

      {/* Favorites */}
      {isAuthenticated &&
        (favoriteData?.isFavorite === true ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={removeFavoriteMutation.isPending}
            onClick={() => {
              setShowRemoveFavorite(true);
            }}
          >
            {t('favorites.removeFromFavorites')}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            disabled={addFavoriteMutation.isPending}
            onClick={() => {
              addFavoriteMutation.mutate();
            }}
          >
            {t('favorites.addToFavorites')}
          </Button>
        ))}

      {/* Report Issue */}
      <ReportIssue stationName={station.stationId} />

      {/* EV not detected warning */}
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={station.isSimulator ? t('charger.startForSimulation') : t('common.ok')}
        hideCancel={!station.isSimulator}
        onConfirm={() => {
          if (!station.isSimulator) return;
          void doStart();
        }}
      >
        <EvPlugAnimation />
      </ConfirmDialog>
      <ConfirmDialog
        open={showRemoveFavorite}
        onOpenChange={setShowRemoveFavorite}
        title={t('favorites.confirmRemoveTitle')}
        description={t('favorites.confirmRemoveDescription')}
        confirmLabel={t('favorites.removeFromFavorites')}
        variant="destructive"
        onConfirm={() => {
          if (favoriteData?.favoriteId != null) {
            removeFavoriteMutation.mutate(favoriteData.favoriteId);
          }
        }}
      />
    </div>
  );
}
